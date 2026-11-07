// Tests for scripts/cloudflare-setup.mjs. Cloudflare is never contacted: `fetch` is always replaced
// by a fake that behaves like a small account, and every credential below is a made-up string that
// the tests look for in the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  API_BASE,
  CloudflareError,
  DESIRED,
  applyPlan,
  createApi,
  isAlreadyExists,
  main,
  planSetup,
  scrub,
} from '../cloudflare-setup.mjs';

const TOKEN = 'cf_FAKE_TOKEN_for_tests_0123456789';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const SCRIPT = fileURLToPath(new URL('../cloudflare-setup.mjs', import.meta.url));

/**
 * A fake Cloudflare account. It answers like the real API for the endpoints the script uses and
 * records every call.
 *
 * @param {object} [state]
 * @param {string[]} [state.projects]
 * @param {Record<string, string[]>} [state.domains]
 * @param {string[]} [state.buckets]
 * @param {{ method: string, path: string, status: number, body: unknown }[]} [state.failures] Calls that fail, matched by method and path.
 * @param {number} [state.pageSize] How many projects one page of the listing holds.
 */
function fakeCloudflare({ projects = [], domains = {}, buckets = [], failures = [], pageSize = 100 } = {}) {
  const account = { projects: [...projects], domains: structuredClone(domains), buckets: [...buckets] };
  /** @type {{ method: string, path: string, body: any, authorization: string | null }[]} */
  const calls = [];

  /**
   * @param {unknown} result
   * @param {object} [extra]
   */
  const ok = (result, extra = {}) => json(200, { success: true, errors: [], messages: [], result, ...extra });
  /**
   * @param {number} status
   * @param {unknown} body
   */
  function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }
  /**
   * @param {number} status
   * @param {number} code
   * @param {string} message
   */
  const fail = (status, code, message) => json(status, { success: false, errors: [{ code, message }], messages: [], result: null });

  /** @type {typeof fetch} */
  const fetchFake = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/client\/v4/, '');
    assert.equal(`${url.origin}/client/v4`, API_BASE);
    const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, authorization: headers.Authorization ?? null });

    const forced = failures.find((entry) => entry.method === method && entry.path === path);
    if (forced !== undefined) return json(forced.status, forced.body);

    const prefix = `/accounts/${ACCOUNT}`;
    if (!path.startsWith(`${prefix}/`)) return fail(404, 7003, 'No route for the URI');
    const rest = path.slice(prefix.length);

    if (rest === '/pages/projects' && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const slice = account.projects.slice((page - 1) * pageSize, page * pageSize);
      return ok(
        slice.map((name) => ({ name })),
        { result_info: { page, per_page: pageSize, total_pages: Math.max(1, Math.ceil(account.projects.length / pageSize)) } },
      );
    }
    if (rest === '/pages/projects' && method === 'POST') {
      if (account.projects.includes(body.name)) return fail(400, 8000002, 'A project with this name already exists. Choose a different project name.');
      account.projects.push(body.name);
      return ok({ name: body.name, production_branch: body.production_branch });
    }
    const domainRoute = /^\/pages\/projects\/([^/]+)\/domains$/.exec(rest);
    if (domainRoute !== null) {
      const project = decodeURIComponent(domainRoute[1] ?? '');
      if (!account.projects.includes(project)) return fail(404, 8000007, 'Project not found. The specified project name does not match any of your existing projects.');
      const list = (account.domains[project] ??= []);
      if (method === 'GET') return ok(list.map((name) => ({ name, status: 'active' })));
      if (list.includes(body.name)) return fail(400, 8000018, 'The domain was already added to this project.');
      list.push(body.name);
      return ok({ name: body.name, status: 'pending' });
    }
    if (rest === '/r2/buckets' && method === 'GET') return ok({ buckets: account.buckets.map((name) => ({ name })) });
    if (rest === '/r2/buckets' && method === 'POST') {
      if (account.buckets.includes(body.name)) return fail(409, 10004, 'The bucket you tried to create already exists, and you own it.');
      account.buckets.push(body.name);
      return ok({ name: body.name });
    }
    return fail(404, 7003, `No route for ${method} ${rest}`);
  };

  return { fetch: fetchFake, calls, account, writes: () => calls.filter((call) => call.method !== 'GET') };
}

/**
 * Runs main() with captured output.
 *
 * @param {string[]} args
 * @param {Parameters<typeof main>[1]} services
 */
async function run(args, services) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { out: (text) => (stdout += text), err: (text) => (stderr += text), ...services });
  return { code, stdout, stderr };
}

