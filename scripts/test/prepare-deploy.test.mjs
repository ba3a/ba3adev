// Tests for scripts/prepare-deploy.mjs and for the headers file it publishes (deploy/_headers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HEADERS_FILE_NAME, MAX_HEADER_RULES, lintHeaders, parseArgs, prepareDeploy } from '../prepare-deploy.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const headersFile = join(root, 'deploy', '_headers');
const headers = readFileSync(headersFile, 'utf8');

/**
 * @typedef {{ path: string, lines: string[] }} Rule
 */

/**
 * Splits a headers file into its rules.
 *
 * @param {string} text
 * @returns {Rule[]}
 */
function rulesOf(text) {
  /** @type {Rule[]} */
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) rules.at(-1)?.lines.push(line.trim());
    else rules.push({ path: line.trim(), lines: [] });
  }
  return rules;
}

/**
 * @param {string} path
 * @returns {Rule}
 */
function ruleFor(path) {
  const rule = rulesOf(headers).find((candidate) => candidate.path === path);
  assert.ok(rule, `deploy/_headers has a rule for ${path}`);
  return rule;
}

test('the headers file is within the limits Cloudflare Pages applies', () => {
  assert.deepEqual(lintHeaders(headers), []);
  assert.ok(rulesOf(headers).length <= MAX_HEADER_RULES);
});

test('the policy lets the pages work and allows the Cloudflare analytics beacon', () => {
  const csp = ruleFor('/*').lines.find((line) => line.startsWith('Content-Security-Policy:'));
  assert.ok(csp, 'every page gets a Content-Security-Policy');
  /** @param {string} name */
  const directive = (name) => csp.slice('Content-Security-Policy:'.length).split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? '';
  assert.match(directive('script-src'), /https:\/\/static\.cloudflareinsights\.com/);
  assert.match(directive('connect-src'), /https:\/\/cloudflareinsights\.com/);
  assert.match(directive('script-src'), /'wasm-unsafe-eval'/, 'the search index needs WebAssembly');
  assert.match(directive('img-src'), /tile\.openstreetmap\.org/, 'the maps need their tiles');
  assert.doesNotMatch(csp, /'unsafe-eval'/);
  assert.match(directive('default-src'), /^default-src 'self'$/);
  assert.match(directive('frame-ancestors'), /'none'/);
  assert.match(directive('object-src'), /'none'/);
  assert.ok(ruleFor('/*').lines.includes('X-Content-Type-Options: nosniff'));
});

test('build-info.json is never cached, so the refresh job and the smoke test see the live build', () => {
  assert.deepEqual(ruleFor('/build-info.json').lines, ['Cache-Control: no-cache']);
});

test('press-kit SVG files are served with a sandboxing policy and nosniff', () => {
  const lines = ruleFor('/made/*/press-kit/*.svg').lines;
  assert.ok(lines.includes("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox"));
  assert.ok(lines.includes('X-Content-Type-Options: nosniff'));
});

test('the generated Dokka reference is the one place without the page policy', () => {
  assert.deepEqual(ruleFor('/made/*/docs/reference/*').lines, ['! Content-Security-Policy']);
});

test('image variants and title cards, which have a content hash in their address, are cached for good', () => {
  for (const path of ['/img/*', '/cards/*']) {
    assert.deepEqual(ruleFor(path).lines, ['Cache-Control: public, max-age=31536000, immutable']);
  }
});

test('the root icons have their type and a long, not immutable, cache; so do the brand files', () => {
  assert.deepEqual(ruleFor('/favicon.ico').lines, ['Content-Type: image/x-icon', 'Cache-Control: public, max-age=2592000']);
  assert.deepEqual(ruleFor('/apple-touch-icon.png').lines, ['Content-Type: image/png', 'Cache-Control: public, max-age=2592000']);
  assert.deepEqual(ruleFor('/assets/brand/*').lines, ['Cache-Control: public, max-age=2592000']);
});

test('lintHeaders finds what Cloudflare Pages would silently ignore', () => {
  assert.deepEqual(lintHeaders('/a\n  X-A: b\n'), []);
  assert.match(lintHeaders('  X-A: b\n')[0], /no path above/);
  assert.match(lintHeaders('a\n  X-A: b\n')[0], /must start with "\/"/);
  assert.match(lintHeaders('/a\n  not a header\n')[0], /not a header line/);
  assert.match(lintHeaders(`/a\n  X-A: ${'b'.repeat(2100)}\n`)[0], /longer than 2000/);
  const many = Array.from({ length: MAX_HEADER_RULES + 1 }, (_, i) => `/p${i}\n  X-A: b`).join('\n');
  assert.match(lintHeaders(many).join('\n'), /at most 100/);
});

