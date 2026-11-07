// Tests for scripts/keepalive.mjs. The `gh` command is always replaced by a fake that records the
// calls it gets: GitHub is never contacted, and no real token is used (the token below is a made-up
// string that the tests look for in the output).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, STALE_DAYS, createApi, keepAlive, main, scrub, shouldEnable } from '../keepalive.mjs';

const REPOSITORY = 'octo-org/ba3adev';
const TOKEN = 'ghs_FAKE_TOKEN_for_tests_0123456789';

/** A day that is not the 1st of the month. */
const MID_MONTH = new Date('2026-06-15T12:00:00Z');
const FIRST = new Date('2026-06-01T03:17:00Z');

/**
 * @param {Date} now
 * @param {number} days
 * @returns {string}
 */
function daysAgo(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * A fake `gh`. `workflows` maps a file name to the object the API returns, or to a failure.
 *
 * @param {Record<string, { state?: string, updated_at?: string } | { fail: string } | { garbage: string }>} workflows
 * @param {{ enableFails?: string }} [options]
 */
function fakeGh(workflows, { enableFails } = {}) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../keepalive.mjs').GhRunner} */
  const run = async (args) => {
    calls.push(args);
    const put = args.includes('PUT');
    const match = /^repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+?)(\/enable)?$/.exec(args.at(-1) ?? '');
    assert.equal(args[0], 'api');
    assert.ok(match, `a known endpoint: ${args.at(-1)}`);
    assert.equal(match[1], REPOSITORY);
    assert.equal(put, match[3] === '/enable', 'PUT is used for /enable and for nothing else');
    const known = workflows[match[2]];
    if (known === undefined) return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)\n' };
    if (put) {
      if (enableFails) return { status: 1, stdout: '', stderr: `${enableFails}\n` };
      return { status: 0, stdout: '', stderr: '' };
    }
    if ('fail' in known) return { status: 1, stdout: '', stderr: `${known.fail}\n` };
    if ('garbage' in known) return { status: 0, stdout: known.garbage, stderr: '' };
    return { status: 0, stdout: JSON.stringify({ id: 1, name: 'x', ...known }), stderr: '' };
  };
  return { run, calls, puts: () => calls.filter((args) => args.includes('PUT')).map((args) => args.at(-1)) };
}

test('the threshold is 30 days', () => {
  assert.equal(STALE_DAYS, 30);
});

test('a workflow updated less than 30 days ago is left alone on an ordinary day', () => {
  for (const days of [0, 1, 15, 29, 30]) {
    const decision = shouldEnable({ workflow: { state: 'active', updated_at: daysAgo(MID_MONTH, days) }, now: MID_MONTH });
    assert.equal(decision.enable, false, `${days} days`);
  }
});

test('a workflow updated more than 30 days ago is enabled', () => {
  for (const days of [31, 45, 59, 400]) {
    const decision = shouldEnable({ workflow: { state: 'active', updated_at: daysAgo(MID_MONTH, days) }, now: MID_MONTH });
    assert.equal(decision.enable, true, `${days} days`);
    assert.match(decision.reason, new RegExp(`${days} days ago`));
  }
});

test('a missing or unreadable date counts as old', () => {
  for (const updated_at of [undefined, '', 'yesterday']) {
    assert.equal(shouldEnable({ workflow: { state: 'active', updated_at }, now: MID_MONTH }).enable, true);
  }
});

test('a date in the future (a clock that is off) is not old', () => {
  assert.equal(shouldEnable({ workflow: { state: 'active', updated_at: daysAgo(MID_MONTH, -3) }, now: MID_MONTH }).enable, false);
});

test('on the 1st of the month it always enables, even a workflow updated a minute ago', () => {
  const decision = shouldEnable({ workflow: { state: 'active', updated_at: daysAgo(FIRST, 0) }, now: FIRST });
  assert.deepEqual(decision, { enable: true, reason: 'it is the 1st of the month' });
});

test('the day of the month is the UTC day', () => {
  // 2026-06-01T23:30 UTC is already the 2nd in Berlin and still the 1st in New York; UTC decides.
  assert.equal(shouldEnable({ workflow: { state: 'active', updated_at: daysAgo(FIRST, 1) }, now: new Date('2026-06-01T23:30:00Z') }).enable, true);
  assert.equal(shouldEnable({ workflow: { state: 'active', updated_at: daysAgo(FIRST, 1) }, now: new Date('2026-06-02T00:30:00Z') }).enable, false);
  assert.equal(shouldEnable({ workflow: { state: 'active', updated_at: daysAgo(FIRST, 1) }, now: new Date('2026-05-31T23:59:59Z') }).enable, false);
});