/** Credentials as the lookup returns them. */
const withCredentials = async () => ({ values: new Map([['CLOUDFLARE_API_TOKEN', TOKEN], ['CLOUDFLARE_ACCOUNT_ID', ACCOUNT]]), missing: [] });

/** No credentials at all. */
const withoutCredentials = async () => ({ values: new Map(), missing: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] });

/**
 * A fetch whose listings are empty until the first write call, as if the look-up had missed items that
 * are there; after a write it answers truthfully.
 *
 * @param {ReturnType<typeof fakeCloudflare>} cloud
 * @returns {typeof fetch}
 */
function blindLookUp(cloud) {
  let written = false;
  return async (input, init) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') written = true;
    if (method === 'GET' && !written) {
      const url = new URL(String(input));
      return new Response(JSON.stringify({ success: true, errors: [], result: url.pathname.endsWith('/r2/buckets') ? { buckets: [] } : [] }), { status: 200 });
    }
    return cloud.fetch(input, init);
  };
}

/** A fetch that must never be called. */
const noNetwork = /** @type {typeof fetch} */ (async () => {
  assert.fail('the network must not be used');
});

test('planSetup: with nothing existing everything is created, projects first, the bucket last', () => {
  const plan = planSetup(DESIRED, { projects: [], domains: {}, buckets: [] });
  assert.deepEqual(
    plan.map(({ kind, name, project, state }) => [kind, name, project, state]),
    [
      ['pages-project', 'ba3a-dev', undefined, 'create'],
      ['pages-project', 'my-ba3a-dev', undefined, 'create'],
      ['pages-domain', 'ba3a.dev', 'ba3a-dev', 'create'],
      ['pages-domain', 'my.ba3a.dev', 'my-ba3a-dev', 'create'],
      ['r2-bucket', 'ba3a-media', undefined, 'create'],
    ],
  );
});

test('planSetup: what exists is not planned for creation, and each part is judged on its own', () => {
  const plan = planSetup(DESIRED, { projects: ['ba3a-dev', 'other'], domains: { 'ba3a-dev': ['BA3A.dev'] }, buckets: ['ba3a-media'] });
  assert.deepEqual(
    plan.map(({ name, state }) => [name, state]),
    [
      ['ba3a-dev', 'exists'],
      ['my-ba3a-dev', 'create'],
      ['ba3a.dev', 'exists'],
      ['my.ba3a.dev', 'create'],
      ['ba3a-media', 'exists'],
    ],
  );
  assert.ok(planSetup(DESIRED, { projects: ['ba3a-dev', 'my-ba3a-dev'], domains: { 'ba3a-dev': ['ba3a.dev'], 'my-ba3a-dev': ['my.ba3a.dev'] }, buckets: ['ba3a-media'] }).every((action) => action.state === 'exists'));
});

test('planSetup: without a look-up every state is unknown', () => {
  assert.ok(planSetup(DESIRED, null).every((action) => action.state === 'unknown'));
});

test('isAlreadyExists: known codes, conflicts and wording count; other failures do not', () => {
  assert.equal(isAlreadyExists(new CloudflareError('x', { codes: [8000002] })), true);
  assert.equal(isAlreadyExists(new CloudflareError('x', { codes: [10004], status: 409 })), true);
  assert.equal(isAlreadyExists(new CloudflareError('x', { status: 409 })), true);
  assert.equal(isAlreadyExists(new CloudflareError('the domain is already added')), true);
  assert.equal(isAlreadyExists(new CloudflareError('forbidden', { status: 403, codes: [10000] })), false);
  assert.equal(isAlreadyExists(new CloudflareError('the domain is already in use by another project', { codes: [8000099] })), false);
  assert.equal(isAlreadyExists(new Error('already exists')), false);
});

test('scrub removes secrets and control characters', () => {
  assert.equal(scrub(`bad ${TOKEN}\nnext`, [TOKEN]), 'bad *** next');
});

test('--dry-run without credentials prints the whole plan and makes no network call', async () => {
  const { code, stdout, stderr } = await run(['--dry-run'], { fetch: noNetwork, readVariables: withoutCredentials });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /plan only; existing resources not checked/);
  for (const name of ['ba3a-dev', 'my-ba3a-dev', 'ba3a.dev', 'my.ba3a.dev', 'ba3a-media']) assert.ok(stdout.includes(name), name);
  assert.match(stdout, /Pages project\s+ba3a-dev/);
  assert.match(stdout, /Pages domain\s+my\.ba3a\.dev\s+on my-ba3a-dev/);
  assert.match(stdout, /R2 bucket\s+ba3a-media\s+\(private\)/);
  assert.match(stdout, /Cloudflare Pages > Edit/);
  assert.match(stdout, /Workers R2 Storage > Edit/);
  assert.match(stdout, /DNS > Edit/);
  assert.match(stdout, /OPERATIONS\.md/);
  assert.doesNotMatch(stdout, /final step|written in the/i, 'OPERATIONS.md exists; the script does not promise it for later');
  assert.match(stdout, /proxied CNAME record/, 'the DNS record to check is described');
  assert.match(stdout, /pages\.dev/);
  assert.doesNotMatch(stdout, /created by Pages|Pages adds the DNS/, 'no promise that Pages creates the DNS records');
});

