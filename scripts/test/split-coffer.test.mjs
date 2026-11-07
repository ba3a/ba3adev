// Tests for scripts/split-coffer.sh. Every run happens in a throwaway repository under the system's
// temporary directory, never in this repository. No test passes --push: the push is checked by
// reading the script, which must reach `git push` only behind that option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repository, 'scripts', 'split-coffer.sh');
const scriptText = readFileSync(script, 'utf8');

/** @returns {Record<string, string>} The environment for git and sh: no GIT_* variable, no user configuration. */
function environment() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.org',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.org',
  };
}

/** @returns {string} The POSIX shell to run the script with. */
function findShell() {
  const candidates = ['sh'];
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8', env: environment() });
  if (exec.status === 0) {
    // Git for Windows: <git>/mingw64/libexec/git-core, and <git>/bin/sh.exe is next to the git folder.
    const gitRoot = dirname(dirname(dirname(exec.stdout.trim())));
    candidates.push(join(gitRoot, 'bin', 'sh.exe'), join(gitRoot, 'usr', 'bin', 'sh.exe'));
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'exit 0'], { env: environment() });
    if (probe.status === 0) return candidate;
  }
  throw new Error('no POSIX sh found (install Git for Windows or put sh on the PATH)');
}

const shell = findShell();

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} The trimmed standard output of git.
 */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: environment() });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * @param {string} cwd
 * @param {string[]} args Arguments for the script.
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function split(cwd, args = []) {
  const result = spawnSync(shell, [script, ...args], { cwd, encoding: 'utf8', env: environment() });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * @param {string} repo
 * @param {Record<string, string>} files
 * @param {string} message
 */
function commit(repo, files, message) {
  for (const [name, content] of Object.entries(files)) {
    const target = join(repo, ...name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', message]);
}

/**
 * Makes a repository that looks like this one: files at the root, and coffer/ with its own history.
 *
 * @param {(repo: string) => void} body
 */
function withRepository(body) {
  const repo = mkdtempSync(join(tmpdir(), 'split-coffer-test-'));
  try {
    git(repo, ['init', '--quiet', '--initial-branch=main']);
    commit(repo, { 'package.json': '{"name":"site"}\n', 'coffer.yaml': 'sites: []\n' }, 'chore: Start the site');
    commit(repo, { 'coffer/package.json': '{"name":"coffer"}\n', 'coffer/src/index.js': 'export {};\n' }, 'feat: Add the engine');
    commit(repo, { 'content/post.md': 'text\n' }, 'docs: Add a post');
    commit(repo, { 'coffer/src/index.js': 'export const a = 1;\n', 'coffer/README.md': 'coffer\n' }, 'feat: Extend the engine');
    commit(repo, { 'coffer.yaml': 'sites: [a]\n' }, 'chore: Configure a site');
    body(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test('without options it makes a local branch with the files of coffer/ at its root and the history of those files', () => {
  withRepository((repo) => {
    const head = git(repo, ['rev-parse', 'HEAD']);
    // A remote that does not exist: the script must neither read nor change it.
    git(repo, ['remote', 'add', 'origin', join(repo, 'does-not-exist.git')]);
    const result = split(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Branch coffer-export: 2 commits/);
    assert.match(result.stdout, /Nothing was pushed/);

    assert.deepEqual(git(repo, ['ls-tree', '-r', '--name-only', 'coffer-export']).split('\n'), ['README.md', 'package.json', 'src/index.js']);
    assert.equal(git(repo, ['log', '--format=%s', 'coffer-export']), 'feat: Extend the engine\nfeat: Add the engine');
    assert.equal(git(repo, ['show', 'coffer-export:src/index.js']), 'export const a = 1;');

    // The repository itself is untouched.
    assert.equal(git(repo, ['rev-parse', 'HEAD']), head);
    assert.equal(git(repo, ['branch', '--show-current']), 'main');
    assert.equal(git(repo, ['status', '--porcelain']), '');
    assert.ok(existsSync(join(repo, 'coffer', 'package.json')), 'coffer/ stays');
    assert.equal(git(repo, ['branch', '--format=%(refname:short)']).split('\n').sort().join(','), 'coffer-export,main');
  });
});

test('a second run changes nothing, and a branch that points elsewhere is kept unless --replace is given', () => {
  withRepository((repo) => {
    assert.equal(split(repo).status, 0);
    const before = git(repo, ['rev-parse', 'coffer-export']);
    // A second run from a subdirectory, with the same history, changes nothing.
    const again = split(join(repo, 'content'));
    assert.equal(again.status, 0, again.stderr);
    assert.equal(git(repo, ['rev-parse', 'coffer-export']), before);
    commit(repo, { 'coffer/CHANGELOG.md': 'changes\n' }, 'docs: Add a changelog');

    const refused = split(repo);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /--replace/);
    assert.equal(git(repo, ['rev-parse', 'coffer-export']), before, 'the branch was not moved');

    const replaced = split(repo, ['--replace']);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(replaced.stdout, /3 commits/);
    assert.equal(git(repo, ['show', 'coffer-export:CHANGELOG.md']), 'changes');
  });
});

test('it refuses to run when the working tree has changes, and makes no branch', () => {
  for (const [label, dirty] of /** @type {[string, (repo: string) => void][]} */ ([
    ['a modified file', (repo) => writeFileSync(join(repo, 'coffer', 'README.md'), 'changed\n')],
    ['a staged file', (repo) => { writeFileSync(join(repo, 'new.txt'), 'x\n'); git(repo, ['add', 'new.txt']); }],
    ['an untracked file', (repo) => writeFileSync(join(repo, 'untracked.txt'), 'x\n')],
  ])) {
    withRepository((repo) => {
      dirty(repo);
      const result = split(repo);
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, /working tree has changes/, label);
      assert.equal(git(repo, ['branch', '--list', 'coffer-export']), '', `${label}: no branch`);
    });
  }
});

test('it refuses a repository without coffer/, an unknown option, and outside a repository', () => {
  const empty = mkdtempSync(join(tmpdir(), 'split-coffer-test-'));
  try {
    const outside = split(empty);
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /not inside a git repository/);

    git(empty, ['init', '--quiet', '--initial-branch=main']);
    commit(empty, { 'a.txt': 'a\n' }, 'chore: Start');
    const missing = split(empty);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no coffer\/ directory/);
  } finally {
    rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  withRepository((repo) => {
    const unknown = split(repo, ['--force']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown option: --force/);
    assert.match(unknown.stderr, /Usage:/);
    assert.equal(git(repo, ['branch', '--list', 'coffer-export']), '');
  });
});

test('--help shows the usage and does nothing else', () => {
  withRepository((repo) => {
    const result = split(repo, ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: sh scripts\/split-coffer\.sh \[--push\] \[--replace\]/);
    assert.equal(git(repo, ['branch', '--list', 'coffer-export']), '');
  });
});

test('the script is POSIX sh with LF line ends, and git push is reachable only behind --push', () => {
  assert.match(scriptText, /^#!\/bin\/sh\n/);
  assert.ok(!scriptText.includes('\r'), 'no carriage returns');
  const syntax = spawnSync(shell, ['-n', script], { encoding: 'utf8', env: environment() });
  assert.equal(syntax.status, 0, syntax.stderr);
  const code = scriptText.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  assert.doesNotMatch(code.join('\n'), /\[\[|\bfunction \w+|\bsource \S|<<<|\blocal |\becho -e/, 'no bash-only syntax');
  const pushes = code.filter((line) => /\bgit\b.*\bpush\b/.test(line));
  assert.equal(pushes.length, 1, 'a single git push');
  assert.doesNotMatch(pushes[0], /--force|\s-f\b|\+refs|:\+/, 'never a forced push');
  assert.match(scriptText, /push=0\n/, 'push is off by default');
  assert.match(scriptText, /--push\) push=1 ;;/);
  assert.match(scriptText, /if \[ "\$push" = 1 \]; then\n[^]*?\n\s+git push [^\n]*\nelse\n/, 'the push is inside the --push branch');
  assert.match(scriptText, /git subtree split --prefix="\$prefix" -b "\$branch"/);
  assert.match(scriptText, /^prefix=coffer$/m);
  assert.match(scriptText, /^branch=coffer-export$/m);
  assert.match(scriptText, /^url=https:\/\/github\.com\/ba3a\/coffer\.git$/m);
});

test('.gitattributes keeps shell scripts on LF', () => {
  assert.match(readFileSync(join(repository, '.gitattributes'), 'utf8'), /^\*\.sh text eol=lf$/m);
});
