// Combines the answers of `coffer rebuild-needed --json` for the sites into the one answer the
// scheduled refresh workflow needs: is a deployment needed?
//
// Usage: node scripts/refresh-decide.mjs <answer.json>...
//
// Both sites are built and deployed together by deploy.yml, so the answer is `true` when ANY site
// needs a rebuild. The result is written as `needed=true` or `needed=false` to the file named by
// $GITHUB_OUTPUT (when it is set), and a short report, one line per site and one per reason, goes
// to standard output.
//
// A file that is missing, is not JSON or does not have the shape of an answer is an error: the
// script exits with 1 and writes no output, so the job fails and nothing is deployed. "Could not
// tell" is never turned into "no" or "yes". (A failing `coffer rebuild-needed` has already stopped
// the job before this script runs, because the workflow runs it with `set -e`.)
//
// The messages in an answer come from the deployed build-info.json and from git, so they are
// treated as text to print and nothing more: control characters are replaced, and every line
// starts with a fixed prefix, so that no line can be read as a workflow command (`::name::`).
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {object} Answer
 * @property {boolean} needed
 * @property {string} site
 * @property {{ code: string, message: string }[]} reasons
 */

/**
 * @param {string} text
 * @returns {string} The text on one line, without control characters.
 */
function oneLine(text) {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

/**
 * @param {unknown} value A parsed answer.
 * @param {string} where Where it came from, for messages.
 * @returns {Answer}
 */
export function checkAnswer(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where}: the answer is not a JSON object`);
  }
  const answer = /** @type {Record<string, unknown>} */ (value);
  if (typeof answer.needed !== 'boolean') throw new Error(`${where}: "needed" is not a boolean`);
  if (typeof answer.site !== 'string' || answer.site === '') throw new Error(`${where}: "site" is not a string`);
  if (!Array.isArray(answer.reasons)) throw new Error(`${where}: "reasons" is not an array`);
  const reasons = answer.reasons.map((reason, index) => {
    const entry = /** @type {Record<string, unknown> | null} */ (reason);
    if (typeof entry !== 'object' || entry === null || typeof entry.code !== 'string' || typeof entry.message !== 'string') {
      throw new Error(`${where}: reason ${index + 1} has no "code" and "message"`);
    }
    return { code: entry.code, message: entry.message };
  });
  // "needed" and the reasons must agree: the engine says yes exactly when it has a reason.
  if (answer.needed !== reasons.length > 0) throw new Error(`${where}: "needed" and "reasons" disagree`);
  return { needed: answer.needed, site: answer.site, reasons };
}

/**
 * @param {string[]} files Files holding the JSON answer of one site each.
 * @returns {{ needed: boolean, report: string }}
 * @throws {Error} When a file cannot be read or is not an answer.
 */
export function decide(files) {
  if (files.length === 0) throw new Error('no answer files were given');
  /** @type {Answer[]} */
  const answers = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file}: cannot read the answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    answers.push(checkAnswer(parsed, file));
  }
  const lines = [];
  for (const answer of answers) {
    lines.push(`site ${oneLine(answer.site)}: ${answer.needed ? 'rebuild needed' : 'up to date'}`);
    for (const reason of answer.reasons) lines.push(`  - ${oneLine(reason.code)}: ${oneLine(reason.message)}`);
  }
  const needed = answers.some((answer) => answer.needed);
  lines.push(`deploy: ${needed ? 'yes' : 'no'}`);
  return { needed, report: `${lines.join('\n')}\n` };
}

/**
 * @param {string[]} args
 * @param {{ out?: (text: string) => void, err?: (text: string) => void, env?: Record<string, string | undefined> }} [io]
 * @returns {number} The exit code.
 */
export function main(args, { out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text), env = process.env } = {}) {
  if (args.length === 0 || args.some((arg) => arg.startsWith('--'))) {
    err('Usage: node scripts/refresh-decide.mjs <answer.json>...\n');
    return 2;
  }
  let result;
  try {
    result = decide(args);
  } catch (error) {
    err(`refresh: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  out(result.report);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `needed=${result.needed}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
