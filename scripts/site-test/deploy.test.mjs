// Assertions about the deployment of the two sites. `npm run test:sites` builds the sites into
// `.cache/test-dist` first. The tests run the smoke test of the deploy workflow against that
// output, served on the loopback interface by `coffer serve` (which answers the way Cloudflare
// Pages does), and check the pieces the workflow adds to the output. Nothing here uses the
// network beyond the loopback interface, and nothing is deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, startServer } from 'coffer';

import { prepareDeploy } from '../prepare-deploy.mjs';
import { SITES, feedIconOf, main, readExpectedBuiltAt } from '../smoke-test.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, '.cache', 'test-dist');
const config = loadConfig({ configPath: join(root, 'coffer.yaml') });

test('the build output has the pages the smoke test looks for, in the right language', () => {
  for (const site of SITES) {
    const directory = join(dist, site.id);
    assert.ok(existsSync(directory), `${site.id} is built in .cache/test-dist (run "npm run test:sites")`);
    assert.ok(existsSync(join(directory, ...site.redirect.to.split('/').filter(Boolean), 'index.html')), `${site.redirect.to} exists on ${site.id}`);
    assert.match(readFileSync(join(directory, '404.html'), 'utf8'), new RegExp(`<html lang="${site.lang}"`));
    assert.match(readExpectedBuiltAt(dist, site.id), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  }
});

test('the smoke test passes against the built sites, served the way Cloudflare Pages serves them', async () => {
  const servers = [];
  try {
    /** @type {string[]} */
    const args = ['--dist', dist, '--allow-insecure-loopback', '--timeout', '0'];
    for (const site of SITES) {
      const server = await startServer({ dir: join(dist, site.id), host: '127.0.0.1', port: 0 });
      servers.push(server);
      args.push('--base', `${site.id}=${server.url}`);
    }
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    const code = await main(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
    assert.equal(code, 0, `${err.join('\n')}\n${out.join('\n')}`);
    assert.match(out.join('\n'), /all 12 checks passed/);
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test('the smoke test fails when the served site is not the build of this run', async () => {
  const copy = mkdtempSync(join(tmpdir(), 'smoke-stale-'));
  const servers = [];
  try {
    cpSync(join(dist, SITES[0].id), join(copy, SITES[0].id), { recursive: true });
    const server = await startServer({ dir: join(copy, SITES[0].id), host: '127.0.0.1', port: 0 });
    servers.push(server);
    // The copy is served; the run claims another build time.
    const claimed = mkdtempSync(join(tmpdir(), 'smoke-claim-'));
    try {
      mkdirSync(join(claimed, SITES[0].id), { recursive: true });
      writeFileSync(join(claimed, SITES[0].id, 'build-info.json'), JSON.stringify({ builtAt: '2001-01-01T00:00:00.000Z' }));
      /** @type {string[]} */
      const err = [];
      const code = await main(
        ['--dist', claimed, '--site', SITES[0].id, '--base', `${SITES[0].id}=${server.url}`, '--allow-insecure-loopback', '--timeout', '0'],
        { out: () => {}, err: (line) => err.push(line) },
      );
      assert.equal(code, 1);
      assert.match(err.join('\n'), /says builtAt .*; this run built 2001-01-01T00:00:00\.000Z/);
    } finally {
      rmSync(claimed, { recursive: true, force: true });
    }
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    rmSync(copy, { recursive: true, force: true });
  }
});

test('the built sites answer /favicon.ico and carry an absolute feed icon that is served', async () => {
  const servers = [];
  try {
    for (const site of SITES) {
      const server = await startServer({ dir: join(dist, site.id), host: '127.0.0.1', port: 0 });
      servers.push(server);
      const favicon = await fetch(`${server.url}/favicon.ico`);
      assert.equal(favicon.status, 200, `${site.id} /favicon.ico`);
      assert.match(favicon.headers.get('content-type') ?? '', /^image\//, `${site.id} /favicon.ico is an image`);
      const feed = await (await fetch(`${server.url}${site.feed}`)).text();
      const icon = feedIconOf(feed);
      assert.equal(icon, `${site.baseUrl}/assets/brand/icon-192.png`, `${site.id} feed icon`);
      const served = await fetch(`${server.url}${new URL(icon).pathname}`);
      assert.equal(served.status, 200, `${site.id} feed icon is served`);
      assert.match(served.headers.get('content-type') ?? '', /^image\//);
    }
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});

test('the smoke test fails when /favicon.ico is missing or the feed has no absolute <icon>', async () => {
  const site = SITES[0];
  /** @type {[string, (directory: string) => void, RegExp][]} */
  const cases = [
    ['no favicon', (directory) => rmSync(join(directory, 'favicon.ico')), /favicon\.ico answered 404/],
    ['no icon', (directory) => rewriteFeed(directory, site.feed, (feed) => feed.replace(/<icon>[^<]*<\/icon>/, '')), /has no <icon>/],
    ['relative icon', (directory) => rewriteFeed(directory, site.feed, (feed) => feed.replace(/<icon>https:\/\/ba3a\.dev/, '<icon>')), /is not an absolute URL/],
  ];
  for (const [name, damage, message] of cases) {
    const copy = mkdtempSync(join(tmpdir(), 'smoke-icons-'));
    const servers = [];
    try {
      cpSync(join(dist, site.id), join(copy, site.id), { recursive: true });
      damage(join(copy, site.id));
      const server = await startServer({ dir: join(copy, site.id), host: '127.0.0.1', port: 0 });
      servers.push(server);
      /** @type {string[]} */
      const err = [];
      const code = await main(
        ['--dist', dist, '--site', site.id, '--base', `${site.id}=${server.url}`, '--allow-insecure-loopback', '--timeout', '0'],
        { out: () => {}, err: (line) => err.push(line) },
      );
      assert.equal(code, 1, name);
      assert.match(err.join('\n'), message, name);
    } finally {
      await Promise.all(servers.map((server) => server.close()));
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

/**
 * @param {string} directory The built site.
 * @param {string} feedPath The address of the feed, with its leading slash.
 * @param {(feed: string) => string} change
 */
function rewriteFeed(directory, feedPath, change) {
  const file = join(directory, ...feedPath.split('/').filter(Boolean));
  const before = readFileSync(file, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, 'the feed was changed');
  writeFileSync(file, after);
}

test('the build writes no _headers file of its own, so the deploy step can add it', () => {
  for (const site of config.sites) {
    assert.equal(existsSync(join(dist, site.id, '_headers')), false, `${site.id} has no _headers in the build output`);
  }
});

test('preparing the output for upload removes the manifest and adds the headers, and the smoke test still passes', async () => {
  const copy = mkdtempSync(join(tmpdir(), 'prepare-real-'));
  const servers = [];
  try {
    for (const site of config.sites) cpSync(join(dist, site.id), join(copy, site.id), { recursive: true });
    prepareDeploy({ distDir: copy, headersFile: join(root, 'deploy', '_headers'), siteIds: config.sites.map((site) => site.id) });
    /** @type {string[]} */
    const args = ['--dist', copy, '--allow-insecure-loopback', '--timeout', '0'];
    for (const site of SITES) {
      assert.equal(existsSync(join(copy, site.id, '.coffer-manifest.json')), false);
      assert.ok(existsSync(join(copy, site.id, '_headers')));
      const server = await startServer({ dir: join(copy, site.id), host: '127.0.0.1', port: 0 });
      servers.push(server);
      args.push('--base', `${site.id}=${server.url}`);
    }
    /** @type {string[]} */
    const err = [];
    const code = await main(args, { out: () => {}, err: (line) => err.push(line) });
    assert.equal(code, 0, err.join('\n'));
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    rmSync(copy, { recursive: true, force: true });
  }
});
