// The `prepare` script of the root package.json: runs after `npm install` in a working copy.
//
// - Installs the coffer git hooks (`coffer hooks install`), which keep the media originals in step
//   with git: the lock file is refreshed on commit, uploaded on push and fetched on checkout.
// - Fetches the originals the lock file lists (`coffer media pull`) when the credentials of the
//   media store are available.
//
// It never fails `npm install`: whatever goes wrong is reported on one line and the exit code is 0.
// Without credentials (the normal state of a fresh clone, before `.env.local` exists) the pull is
// skipped with a one-line notice. In CI nothing is done: the deploy workflow pulls the originals
// itself, and a CI checkout has no use for hooks.
//
// This is a Node script rather than shell in package.json, so that it behaves the same on Windows,
// Linux and macOS.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../coffer/src/config.js';
import { lookUpVariables } from '../coffer/src/media/credentials.js';
import { placeholdersOf } from '../coffer/src/media/s3-store.js';

/** The root of this repository. */
const repository = fileURLToPath(new URL('..', import.meta.url));

/** The prefix of every line this script prints. */
const PREFIX = 'prepare:';

/** How long one coffer command may take. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Whether the `CI` variable says this is a continuous integration run, as GitHub Actions and most other
 * providers set it.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isCi(env) {
  const value = (env.CI ?? '').trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

/**
 * @typedef {object} RunResult
 * @property {number | null} status The exit code, or null when the command did not run to its end.
 * @property {string} output Standard output and standard error together.
 */

/**
 * Runs the coffer command line.
 *
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string | undefined>, cofferBin: string }} where
 * @returns {RunResult}
 */
function runCoffer(args, { cwd, env, cofferBin }) {
  const result = spawnSync(process.execPath, [cofferBin, ...args], {
    cwd,
    env: /** @type {NodeJS.ProcessEnv} */ (env),
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `${result.error.message}\n` : ''}` };
}

/**
 * Looks up the variables the media store needs, in the environment and in `.env.local`, the way
 * `coffer media pull` does.
 *
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ media: boolean, missing: string[] }>} `media` is false when the configuration has no media block; `missing` names the variables that are set nowhere (always empty for a store that needs none).
 */
async function missingCredentials(root, env) {
  const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
  const store = config.media?.store;
  if (store === undefined) return { media: false, missing: [] };
  if (store.type !== 's3') return { media: true, missing: [] };
  const names = [...new Set([...placeholdersOf(store.endpoint), store.accessKeyIdEnv, store.secretAccessKeyEnv])];
  const found = await lookUpVariables(names, { env, configDir: config.dir });
  return { media: true, missing: found.missing };
}

/**
 * @typedef {object} PrepareOptions
 * @property {string} [root] The working copy (default: this repository).
 * @property {Record<string, string | undefined>} [env] The environment (default: the process's).
 * @property {(line: string) => void} [log] Receives each line the script prints.
 * @property {string} [cofferBin] The coffer program (default: the one in this repository).
 * @property {(args: string[], where: { cwd: string, env: Record<string, string | undefined>, cofferBin: string }) => RunResult} [run] Runs coffer; replaced by tests.
 */

/**
 * Does the work of the script.
 *
 * @param {PrepareOptions} [options]
 * @returns {Promise<void>}
 */
export async function prepare(options = {}) {
  const root = options.root ?? repository;
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => console.log(line));
  const cofferBin = options.cofferBin ?? join(repository, 'coffer', 'bin', 'coffer.js');
  const run = options.run ?? runCoffer;
  const where = { cwd: root, env, cofferBin };

  if (isCi(env)) return;
  // Installed as a dependency or from an archive: there is no repository to put hooks into.
  if (!existsSync(join(root, '.git'))) return;

  const hooks = run(['hooks', 'install'], where);
  if (hooks.status !== 0) {
    log(`${PREFIX} "coffer hooks install" failed, so the git hooks are not installed; run "npx coffer hooks install" to see why.`);
    const detail = hooks.output.trim();
    if (detail !== '') log(detail);
  }

  let media;
  let missing;
  try {
    ({ media, missing } = await missingCredentials(root, env));
  } catch (error) {
    log(`${PREFIX} the media originals were not fetched: ${firstLine(error)}`);
    return;
  }
  if (!media) return;
  if (missing.length > 0) {
    log(`${PREFIX} media originals not fetched: no credentials for the media store (missing: ${missing.join(', ')}); copy .env.local.example to .env.local, fill it in, and run "npx coffer media pull".`);
    return;
  }

  const pull = run(['media', 'pull'], where);
  if (pull.status !== 0) {
    log(`${PREFIX} "coffer media pull" failed; run "npx coffer media pull" to see why.`);
    const detail = pull.output.trim();
    if (detail !== '') log(detail);
  }
}

/**
 * @param {unknown} error
 * @returns {string} The first line of the message of an error.
 */
function firstLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0];
}

// Run as a script (not when a test imports it). Whatever happens, `npm install` must not fail.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await prepare();
  } catch (error) {
    console.log(`${PREFIX} skipped: ${firstLine(error)}`);
  }
}