test('--always enables a recent workflow too', () => {
  assert.equal(shouldEnable({ workflow: { state: 'active', updated_at: daysAgo(MID_MONTH, 1) }, now: MID_MONTH, always: true }).enable, true);
});

test('a workflow that GitHub disabled for inactivity is enabled; one disabled by hand is not', () => {
  const recent = daysAgo(MID_MONTH, 1);
  assert.equal(shouldEnable({ workflow: { state: 'disabled_inactivity', updated_at: recent }, now: MID_MONTH }).enable, true);
  for (const state of ['disabled_manually', 'disabled_fork']) {
    // Not even on the 1st of the month, and not with --always.
    assert.equal(shouldEnable({ workflow: { state, updated_at: recent }, now: FIRST, always: true }).enable, false, state);
  }
});

test('keepAlive calls the enable endpoint only for the workflows that are due', async () => {
  const gh = fakeGh({
    'refresh.yml': { state: 'active', updated_at: daysAgo(MID_MONTH, 40) },
    'keepalive.yml': { state: 'active', updated_at: daysAgo(MID_MONTH, 2) },
  });
  const api = createApi({ repository: REPOSITORY, run: gh.run });
  const outcomes = await keepAlive({ api, workflows: ['refresh.yml', 'keepalive.yml'], now: MID_MONTH });
  assert.deepEqual(outcomes.map((outcome) => [outcome.workflow, outcome.result]), [['refresh.yml', 'enabled'], ['keepalive.yml', 'skipped']]);
  assert.deepEqual(gh.puts(), [`repos/${REPOSITORY}/actions/workflows/refresh.yml/enable`]);
});

test('the enable call is `gh api -X PUT repos/<repository>/actions/workflows/<file>/enable`', async () => {
  const gh = fakeGh({ 'refresh.yml': { state: 'active', updated_at: daysAgo(FIRST, 0) } });
  await keepAlive({ api: createApi({ repository: REPOSITORY, run: gh.run }), workflows: ['refresh.yml'], now: FIRST });
  assert.deepEqual(gh.calls.at(-1), ['api', '-X', 'PUT', `repos/${REPOSITORY}/actions/workflows/refresh.yml/enable`]);
  assert.deepEqual(gh.calls[0], ['api', `repos/${REPOSITORY}/actions/workflows/refresh.yml`]);
});

test('a missing workflow is a failure, and the other workflows are still handled', async () => {
  const gh = fakeGh({ 'keepalive.yml': { state: 'active', updated_at: daysAgo(FIRST, 0) } });
  const api = createApi({ repository: REPOSITORY, run: gh.run });
  const outcomes = await keepAlive({ api, workflows: ['refresh.yml', 'keepalive.yml'], now: FIRST });
  assert.equal(outcomes[0].result, 'failed');
  assert.match(outcomes[0].detail, /does not exist/);
  assert.equal(outcomes[1].result, 'enabled');
});

test('an API failure is a failure, and nothing is enabled after a failed read', async () => {
  const gh = fakeGh({ 'refresh.yml': { fail: 'gh: Resource not accessible by integration (HTTP 403)' } });
  const outcomes = await keepAlive({ api: createApi({ repository: REPOSITORY, run: gh.run }), workflows: ['refresh.yml'], now: FIRST });
  assert.equal(outcomes[0].result, 'failed');
  assert.match(outcomes[0].detail, /HTTP 403/);
  assert.deepEqual(gh.puts(), []);
});

test('an answer that is not JSON is a failure', async () => {
  const gh = fakeGh({ 'refresh.yml': { garbage: '<html>' } });
  const outcomes = await keepAlive({ api: createApi({ repository: REPOSITORY, run: gh.run }), workflows: ['refresh.yml'], now: FIRST });
  assert.equal(outcomes[0].result, 'failed');
  assert.match(outcomes[0].detail, /not JSON/);
});

test('a failing enable call is a failure', async () => {
  const gh = fakeGh({ 'refresh.yml': { state: 'active', updated_at: daysAgo(FIRST, 0) } }, { enableFails: 'gh: Forbidden (HTTP 403)' });
  const outcomes = await keepAlive({ api: createApi({ repository: REPOSITORY, run: gh.run }), workflows: ['refresh.yml'], now: FIRST });
  assert.equal(outcomes[0].result, 'failed');
  assert.match(outcomes[0].detail, /enabling refresh\.yml failed/);
});