/**
 * Runs `body` with a fresh output root that holds two built sites.
 *
 * @param {(dist: string) => void} body
 */
function withDist(body) {
  const dist = mkdtempSync(join(tmpdir(), 'prepare-deploy-'));
  try {
    for (const id of ['a.test', 'b.test']) {
      mkdirSync(join(dist, id), { recursive: true });
      writeFileSync(join(dist, id, 'index.html'), '<html></html>');
      writeFileSync(join(dist, id, '404.html'), '<html></html>');
      writeFileSync(join(dist, id, 'build-info.json'), '{"builtAt":"x"}');
      writeFileSync(join(dist, id, '.coffer-manifest.json'), '{}');
    }
    body(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

test('prepareDeploy removes the manifest and adds the headers file to every site', () => {
  withDist((dist) => {
    /** @type {string[]} */
    const lines = [];
    prepareDeploy({ distDir: dist, headersFile, siteIds: ['a.test', 'b.test'], log: (line) => lines.push(line) });
    for (const id of ['a.test', 'b.test']) {
      assert.equal(existsSync(join(dist, id, '.coffer-manifest.json')), false, `${id} manifest removed`);
      assert.equal(readFileSync(join(dist, id, HEADERS_FILE_NAME), 'utf8'), headers);
      assert.ok(existsSync(join(dist, id, 'build-info.json')), 'build-info.json stays');
    }
    assert.equal(lines.length, 2);
  });
});

test('prepareDeploy can run twice on the same output', () => {
  withDist((dist) => {
    prepareDeploy({ distDir: dist, headersFile, siteIds: ['a.test', 'b.test'] });
    prepareDeploy({ distDir: dist, headersFile, siteIds: ['a.test', 'b.test'] });
    for (const id of ['a.test', 'b.test']) {
      assert.equal(readFileSync(join(dist, id, HEADERS_FILE_NAME), 'utf8'), headers);
      assert.equal(existsSync(join(dist, id, '.coffer-manifest.json')), false);
    }
  });
});

test('prepareDeploy refuses an unbuilt site, an existing _headers and a bad headers file', () => {
  withDist((dist) => {
    assert.throws(() => prepareDeploy({ distDir: dist, headersFile, siteIds: ['c.test'] }), /holds no built site/);
    assert.throws(() => prepareDeploy({ distDir: dist, headersFile, siteIds: [] }), /no site to prepare/);
    assert.throws(() => prepareDeploy({ distDir: dist, headersFile: join(dist, 'missing'), siteIds: ['a.test'] }), /does not exist/);
    const bad = join(dist, 'bad-headers');
    writeFileSync(bad, 'no-slash\n  X-A: b\n');
    assert.throws(() => prepareDeploy({ distDir: dist, headersFile: bad, siteIds: ['a.test'] }), /would be ignored by Cloudflare Pages/);
    writeFileSync(join(dist, 'a.test', '_headers'), '/*\n  X-Own: 1\n');
    assert.throws(() => prepareDeploy({ distDir: dist, headersFile, siteIds: ['a.test'] }), /already has a _headers/);
    assert.equal(readFileSync(join(dist, 'a.test', '_headers'), 'utf8'), '/*\n  X-Own: 1\n', 'the build output is not overwritten');
    assert.ok(existsSync(join(dist, 'a.test', '.coffer-manifest.json')), 'nothing is removed from a site that is refused');
  });
});

test('parseArgs reads the options', () => {
  const parsed = parseArgs(['--dist', 'out', '--headers', 'h', '--config', 'c.yaml']);
  assert.ok(!('error' in parsed));
  assert.ok(parsed.dist.endsWith('out') && parsed.headers.endsWith('h') && parsed.config.endsWith('c.yaml'));
  assert.match(String(/** @type {any} */ (parseArgs(['--x', '1'])).error), /unexpected argument/);
  assert.match(String(/** @type {any} */ (parseArgs(['--dist'])).error), /needs a value/);
});

test('the script prepares the sites named in a configuration file', () => {
  withDist((dist) => {
    const config = join(dist, 'coffer.yaml');
    writeFileSync(
      config,
      `sites:
  - id: a.test
    baseUrl: https://a.test
    lang: en
    timezone: UTC
    title: A
    description: A site.
    contentDir: content/a
    blogs:
      - { id: blog, dir: content/a, prefix: "", title: Blog }
`,
    );
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'prepare-deploy.mjs'), '--dist', dist, '--config', config], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(dist, 'a.test', '_headers')));
    assert.equal(existsSync(join(dist, 'b.test', '_headers')), false, 'only configured sites are touched');
    const failed = spawnSync(process.execPath, [join(root, 'scripts', 'prepare-deploy.mjs'), '--dist', join(dist, 'none'), '--config', config], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /holds no built site/);
  });
});
