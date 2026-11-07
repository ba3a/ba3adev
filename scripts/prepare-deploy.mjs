// Makes the built sites ready for Cloudflare Pages. The deploy workflow runs it between the checks
// and the upload:
//
//   node scripts/prepare-deploy.mjs [--dist <dir>] [--headers <file>] [--config <coffer.yaml>]
//
// For every site of the configuration it
//   - removes the files that must not be deployed (coffer's DEPLOY_EXCLUDES, the build manifest),
//   - copies the headers file (deploy/_headers) to the root of the site as `_headers`, because
//     coffer writes no headers file of its own.
//
// It stops with a message and exit code 1 when a site was not built, when the output already has a
// `_headers` that differs from the headers file (coffer started to write one; the two must be merged
// by a person), or when the headers file is missing. A second run on the same output is harmless. Nothing here talks to the network or reads a secret.
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEPLOY_EXCLUDES } from '../node_modules/coffer/src/build.js';
import { loadConfig } from '../node_modules/coffer/src/config.js';

/** The root of this repository. */
const repository = fileURLToPath(new URL('..', import.meta.url));

/** The name Cloudflare Pages reads response headers from. */
export const HEADERS_FILE_NAME = '_headers';

/** Cloudflare Pages ignores a `_headers` file with more rules than this. */
export const MAX_HEADER_RULES = 100;

/** Cloudflare Pages ignores a header rule line longer than this. */
export const MAX_HEADER_LINE_LENGTH = 2000;

/**
 * Raised for a problem the person running the deployment has to fix.
 */
export class DeployPrepareError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'DeployPrepareError';
  }
}

/**
 * Checks a headers file against the limits of Cloudflare Pages, which ignores a file that breaks
 * them without saying so.
 *
 * @param {string} text
 * @returns {string[]} The problems found; empty for a usable file.
 */
export function lintHeaders(text) {
  /** @type {string[]} */
  const problems = [];
  let rules = 0;
  let inRule = false;
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `line ${index + 1}`;
    if (line.length > MAX_HEADER_LINE_LENGTH) problems.push(`${where}: longer than ${MAX_HEADER_LINE_LENGTH} characters`);
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    if (/^\s/.test(line)) {
      if (!inRule) problems.push(`${where}: a header with no path above it`);
      if (!/^\s+!?\s*[A-Za-z0-9-]+(:\s*\S.*)?$/.test(line)) problems.push(`${where}: not a header line`);
    } else {
      rules += 1;
      inRule = true;
      if (!/^(https?:\/\/\S+|\/\S*)$/.test(line)) problems.push(`${where}: a path must start with "/" or be an address`);
    }
  });
  if (rules > MAX_HEADER_RULES) problems.push(`${rules} rules; Cloudflare Pages reads at most ${MAX_HEADER_RULES}`);
  return problems;
}

/**
 * @typedef {object} PrepareDeployOptions
 * @property {string} distDir The output root; each site is in `{distDir}/{siteId}`.
 * @property {string} headersFile The headers file to publish.
 * @property {string[]} siteIds
 * @property {(line: string) => void} [log]
 */

/**
 * Prepares the output of every site for upload.
 *
 * @param {PrepareDeployOptions} options
 * @returns {void}
 * @throws {DeployPrepareError}
 */
export function prepareDeploy({ distDir, headersFile, siteIds, log = () => {} }) {
  if (!existsSync(headersFile) || !statSync(headersFile).isFile()) {
    throw new DeployPrepareError(`the headers file ${headersFile} does not exist`);
  }
  const problems = lintHeaders(readFileSync(headersFile, 'utf8'));
  if (problems.length > 0) {
    throw new DeployPrepareError(`the headers file ${headersFile} would be ignored by Cloudflare Pages:\n  ${problems.join('\n  ')}`);
  }
  if (siteIds.length === 0) throw new DeployPrepareError('no site to prepare');

  for (const id of siteIds) {
    const siteDir = join(distDir, id);
    if (!existsSync(join(siteDir, 'index.html')) && !existsSync(join(siteDir, '404.html'))) {
      throw new DeployPrepareError(`${siteDir} holds no built site; run "npm run build" first`);
    }
    const target = join(siteDir, HEADERS_FILE_NAME);
    // A copy of our own file from an earlier run is fine; anything else was written by the build.
    if (existsSync(target) && readFileSync(target, 'utf8') !== readFileSync(headersFile, 'utf8')) {
      throw new DeployPrepareError(
        `${siteDir} already has a ${HEADERS_FILE_NAME} file, written by the build. Merge it with ${headersFile} instead of overwriting one with the other.`,
      );
    }
    for (const name of DEPLOY_EXCLUDES) {
      rmSync(join(siteDir, name), { force: true });
    }
    copyFileSync(headersFile, target);
    log(`${id}: removed ${DEPLOY_EXCLUDES.join(', ')}, wrote ${HEADERS_FILE_NAME}`);
  }
}

/**
 * @param {string[]} args
 * @returns {{ dist: string, headers: string, config: string } | { error: string }}
 */
export function parseArgs(args) {
  const options = {
    dist: resolve('dist'),
    headers: join(repository, 'deploy', HEADERS_FILE_NAME),
    config: join(repository, 'coffer.yaml'),
  };
  /** @type {Record<string, 'dist' | 'headers' | 'config'>} */
  const valued = { '--dist': 'dist', '--headers': 'headers', '--config': 'config' };
  for (let i = 0; i < args.length; i += 2) {
    const key = valued[args[i]];
    if (key === undefined) return { error: `unexpected argument "${args[i]}"` };
    const value = args[i + 1];
    if (value === undefined || value === '') return { error: `${args[i]} needs a value` };
    options[key] = resolve(value);
  }
  return options;
}

// Run as a script (not when a test imports it).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if ('error' in options) {
    console.error(`prepare-deploy: ${options.error}`);
    process.exit(2);
  }
  try {
    const config = loadConfig({ configPath: options.config });
    prepareDeploy({
      distDir: options.dist,
      headersFile: options.headers,
      siteIds: config.sites.map((site) => site.id),
      log: (line) => console.log(`prepare-deploy: ${line}`),
    });
  } catch (error) {
    console.error(`prepare-deploy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
