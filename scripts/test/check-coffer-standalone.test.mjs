import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FALLBACK_EXCLUDED,
  UsageError,
  copyFiles,
  findLeaks,
  findOnPath,
  foreignEntries,
  gitEnv,
  isExcluded,
  parseArgs,
  removeTree,
  resolveNpm,
  sanitizedEnv,
  selectFiles,
} from '../check-coffer-standalone.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repository, 'scripts', 'check-coffer-standalone.mjs');

/**
 * Runs `body` with a fresh temporary directory and removes it afterwards.
 *
 * @param {(dir: string) => void | Promise<void>} body
 */
async function withTemp(body) {
  const dir = mkdtempSync(join(tmpdir(), 'standalone-test-'));
  try {
    await body(dir);
  } finally {
    removeTree(dir);
  }
}

/**
 * @param {string} root
 * @param {Record<string, string>} files
 */
function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, ...name.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
}

const hasGit = findOnPath('git', process.env.PATH ?? process.env.Path) !== null;

// ---------------------------------------------------------------------------
// Command line

test('no arguments means no options', () => {
  assert.deepEqual(parseArgs([]), { keep: false, help: false });
});

test('--keep and --help are understood', () => {
  assert.deepEqual(parseArgs(['--keep']), { keep: true, help: false });
  assert.deepEqual(parseArgs(['-h']), { keep: false, help: true });
  assert.deepEqual(parseArgs(['--help', '--keep']), { keep: true, help: true });
});

test('an unknown argument is a usage error that names it', () => {
  assert.throws(() => parseArgs(['--verbose']), (error) => error instanceof UsageError && /--verbose/.test(error.message));
});

test('the script prints its usage and exits with 2 for a bad argument', () => {
  const bad = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument: --nope/);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--keep/);
});

// ---------------------------------------------------------------------------
// Which files are copied

test('the built-in ignore list matches the rules in coffer/.gitignore', () => {
  const rules = readFileSync(join(repository, 'coffer', '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.replace(/\/$/, ''))
    .sort();
  const expected = FALLBACK_EXCLUDED.filter((rule) => rule !== '.git').sort();
  assert.deepEqual(expected, rules);
});

test('dependencies, build output and caches are excluded, at any depth for plain names', () => {
  for (const path of [
    'node_modules/a/index.js',
    'example/dist/workshop/index.html',
    '.cache/images/x.webp',
    '.coffer/state.json',
    'example/node_modules/x/y.js',
    'a/.cache/b',
    '.git/config',
  ]) {
    assert.equal(isExcluded(path), true, path);
  }
  for (const path of ['src/dist.js', 'dist/keep.txt', 'example/distant/a.txt', 'example/coffer.yaml', 'package.json', '.github/workflows/ci.yml']) {
    assert.equal(isExcluded(path), false, path);
  }
});

test('without git, the files are the tree minus the excluded paths', async () => {
  await withTemp((dir) => {
    write(dir, {
      'package.json': '{}',
      'src/a.js': '',
      '.github/workflows/ci.yml': '',
      'node_modules/dep/index.js': '',
      'example/dist/site/index.html': '',
      'example/coffer.yaml': '',
      '.cache/x': '',
    });
    const selection = selectFiles(dir, {}, { useGit: false });
    assert.equal(selection.method, 'fallback');
    assert.deepEqual(selection.files, ['.github/workflows/ci.yml', 'example/coffer.yaml', 'package.json', 'src/a.js']);
  });
});

test('git decides: ignored files are left out and untracked files are kept', { skip: !hasGit }, async () => {
  await withTemp((dir) => {
    /** @param {string[]} args */
    const run = (args) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    run(['init', '-q']);
    // The repository's root holds a coffer/ directory, as in the content repository.
    const coffer = join(dir, 'coffer');
    write(coffer, {
      '.gitignore': 'node_modules/\nexample/dist/\n.cache/\n.coffer/\nsecret.txt\n',
      'package.json': '{}',
      'src/a.js': '',
      'untracked.js': '',
      'secret.txt': 'x',
      'node_modules/dep/index.js': '',
      'example/dist/site/index.html': '',
    });
    write(dir, { 'outside.txt': 'not part of coffer' });
    run(['add', 'coffer/package.json', 'coffer/src/a.js', 'coffer/.gitignore']);
    const selection = selectFiles(coffer, process.env);
    assert.equal(selection.method, 'git');
    assert.deepEqual(selection.files, ['.gitignore', 'package.json', 'src/a.js', 'untracked.js']);
  });
});

test('git does not need a clean checkout: a deleted tracked file is skipped', { skip: !hasGit }, async () => {
  await withTemp((dir) => {
    /** @param {string[]} args */
    const git = (args) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    write(dir, { 'a.txt': '1', 'b.txt': '2' });
    git(['add', '.']);
    git(['commit', '-q', '-m', 'init']);
    writeFileSync(join(dir, 'c.txt'), '3');
    writeFileSync(join(dir, 'a.txt'), 'modified');
    unlinkSync(join(dir, 'b.txt'));
    assert.deepEqual(selectFiles(dir, process.env).files, ['a.txt', 'c.txt']);
  });
});

test('without git on the PATH the built-in list is used and says why', async () => {
  await withTemp((dir) => {
    write(dir, { 'package.json': '{}', 'node_modules/x/y.js': '' });
    // An empty PATH means git cannot be found.
    const selection = selectFiles(dir, { PATH: '' });
    assert.equal(selection.method, 'fallback');
    assert.match(selection.note ?? '', /git was not found/);
    assert.deepEqual(selection.files, ['package.json']);
  });
});

test('copyFiles keeps the relative paths and the content', async () => {
  await withTemp((dir) => {
    const from = join(dir, 'from');
    const to = join(dir, 'to');
    write(from, { 'a/b/c.txt': 'one', 'd.txt': 'two' });
    mkdirSync(to);
    copyFiles(from, to, ['a/b/c.txt', 'd.txt']);
    assert.equal(readFileSync(join(to, 'a', 'b', 'c.txt'), 'utf8'), 'one');
    assert.equal(readFileSync(join(to, 'd.txt'), 'utf8'), 'two');
  });
});

test('a symbolic link is not copied', { skip: process.platform === 'win32' }, async () => {
  await withTemp((dir) => {
    write(dir, { 'real.txt': 'x' });
    symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));
    assert.deepEqual(selectFiles(dir, {}, { useGit: false }).files, ['real.txt']);
  });
});