test('--dry-run with credentials only reads, and says what it would create', async () => {
  const cloud = fakeCloudflare({ projects: ['ba3a-dev'] });
  const { code, stdout, stderr } = await run(['--dry-run'], { fetch: cloud.fetch, readVariables: withCredentials });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.deepEqual(cloud.writes(), []);
  assert.ok(cloud.calls.length > 0);
  assert.ok(cloud.calls.every((call) => call.authorization === `Bearer ${TOKEN}`));
  assert.match(stdout, /already exists: Pages project\s+ba3a-dev/);
  assert.match(stdout, /would create: Pages project\s+my-ba3a-dev/);
  assert.match(stdout, /would create: Pages domain\s+ba3a\.dev/);
  assert.match(stdout, /would create: R2 bucket\s+ba3a-media/);
  assert.ok(!stdout.includes(TOKEN) && !stdout.includes(ACCOUNT), 'neither the token nor the full account id is printed');
});

test('a real run creates everything, as private direct-upload projects with the production branch main', async () => {
  const cloud = fakeCloudflare();
  const { code, stdout, stderr } = await run([], { fetch: cloud.fetch, readVariables: withCredentials });
  assert.equal(code, 0, stderr);
  assert.deepEqual(cloud.account.projects, ['ba3a-dev', 'my-ba3a-dev']);
  assert.deepEqual(cloud.account.domains, { 'ba3a-dev': ['ba3a.dev'], 'my-ba3a-dev': ['my.ba3a.dev'] });
  assert.deepEqual(cloud.account.buckets, ['ba3a-media']);
  const projectBodies = cloud.writes().filter((call) => call.path.endsWith('/pages/projects')).map((call) => call.body);
  assert.deepEqual(projectBodies, [
    { name: 'ba3a-dev', production_branch: 'main' },
    { name: 'my-ba3a-dev', production_branch: 'main' },
  ]);
  const bucketBodies = cloud.writes().filter((call) => call.path.endsWith('/r2/buckets')).map((call) => call.body);
  assert.deepEqual(bucketBodies, [{ name: 'ba3a-media' }], 'no public access is requested');
  assert.match(stdout, /Created 5 item/);
  assert.match(stdout, /pending/, 'the domain status is reported');
  assert.match(stdout, /few minutes/);
  assert.ok(!stdout.includes(TOKEN));
});

test('running twice changes nothing the second time', async () => {
  const cloud = fakeCloudflare();
  assert.equal((await run([], { fetch: cloud.fetch, readVariables: withCredentials })).code, 0);
  const before = structuredClone(cloud.account);
  const writesBefore = cloud.writes().length;

  const second = await run([], { fetch: cloud.fetch, readVariables: withCredentials });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(cloud.writes().length, writesBefore, 'the second run sends no write call');
  assert.deepEqual(cloud.account, before);
  assert.match(second.stdout, /Nothing to do/);
});

test('a creation refused with "already exists" counts as success', async () => {
  // The look-up misses the items (the listings are empty) but the account has them: a race. The
  // listings read again after the refusal show the truth.
  const cloud = fakeCloudflare({ projects: ['ba3a-dev', 'my-ba3a-dev'], domains: { 'ba3a-dev': ['ba3a.dev'], 'my-ba3a-dev': ['my.ba3a.dev'] }, buckets: ['ba3a-media'] });
  const blind = blindLookUp(cloud);
  const { code, stdout, stderr } = await run([], { fetch: blind, readVariables: withCredentials });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Nothing to do/);
  assert.equal(cloud.account.projects.length, 2);
});

