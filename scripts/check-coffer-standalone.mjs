#!/usr/bin/env node
// Proves that the coffer engine builds and tests from its own directory alone.
//
// The script copies `coffer/` to a fresh directory under the system's
// temporary directory, where nothing of this repository (its content, its site
// configuration, its lock file, its node_modules) can be reached, and runs
// `npm install` and `npm test` there, then builds the example site and checks
// its output. It exits with 0 when everything passes.
//
// The copy contains exactly what git would put in a clone of coffer: the files
// that are tracked or not ignored, so the ignore rules in `coffer/.gitignore`
// decide. When git is not available a short built-in list of ignored paths is
// used instead (see FALLBACK_EXCLUDED).
//
// The copy gets no lock file. The lock file in this repository belongs to the
// npm workspace as a whole and is not part of `coffer/`, so `npm install`
// resolves the dependencies from the registry, as a fresh clone without a lock
// file would. That is why the check needs the network.
//
// This is slow (an install and a full test run), so it is not part of
// `npm test`. Run it with `npm run check:standalone`.
//
// Options:
//   --keep   keep the temporary directory and print its location
//   --help   show this text

import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** How long one command (an install or the tests) may run, in milliseconds. */
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/** How long `git ls-files` may run, in milliseconds. */
const GIT_TIMEOUT_MS = 60 * 1000;

/**
 * Paths that are never copied, whatever git says. They are also the ignore
 * rules used when git is unavailable. A name without a slash matches at any
 * depth; a path with slashes matches from the root of `coffer/`. This mirrors
 * `coffer/.gitignore`, and a test keeps the two in step.
 */
export const FALLBACK_EXCLUDED = Object.freeze(['node_modules', '.git', '.cache', '.coffer', 'example/dist']);

/**
 * Environment variables the commands in the copy may see (compared without
 * regard to case, as Windows does). Everything else is dropped: secrets such
 * as `COFFER_MEDIA_*` and tokens, `NODE_OPTIONS` and `NODE_PATH` (which could
 * reach code outside the copy) and the `npm_*` variables npm sets for the
 * script that started this one (which could point npm back at the workspace).
 */
const ENV_ALLOWED = new Set(
  [
    // Finding programs and the system.
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'PROGRAMW6432',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
    // The user's home and the npm cache and configuration that live there.
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USER', 'USERNAME',
    'LOGNAME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
    // Temporary files, terminal and language.
    'TMP', 'TEMP', 'TMPDIR', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'LANG', 'LANGUAGE',
    'LC_ALL', 'LC_CTYPE', 'TZ',
    // Reaching the registry from behind a proxy or with a private certificate authority.
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ].map((name) => name.toUpperCase()),
);

/** Names npm keeps for its own, which must not leak into the copy. */
const ENV_DENIED_PREFIXES = ['NPM_', 'COFFER_'];

/**
 * The environment for the commands that run in the copy.
 *
 * @param {Record<string, string | undefined>} base The environment to filter, usually `process.env`.
 * @returns {Record<string, string>}
 */
export function sanitizedEnv(base) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    const name = key.toUpperCase();
    if (value === undefined) continue;
    if (ENV_DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (ENV_ALLOWED.has(name)) env[key] = value;
  }
  return env;
}

/**
 * The environment for git: the process's own without any `GIT_*` variable
 * (which could point git at another repository), and with prompts off.
 *
 * @param {Record<string, string | undefined>} base
 * @returns {Record<string, string>}
 */
export function gitEnv(base) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.toUpperCase().startsWith('GIT_')) continue;
    env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/**
 * Finds a program in the absolute folders of a `PATH` value. A relative or
 * empty entry is skipped, so that a program in the current folder is never run
 * by accident.
 *
 * @param {string} name Program name without an extension.
 * @param {string | undefined} pathValue
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null} The absolute path, or null when it is not found.
 */
