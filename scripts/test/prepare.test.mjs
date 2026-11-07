// Tests for scripts/prepare.mjs, the `prepare` script of the root package.json. Every test works in a
// throwaway repository under the system temp folder; the hooks are never installed into this repository,
// and no media store is contacted (the credentials used here are obviously fake, and the `media pull`
// command is replaced by a spy wherever credentials exist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCi, prepare } from '../prepare.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repository, 'scripts', 'prepare.mjs');

const COFFER_YAML = `sites:
  - id: a.test
    baseUrl: https://a.test
    lang: en
    timezone: UTC
    title: A
    description: A site.
    contentDir: content/a
    blogs:
      - { id: blog, dir: content/a, prefix: "", title: Blog }
media:
  store:
    type: s3
    endpoint: https://\${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com
    bucket: test-bucket
    region: auto
    accessKeyIdEnv: R2_ACCESS_KEY_ID
    secretAccessKeyEnv: R2_SECRET_ACCESS_KEY
`;

const NO_MEDIA_YAML = COFFER_YAML.slice(0, COFFER_YAML.indexOf('media:'));

/** The environment of a run: this process's, without CI, git variables and any credential. */
function cleanEnv(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CI|GIT_.*|R2_.*|CLOUDFLARE_.*|COFFER.*)$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** Obviously fake credentials; no store is contacted with them. */
const FAKE_CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: 'fake-account', R2_ACCESS_KEY_ID: 'fake-id', R2_SECRET_ACCESS_KEY: 'fake-secret' };

/**
 * Runs `body` in a fresh temporary git repository that holds a coffer.yaml, and removes it afterwards.
 *
 * @param {{ yaml?: string, git?: boolean }} options
 * @param {(dir: string) => Promise<void> | void} body
 */
async function inRepository({ yaml = COFFER_YAML, git = true }, body) {
  const dir = mkdtempSync(join(tmpdir(), 'ba3a-prepare-'));
  try {
    mkdirSync(join(dir, 'content', 'a'), { recursive: true });
    writeFileSync(join(dir, 'coffer.yaml'), yaml);
    if (git) {
      const init = spawnSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
    }
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** @param {string} dir @returns {string} The local `core.hooksPath` of the repository, or an empty string. */
function hooksPath(dir) {
  const result = spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
  return result.stdout.trim();
}

/**
 * A stand-in for the coffer command line that records the commands and answers with the given codes.
 *
 * @param {Record<string, number>} [answers] The exit code by command ("hooks install", "media pull"); the default is 0.
 */
function spy(answers = {}) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    run(/** @type {string[]} */ args) {
      const name = args.slice(0, 2).join(' ');
      calls.push(name);
      return { status: answers[name] ?? 0, output: '' };
    },
  };
}

test('isCi: any value except empty, 0 and false means CI', () => {
  assert.equal(isCi({}), false);
  assert.equal(isCi({ CI: '' }), false);
  assert.equal(isCi({ CI: '0' }), false);
  assert.equal(isCi({ CI: 'false' }), false);
  assert.equal(isCi({ CI: 'true' }), true);
  assert.equal(isCi({ CI: '1' }), true);
});