// ---------------------------------------------------------------------------
// Environment

test('the environment keeps what npm needs and drops secrets and npm settings', () => {
  const env = sanitizedEnv({
    PATH: '/bin',
    HOME: '/home/me',
    https_proxy: 'http://proxy.example:3128',
    COFFER_MEDIA_SECRET: 'secret',
    R2_SECRET_ACCESS_KEY: 'secret',
    GITHUB_TOKEN: 'token',
    NPM_TOKEN: 'token',
    NODE_AUTH_TOKEN: 'token',
    NODE_OPTIONS: '--require ./hook.js',
    NODE_PATH: '/repo/node_modules',
    npm_config_workspace: 'coffer',
    npm_execpath: '/usr/lib/npm-cli.js',
    INIT_CWD: '/repo',
    GIT_DIR: '/repo/.git',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/me', https_proxy: 'http://proxy.example:3128' });
});

test('the environment match is case-insensitive, as on Windows', () => {
  const env = sanitizedEnv({ Path: 'C:\\x', SystemRoot: 'C:\\Windows', cofFer_media_key: 'x' });
  assert.deepEqual(env, { Path: 'C:\\x', SystemRoot: 'C:\\Windows' });
});

test('git runs without GIT_* variables and without prompts', () => {
  const env = gitEnv({ PATH: '/bin', GIT_DIR: '/x', git_work_tree: '/y', GIT_TERMINAL_PROMPT: '1' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.git_work_tree, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('programs are found only in absolute PATH folders', async () => {
  await withTemp((dir) => {
    const name = process.platform === 'win32' ? 'tool.exe' : 'tool';
    write(dir, { [name]: '' });
    const separator = process.platform === 'win32' ? ';' : ':';
    assert.equal(findOnPath('tool', `.${separator}${dir}`), join(dir, name));
    assert.equal(findOnPath('tool', `.${separator}relative`), null);
    assert.equal(findOnPath('tool', undefined), null);
  });
});

test('npm is run through node and its own script when that script exists', () => {
  const found = resolveNpm({
    execPath: '/opt/node/bin/node',
    platform: 'linux',
    env: {},
    exists: (file) => file.replaceAll('\\', '/').endsWith('/lib/node_modules/npm/bin/npm-cli.js'),
  });
  assert.equal(found.command, '/opt/node/bin/node');
  assert.equal(found.shell, false);
  assert.equal(found.prefix.length, 1);
  assert.match(found.prefix[0].replaceAll('\\', '/'), /lib\/node_modules\/npm\/bin\/npm-cli\.js$/);
});

test('the script that started this one is preferred, then the fixed fallback', () => {
  const viaNpm = resolveNpm({ execPath: '/n/node', platform: 'linux', env: { npm_execpath: '/x/npm-cli.js' }, exists: () => true });
  assert.deepEqual(viaNpm.prefix, ['/x/npm-cli.js']);
  const windows = resolveNpm({ execPath: 'C:\\n\\node.exe', platform: 'win32', env: {}, exists: () => false });
  assert.deepEqual(windows, { command: 'npm.cmd', prefix: [], shell: true });
  const linux = resolveNpm({ execPath: '/n/node', platform: 'linux', env: {}, exists: () => false });
  assert.deepEqual(linux, { command: 'npm', prefix: [], shell: false });
});

// ---------------------------------------------------------------------------
// Isolation

test('a copy in a fresh directory has no leaks of its own', async () => {
  await withTemp((base) => {
    const copy = join(base, 'coffer');
    mkdirSync(copy);
    // Only the folders this test made are judged; the machine's own ancestors are not its business.
    assert.deepEqual(findLeaks(copy, repository).filter((problem) => problem.includes(base)), []);
  });
});

test('a copy inside the repository is reported', () => {
  const problems = findLeaks(join(repository, 'coffer'), repository);
  assert.ok(problems.some((problem) => /is inside the repository/.test(problem)), problems.join('\n'));
});

test('repository content next to the copy, and a node_modules above it, are reported', async () => {
  await withTemp((base) => {
    const copy = join(base, 'coffer');
    mkdirSync(copy);
    write(base, { 'site-spec.md': '', 'content/a.md': '', 'node_modules/dep/index.js': '', 'package.json': '{}' });
    const problems = findLeaks(copy, repository).filter((problem) => problem.includes(base));
    for (const name of ['site-spec.md', 'content', 'node_modules', 'package.json']) {
      assert.ok(problems.some((problem) => problem.includes(join(base, name))), `${name} not reported`);
    }
  });
});

test('entries that neither come from coffer/ nor from npm are foreign', () => {
  const source = ['package.json', 'src', 'example'];
  assert.deepEqual(foreignEntries(['package.json', 'src', 'example', 'node_modules', 'package-lock.json'], source), []);
  assert.deepEqual(foreignEntries(['package.json', 'content', 'site-spec.md'], source), ['content', 'site-spec.md']);
});

// ---------------------------------------------------------------------------
// Clean-up

test('removeTree removes a whole tree', async () => {
  await withTemp((dir) => {
    const tree = join(dir, 'tree');
    write(tree, { 'a/b/c.txt': 'x', 'd.txt': 'y' });
    removeTree(tree);
    assert.equal(existsSync(tree), false);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('removeTree retries, so a briefly locked file on Windows does not fail it', () => {
  /** @type {import('node:fs').RmOptions[]} */
  const calls = [];
  removeTree('/some/dir', (path, options) => {
    calls.push(options);
    assert.equal(path, '/some/dir');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recursive, true);
  assert.equal(calls[0].force, true);
  assert.ok((calls[0].maxRetries ?? 0) >= 5);
  assert.ok((calls[0].retryDelay ?? 0) > 0);
});

// ---------------------------------------------------------------------------
// Wiring

test('the root package.json has the script, and the slow check is not part of npm test', () => {
  const pkg = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:standalone'], 'node scripts/check-coffer-standalone.mjs');
  assert.doesNotMatch(pkg.scripts.test, /standalone/);
  assert.doesNotMatch(pkg.scripts['test:scripts'], /standalone/);
  assert.ok(existsSync(script));
});