test('a domain that is already in use by another project is a failure, not "already exists"', async () => {
  // The domain is held by a different Pages project; the API refuses the attachment with a message that
  // says "in use", and the project's own domain list does not contain it.
  const cloud = fakeCloudflare({
    projects: ['ba3a-dev', 'my-ba3a-dev', 'other-site'],
    domains: { 'other-site': ['ba3a.dev'] },
    buckets: ['ba3a-media'],
    failures: [
      {
        method: 'POST',
        path: `/accounts/${ACCOUNT}/pages/projects/ba3a-dev/domains`,
        status: 400,
        body: { success: false, errors: [{ code: 8000099, message: 'The domain is already in use by another project.' }] },
      },
    ],
  });
  const { code, stdout, stderr } = await run([], { fetch: cloud.fetch, readVariables: withCredentials });
  assert.equal(code, 1);
  assert.match(stderr, /failed: Pages domain\s+ba3a\.dev\s+on ba3a-dev/);
  assert.match(stderr, /already in use by another project/);
  assert.match(stderr, /run the script again/);
  assert.doesNotMatch(stdout, /already exists: Pages domain\s+ba3a\.dev/);
  assert.doesNotMatch(stdout, /Nothing to do/);
  assert.deepEqual(cloud.account.domains['ba3a-dev'] ?? [], [], 'the domain is not attached to ba3a-dev');
  assert.deepEqual(cloud.account.domains['my-ba3a-dev'], ['my.ba3a.dev'], 'the other domain is still handled');
});

test('an "already exists" answer for an item the listing does not show is a failure', async () => {
  // HTTP 409 on the bucket creation, but the bucket is not in the account (for example it belongs to
  // someone else): trusting the 409 would hide that.
  const cloud = fakeCloudflare({
    projects: ['ba3a-dev', 'my-ba3a-dev'],
    domains: { 'ba3a-dev': ['ba3a.dev'], 'my-ba3a-dev': ['my.ba3a.dev'] },
    failures: [
      {
        method: 'POST',
        path: `/accounts/${ACCOUNT}/r2/buckets`,
        status: 409,
        body: { success: false, errors: [{ code: 10004, message: 'The bucket you tried to create already exists.' }] },
      },
    ],
  });
  const { code, stdout, stderr } = await run([], { fetch: cloud.fetch, readVariables: withCredentials });
  assert.equal(code, 1);
  assert.match(stderr, /failed: R2 bucket\s+ba3a-media/);
  assert.match(stderr, /not in the list of R2 buckets/);
  assert.doesNotMatch(stdout, /Nothing to do/);
});

test('a failing creation exits with 1, skips the domain of that project, and never shows the token', async () => {
  const cloud = fakeCloudflare({
    failures: [
      {
        method: 'POST',
        path: `/accounts/${ACCOUNT}/pages/projects`,
        status: 403,
        body: { success: false, errors: [{ code: 10000, message: `Authentication error for ${TOKEN}` }], result: null },
      },
    ],
  });
  const { code, stdout, stderr } = await run([], { fetch: cloud.fetch, readVariables: withCredentials });
  assert.equal(code, 1);
  assert.match(stderr, /failed: Pages project\s+ba3a-dev/);
  assert.match(stderr, /10000: Authentication error/);
  assert.match(stdout + stderr, /skipped: Pages domain\s+ba3a\.dev/);
  assert.ok(!(stdout + stderr).includes(TOKEN), 'the token never appears');
  assert.ok(!(stdout + stderr).includes(ACCOUNT), 'the full account id never appears, also not in failure messages');
  assert.match(stderr, /POST \/accounts\/0123\.\.\.cdef\/pages\/projects failed/, 'the account id is masked like in the normal output');
  assert.ok(cloud.writes().every((call) => !call.path.endsWith('/domains')), 'no domain is attached to a missing project');
  assert.deepEqual(cloud.account.buckets, ['ba3a-media'], 'the other items are still handled');
});

test('an unreadable account stops the run with 1 and a clean message', async () => {
  const cloud = fakeCloudflare({
    failures: [{ method: 'GET', path: `/accounts/${ACCOUNT}/pages/projects`, status: 401, body: { success: false, errors: [{ code: 10001, message: 'Unable to authenticate request' }] } }],
  });
  const { code, stderr } = await run(['--dry-run'], { fetch: cloud.fetch, readVariables: withCredentials });
  assert.equal(code, 1);
  assert.match(stderr, /cannot read the account.*10001: Unable to authenticate request/);
  assert.ok(!stderr.includes(TOKEN));
  assert.ok(!stderr.includes(ACCOUNT), 'the full account id is not in the message');
});

test('a network error is reported without the token', async () => {
  const broken = /** @type {typeof fetch} */ (async () => {
    throw new Error(`connect failed (Bearer ${TOKEN})`);
  });
  const { code, stderr } = await run(['--dry-run'], { fetch: broken, readVariables: withCredentials });
  assert.equal(code, 1);
  assert.match(stderr, /could not be sent/);
  assert.ok(!stderr.includes(TOKEN));
});