test('the package.json runs the script as `prepare` and has no other install-time script', () => {
  const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prepare, 'node scripts/prepare.mjs');
  for (const name of ['preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts[name], undefined, name);
});

test('run as a program with CI set, it does nothing, prints nothing and exits 0', () => {
  const result = spawnSync(process.execPath, [script], { cwd: repository, env: cleanEnv({ CI: 'true' }), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('CI: neither the hooks nor the pull run', async () => {
  await inRepository({}, async (dir) => {
    const lines = [];
    const fake = spy();
    await prepare({ root: dir, env: cleanEnv({ CI: 'true' }), log: (line) => lines.push(line), run: fake.run });
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(lines, []);
    assert.equal(hooksPath(dir), '');
  });
});

test('without a git repository nothing is done', async () => {
  await inRepository({ git: false }, async (dir) => {
    const lines = [];
    const fake = spy();
    await prepare({ root: dir, env: cleanEnv(), log: (line) => lines.push(line), run: fake.run });
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(lines, []);
  });
});

test('without credentials the hooks are installed, one notice is printed, and nothing fails', async () => {
  await inRepository({}, async (dir) => {
    const lines = [];
    // The real coffer command line installs the hooks; the pull must not be reached.
    await prepare({ root: dir, env: cleanEnv(), log: (line) => lines.push(line) });
    assert.equal(hooksPath(dir), '.coffer-hooks');
    assert.ok(existsSync(join(dir, '.coffer-hooks', 'pre-commit')));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^prepare: media originals not fetched: no credentials/);
    assert.match(lines[0], /CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
    assert.match(lines[0], /\.env\.local\.example/);
  });
});

test('without credentials the pull command is never started', async () => {
  await inRepository({}, async (dir) => {
    const fake = spy();
    await prepare({ root: dir, env: cleanEnv(), log: () => {}, run: fake.run });
    assert.deepEqual(fake.calls, ['hooks install']);
  });
});

test('credentials from the environment: the hooks are installed and the originals are pulled', async () => {
  await inRepository({}, async (dir) => {
    const lines = [];
    const fake = spy();
    await prepare({ root: dir, env: cleanEnv(FAKE_CREDENTIALS), log: (line) => lines.push(line), run: fake.run });
    assert.deepEqual(fake.calls, ['hooks install', 'media pull']);
    assert.deepEqual(lines, []);
  });
});

test('credentials from .env.local count as well, and a missing one is named without showing any value', async () => {
  await inRepository({}, async (dir) => {
    writeFileSync(join(dir, '.env.local'), 'CLOUDFLARE_ACCOUNT_ID=fake-account\nR2_ACCESS_KEY_ID=fake-id\n');
    const lines = [];
    const fake = spy();
    await prepare({ root: dir, env: cleanEnv(), log: (line) => lines.push(line), run: fake.run });
    assert.deepEqual(fake.calls, ['hooks install']);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /missing: R2_SECRET_ACCESS_KEY\)/);
    assert.doesNotMatch(lines[0], /fake-/);

    writeFileSync(join(dir, '.env.local'), 'CLOUDFLARE_ACCOUNT_ID=fake-account\nR2_ACCESS_KEY_ID=fake-id\nR2_SECRET_ACCESS_KEY=fake-secret\n');
    const second = spy();
    await prepare({ root: dir, env: cleanEnv(), log: (line) => lines.push(line), run: second.run });
    assert.deepEqual(second.calls, ['hooks install', 'media pull']);
    assert.equal(lines.length, 1);
  });
});

test('a failing hooks install or pull is reported on a line and does not stop the script', async () => {
  await inRepository({}, async (dir) => {
    const lines = [];
    const fake = spy({ 'media pull': 1, 'hooks install': 1 });
    await prepare({ root: dir, env: cleanEnv(FAKE_CREDENTIALS), log: (line) => lines.push(line), run: fake.run });
    assert.deepEqual(fake.calls, ['hooks install', 'media pull']);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^prepare: "coffer hooks install" failed/);
    assert.match(lines[1], /^prepare: "coffer media pull" failed/);
  });
});

test('a configuration without a media store installs the hooks and has nothing to pull', async () => {
  await inRepository({ yaml: NO_MEDIA_YAML }, async (dir) => {
    const lines = [];
    const fake = spy();
    await prepare({ root: dir, env: cleanEnv(), log: (line) => lines.push(line), run: fake.run });
    assert.deepEqual(fake.calls, ['hooks install']);
    assert.deepEqual(lines, []);
  });
});

test('a configuration that cannot be read is one line and not a failure', async () => {
  await inRepository({ yaml: 'sites: nope\n' }, async (dir) => {
    const lines = [];
    const fake = spy();
    await prepare({ root: dir, env: cleanEnv(), log: (line) => lines.push(line), run: fake.run });
    assert.deepEqual(fake.calls, ['hooks install']);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^prepare: the media originals were not fetched: /);
  });
});