test('names that are not a repository or a workflow file never reach the API', async () => {
  assert.throws(() => createApi({ repository: 'not a repository' }), ApiError);
  assert.throws(() => createApi({ repository: '../x' }), ApiError);
  const gh = fakeGh({});
  const outcomes = await keepAlive({ api: createApi({ repository: REPOSITORY, run: gh.run }), workflows: ['../../x.yml', 'a b.yml', 'refresh.txt'], now: FIRST });
  assert.deepEqual(outcomes.map((outcome) => outcome.result), ['failed', 'failed', 'failed']);
  assert.deepEqual(gh.calls, []);
});

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {ReturnType<typeof fakeGh>} gh
 * @param {Date} now
 */
async function runMain(args, env, gh, now) {
  let out = '';
  let err = '';
  const code = await main(args, { env, now, run: gh.run, out: (text) => (out += text), err: (text) => (err += text) });
  return { code, out, err };
}

test('main: exit 0 with one line per workflow', async () => {
  const gh = fakeGh({
    'refresh.yml': { state: 'active', updated_at: daysAgo(MID_MONTH, 40) },
    'keepalive.yml': { state: 'active', updated_at: daysAgo(MID_MONTH, 1) },
  });
  const { code, out, err } = await runMain(['refresh.yml', 'keepalive.yml'], { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: TOKEN }, gh, MID_MONTH);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.match(out, /keepalive: refresh\.yml: enabled, it was last updated 40 days ago\n/);
  assert.match(out, /keepalive: keepalive\.yml: skipped, /);
});

test('main: --always enables everything that is not disabled by hand', async () => {
  const gh = fakeGh({
    'refresh.yml': { state: 'active', updated_at: daysAgo(MID_MONTH, 1) },
    'keepalive.yml': { state: 'active', updated_at: daysAgo(MID_MONTH, 1) },
  });
  const { code } = await runMain(['--always', 'refresh.yml', 'keepalive.yml'], { GITHUB_REPOSITORY: REPOSITORY }, gh, MID_MONTH);
  assert.equal(code, 0);
  assert.equal(gh.puts().length, 2);
});

test('main: a failure makes the exit code 1 and is reported on the error stream', async () => {
  const gh = fakeGh({});
  const { code, out, err } = await runMain(['refresh.yml'], { GITHUB_REPOSITORY: REPOSITORY }, gh, MID_MONTH);
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /keepalive: refresh\.yml: failed, reading refresh\.yml failed/);
});

test('main: usage errors', async () => {
  const gh = fakeGh({});
  for (const [args, env] of /** @type {[string[], Record<string, string>][]} */ ([
    [[], { GITHUB_REPOSITORY: REPOSITORY }],
    [['--bogus', 'refresh.yml'], { GITHUB_REPOSITORY: REPOSITORY }],
    [['refresh.yml'], {}],
  ])) {
    const { code, err } = await runMain(args, env, gh, MID_MONTH);
    assert.equal(code, 2, JSON.stringify(args));
    assert.match(err, /Usage:|keepalive:/);
  }
  assert.deepEqual(gh.calls, []);
});

test('the token never appears in the output, even when gh echoes it in an error', async () => {
  const leaky = {
    'refresh.yml': { fail: `gh: Bad credentials for token ${TOKEN} (HTTP 401)` },
    'keepalive.yml': { state: 'active', updated_at: daysAgo(FIRST, 0) },
  };
  const gh = fakeGh(leaky, { enableFails: `denied for ${TOKEN}` });
  const { code, out, err } = await runMain(['refresh.yml', 'keepalive.yml'], { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: TOKEN, GITHUB_TOKEN: `${TOKEN}-other` }, gh, FIRST);
  assert.equal(code, 1);
  assert.doesNotMatch(out + err, /ghs_FAKE/);
  assert.match(err, /\*\*\*/);
  // The runner is given arguments only; the token is in the environment of the real process, never in the command line.
  assert.ok(gh.calls.every((args) => !args.join(' ').includes(TOKEN)));
});

test('a successful run prints nothing but the report lines', async () => {
  const gh = fakeGh({ 'refresh.yml': { state: 'active', updated_at: daysAgo(FIRST, 0) } });
  const { out, err } = await runMain(['refresh.yml'], { GITHUB_REPOSITORY: REPOSITORY, GH_TOKEN: TOKEN }, gh, FIRST);
  assert.equal(out.trimEnd().split('\n').length, 1);
  assert.equal(err, '');
  assert.doesNotMatch(out, /ghs_|token/i);
});

test('scrub removes secrets and control characters', () => {
  assert.equal(scrub('a SECRET b\nc', ['SECRET', '']), 'a *** b c');
  assert.equal(scrub('plain', []), 'plain');
});