export function findOnPath(name, pathValue, platform = process.platform) {
  const windows = platform === 'win32';
  const names = windows ? [`${name}.exe`, `${name}.com`] : [name];
  for (const raw of (pathValue ?? '').split(windows ? ';' : delimiter)) {
    const folder = windows ? raw.trim().replace(/^"(.*)"$/, '$1') : raw;
    if (folder === '' || !isAbsolute(folder)) continue;
    for (const candidate of names) {
      const file = join(folder, candidate);
      try {
        if (lstatSync(file).isFile()) return file;
      } catch {
        // Not in this folder.
      }
    }
  }
  return null;
}

/**
 * The value of `PATH` in an environment object, whatever the case of the key.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
function pathOf(env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? undefined : env[key];
}

/**
 * Whether a path (relative to `coffer/`, with `/` separators) is one that is
 * never copied.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isExcluded(path) {
  const parts = path.split('/');
  return FALLBACK_EXCLUDED.some((rule) =>
    rule.includes('/')
      ? path === rule || path.startsWith(`${rule}/`)
      : parts.includes(rule),
  );
}

/**
 * @typedef {object} Selection
 * @property {string[]} files Regular files to copy, relative to `coffer/` with `/` separators, sorted.
 * @property {'git' | 'fallback'} method How the list was made.
 * @property {string} [note] Why the fallback was used.
 */

/**
 * Lists the files of a directory with git: tracked files plus untracked ones
 * that are not ignored, which is what a commit of the working tree would hold.
 *
 * @param {string} directory
 * @param {Record<string, string | undefined>} env The process environment.
 * @returns {{ files: string[] } | { error: string }}
 */
function listWithGit(directory, env) {
  const git = findOnPath('git', pathOf(env));
  if (git === null) return { error: 'git was not found on the PATH' };
  const result = spawnSync(
    git,
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: directory,
      env: gitEnv(env),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) return { error: `git could not be run: ${result.error.message}` };
  if (result.status !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? '';
    return { error: `git ls-files failed (${detail || `exit code ${result.status}`})` };
  }
  return { files: result.stdout.split('\0').filter((entry) => entry !== '') };
}

/**
 * Lists the regular files under a directory, skipping the excluded paths.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function walk(directory) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(directory, full).split(sep).join('/');
      if (isExcluded(rel)) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(rel);
    }
  };
  visit(directory);
  return files;
}

/**
 * Chooses the files of `coffer/` that go into the copy.
 *
 * @param {string} directory The `coffer/` directory.
 * @param {Record<string, string | undefined>} [env] The process environment.
 * @param {{ useGit?: boolean }} [options] `useGit: false` forces the fallback.
 * @returns {Selection}
 */
export function selectFiles(directory, env = process.env, { useGit = true } = {}) {
  /** @type {string | undefined} */
  let note;
  /** @type {string[] | undefined} */
  let listed;
  if (useGit) {
    const result = listWithGit(directory, env);
    if ('files' in result) listed = result.files;
    else note = result.error;
  } else {
    note = 'git was not used';
  }
  if (listed === undefined) {
    return { files: walk(directory).sort(), method: 'fallback', note };
  }
  // The exclusion list is applied to git's answer too, so that a tracked file
  // under node_modules or example/dist (never meant to be there) is left out.
  const files = [...new Set(listed)].filter((file) => {
    if (isExcluded(file)) return false;
    try {
      return lstatSync(join(directory, file)).isFile();
    } catch {
      return false; // Listed by git but deleted or not a regular file.
    }
  });
  return { files: files.sort(), method: 'git' };
}

/**
 * Copies files, keeping their relative paths.
 *
 * @param {string} from
 * @param {string} to
 * @param {string[]} files Relative paths with `/` separators.
 */
export function copyFiles(from, to, files) {
  for (const file of files) {
    const target = join(to, ...file.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, ...file.split('/')), target);
  }
}

/**
 * Removes a directory tree. On Windows a freshly stopped process can still
 * hold a file for a moment and `rm` fails with ENOTEMPTY or EBUSY, so it is
 * retried a few times.
 *
 * @param {string} directory
 * @param {(path: string, options: import('node:fs').RmOptions) => void} [remove]
 */