test('an answer that is not JSON is an error, not a crash', async () => {
  const html = /** @type {typeof fetch} */ (async () => new Response('<html>Bad gateway</html>', { status: 502 }));
  const { code, stderr } = await run(['--dry-run'], { fetch: html, readVariables: withCredentials });
  assert.equal(code, 1);
  assert.match(stderr, /HTTP 502/);
});

test('listings are read page by page', async () => {
  const names = Array.from({ length: 7 }, (_, index) => `project-${index}`);
  const cloud = fakeCloudflare({ projects: [...names, 'my-ba3a-dev'], pageSize: 3 });
  const api = createApi({ token: TOKEN, accountId: ACCOUNT, fetch: cloud.fetch });
  const listed = await api.listPagesProjects();
  assert.deepEqual(listed.sort(), [...names, 'my-ba3a-dev'].sort());
  assert.equal(cloud.calls.filter((call) => call.path.endsWith('/pages/projects')).length, 3);
});

test('a listing that ignores the page number does not loop forever', async () => {
  let calls = 0;
  const stubborn = /** @type {typeof fetch} */ (async () => {
    calls += 1;
    return new Response(JSON.stringify({ success: true, result: [{ name: 'only' }] }), { status: 200 });
  });
  const api = createApi({ token: TOKEN, accountId: ACCOUNT, fetch: stubborn });
  assert.deepEqual(await api.listPagesProjects(), ['only']);
  assert.equal(calls, 2);
});

test('R2 buckets are read by cursor', async () => {
  const pages = [
    { result: { buckets: [{ name: 'a' }] }, result_info: { cursor: 'c1' } },
    { result: { buckets: [{ name: 'b' }] }, result_info: {} },
  ];
  /** @type {string[]} */
  const cursors = [];
  const paged = /** @type {typeof fetch} */ (async (input) => {
    cursors.push(new URL(String(input)).searchParams.get('cursor') ?? '');
    return new Response(JSON.stringify({ success: true, ...pages[cursors.length - 1] }), { status: 200 });
  });
  const api = createApi({ token: TOKEN, accountId: ACCOUNT, fetch: paged });
  assert.deepEqual(await api.listBuckets(), ['a', 'b']);
  assert.deepEqual(cursors, ['', 'c1']);
});

test('applyPlan creates only what is marked create', async () => {
  const cloud = fakeCloudflare({ projects: ['ba3a-dev'] });
  const api = createApi({ token: TOKEN, accountId: ACCOUNT, fetch: cloud.fetch });
  const plan = planSetup(DESIRED, { projects: ['ba3a-dev'], domains: {}, buckets: [] });
  const outcomes = await applyPlan(api, plan);
  assert.deepEqual(
    outcomes.map(({ action, result }) => [action.name, result]),
    [
      ['ba3a-dev', 'already exists'],
      ['my-ba3a-dev', 'created'],
      ['ba3a.dev', 'created'],
      ['my.ba3a.dev', 'created'],
      ['ba3a-media', 'created'],
    ],
  );
});

test('usage errors exit with 2 and make no call', async () => {
  const unknown = await run(['--wet-run'], { fetch: noNetwork, readVariables: withCredentials });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown argument "--wet-run"/);
  const missing = await run(['--env-dir'], { fetch: noNetwork, readVariables: withCredentials });
  assert.equal(missing.code, 2);
  const help = await run(['--help'], { fetch: noNetwork, readVariables: withCredentials });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
});

test('a real run without credentials fails with 1 and says where to set them', async () => {
  const { code, stderr } = await run([], { fetch: noNetwork, readVariables: withoutCredentials });
  assert.equal(code, 1);
  assert.match(stderr, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set/);
  assert.match(stderr, /\.env\.local/);
});

test('an invalid account id is a usage error and is not put into a URL', async () => {
  const bad = async () => ({ values: new Map([['CLOUDFLARE_API_TOKEN', TOKEN], ['CLOUDFLARE_ACCOUNT_ID', '../../x']]), missing: [] });
  const { code, stderr } = await run(['--dry-run'], { fetch: noNetwork, readVariables: bad });
  assert.equal(code, 2);
  assert.ok(!stderr.includes(TOKEN));
});

test('the command line: --dry-run works without credentials (an empty environment and an empty directory)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'cloudflare-setup-'));
  try {
    // No credentials in the environment and no .env.local in the directory, so no network call is made.
    const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };
    const result = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--env-dir', empty], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /plan only; existing resources not checked/);
    for (const name of ['ba3a-dev', 'my-ba3a-dev', 'ba3a.dev', 'my.ba3a.dev', 'ba3a-media']) assert.ok(result.stdout.includes(name), name);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