export function removeTree(directory, remove = rmSync) {
  remove(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * @param {string} path
 * @param {string} parent
 * @returns {boolean} Whether `path` is `parent` or inside it.
 */
function isInside(path, parent) {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Looks for ways the copy could reach anything outside itself, and returns one
 * message per problem found (none means the copy is isolated):
 *
 * - it must not be inside the repository, nor the repository inside it;
 * - no folder above it may hold a `package.json` or a `node_modules`, which
 *   Node would find by walking up;
 * - the repository's own files (its content and site configuration) must not
 *   be reachable as siblings or parents of the copy.
 *
 * @param {string} copy The directory holding the copy.
 * @param {string} repository The root of this repository.
 * @returns {string[]}
 */
export function findLeaks(copy, repository) {
  /** @type {string[]} */
  const problems = [];
  const copyReal = realpathSync(copy);
  const repoReal = realpathSync(repository);
  if (isInside(copyReal, repoReal)) problems.push(`the copy ${copyReal} is inside the repository ${repoReal}`);
  if (isInside(repoReal, copyReal)) problems.push(`the repository ${repoReal} is inside the copy ${copyReal}`);
  // What `../` reaches from the copy: nothing of the repository may be there.
  const parent = dirname(copyReal);
  for (const name of ['site-spec.md', 'content', 'coffer.yaml', '.claude']) {
    if (existsSync(join(parent, name))) problems.push(`${join(parent, name)} is reachable from the copy`);
  }
  // Node and npm look for package.json and node_modules in every folder above.
  for (let dir = parent; ; dir = dirname(dir)) {
    for (const name of ['package.json', 'package-lock.json', 'node_modules']) {
      if (existsSync(join(dir, name))) problems.push(`${join(dir, name)} is reachable from the copy`);
    }
    if (dirname(dir) === dir) break;
  }
  return problems;
}

/**
 * Names in a directory that are neither in `coffer/` nor made by the commands
 * run in the copy: they would have come from somewhere else.
 *
 * @param {string[]} copied Top-level names in the copy.
 * @param {string[]} source Top-level names in `coffer/`.
 * @returns {string[]}
 */
export function foreignEntries(copied, source) {
  const generated = new Set(['node_modules', 'package-lock.json', '.cache', '.coffer']);
  const known = new Set([...source, ...generated]);
  return copied.filter((name) => !known.has(name)).sort();
}

/**
 * How to run npm without a shell where possible. On Windows `npm.cmd` cannot
 * be started directly, so npm's own script is run with the current Node.
 *
 * @param {object} context
 * @param {string} context.execPath The running Node (`process.execPath`).
 * @param {NodeJS.Platform} context.platform
 * @param {Record<string, string | undefined>} context.env The process environment (for `npm_execpath`).
 * @param {(path: string) => boolean} context.exists
 * @returns {{ command: string, prefix: string[], shell: boolean }}
 */
export function resolveNpm({ execPath, platform, env, exists }) {
  const candidates = [
    env.npm_execpath ?? '',
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const script = candidates.find((file) => file.endsWith('npm-cli.js') && exists(file));
  if (script !== undefined) return { command: execPath, prefix: [script], shell: false };
  // The arguments given to this are fixed words, never paths or user input,
  // so the shell has nothing to interpret.
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], shell: platform === 'win32' };
}

/**
 * @typedef {object} Options
 * @property {boolean} keep Keep the temporary directory.
 * @property {boolean} help Show the usage and stop.
 */

/** Thrown for a command line that cannot be used. */
export class UsageError extends Error {}

/**
 * @param {string[]} argv The arguments after the script name.
 * @returns {Options}
 * @throws {UsageError}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = { keep: false, help: false };
  for (const arg of argv) {
    if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return options;
}

const USAGE = [
  'Usage: node scripts/check-coffer-standalone.mjs [--keep]',
  '',
  'Copies coffer/ to a fresh temporary directory, installs its dependencies',
  'there, runs its tests and builds and checks its example site, to prove that',
  'the engine works without the rest of this repository.',
  '',
  '  --keep   keep the temporary directory and print where it is',
  '  --help   show this text',
  '',
].join('\n');

/** A failed step, with a message for the person running the script. */
class StepError extends Error {}

/**
 * Runs a program in a directory with the output shown, and waits for it.
 *
 * @param {string} title What is being run, for the messages.
 * @param {{ command: string, prefix: string[], shell: boolean }} program
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string> }} where
 * @returns {Promise<void>}
 */
function runProgram(title, program, args, { cwd, env }) {
  console.log(`\n> ${title}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program.command, [...program.prefix, ...args], {
      cwd,
      env,
      stdio: 'inherit',
      shell: program.shell,
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
    });
    child.on('error', (error) => reject(new StepError(`${title}: could not start (${error.message})`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new StepError(`${title}: failed (${signal === null ? `exit code ${code}` : `stopped by ${signal}`})`));
    });
  });
}

/**
 * Runs the check.
 *
 * @param {Options} options
 * @returns {Promise<void>}
 * @throws {StepError} A step failed.
 */
export async function run({ keep }) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = join(repository, 'coffer');
  if (!existsSync(join(source, 'package.json'))) throw new StepError(`${source} has no package.json`);

  const selection = selectFiles(source);
  if (selection.method === 'fallback') {
    console.log(`Using the built-in ignore list (${selection.note}).`);
  }
  if (selection.files.length === 0 || !selection.files.includes('package.json')) {
    throw new StepError('the list of files to copy is empty or has no package.json');
  }
  console.log(`Selected ${selection.files.length} files from coffer/ (${selection.method}).`);

  const base = mkdtempSync(join(tmpdir(), 'coffer-standalone-'));
  const copy = join(base, 'coffer');
  const cleanUp = () => {
    if (keep) return;
    try {
      removeTree(base);
    } catch (error) {
      console.error(`Could not remove ${base}: ${error instanceof Error ? error.message : error}`);
    }
  };
  // Ctrl-C stops the child commands too; still remove the copy.
  const onInterrupt = () => {
    cleanUp();
    process.exit(130);
  };
  process.once('SIGINT', onInterrupt);

  try {
    mkdirSync(copy);
    copyFiles(source, copy, selection.files);
    console.log(`Copied to ${copy}`);

    const leaks = findLeaks(copy, repository);
    if (leaks.length > 0) throw new StepError(`the copy is not isolated:\n  ${leaks.join('\n  ')}`);

    const env = sanitizedEnv(process.env);
    const npm = resolveNpm({ execPath: process.execPath, platform: process.platform, env: process.env, exists: existsSync });
    const where = { cwd: copy, env };

    // No lock file in the copy (see the top of this file), so this is a plain install.
    await runProgram('npm install', npm, ['install', '--no-audit', '--no-fund'], where);
    await runProgram('npm test', npm, ['test'], where);

    // `npm test` builds the example into temporary directories; build it into
    // the copy as well, to see the output where a user would look for it.
    await runProgram('npm run example', npm, ['run', 'example'], where);
    const output = join(copy, 'example', 'dist', 'workshop');
    if (!existsSync(join(output, 'journal', 'index.html'))) {
      throw new StepError(`the example build did not produce its blog index in ${output}`);
    }
    const node = { command: process.execPath, prefix: [], shell: false };
    await runProgram(
      'coffer check',
      node,
      ['bin/coffer.js', 'check', '--config', 'example/coffer.yaml', '--out', 'example/dist'],
      where,
    );

    const foreign = foreignEntries(readdirSync(copy), readdirSync(source));
    if (foreign.length > 0) throw new StepError(`the copy has entries that are not from coffer/: ${foreign.join(', ')}`);
    if (!isInside(realpathSync(output), realpathSync(copy))) throw new StepError('the example output is outside the copy');
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    cleanUp();
    if (keep) console.log(`\nKept ${base}`);
  }
  console.log(
    `\nOK: coffer installs, passes its tests, and builds and checks its example site from ${selection.files.length} files, without the rest of this repository.`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
    } else {
      await run(options);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  }
}
