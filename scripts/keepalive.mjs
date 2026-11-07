// Keeps the scheduled workflows enabled.
//
// Usage: node scripts/keepalive.mjs [--always] <workflow-file.yml>...
//        (reads the repository from $GITHUB_REPOSITORY and the token from $GH_TOKEN for `gh`)
//
// Why: GitHub disables scheduled workflows of a public repository after 60 days without
// repository activity. The refresh workflow is scheduled, so a quiet period would silently stop
// the publishing of scheduled posts. For each workflow named on the command line this script
// calls `PUT /repos/{repository}/actions/workflows/{file}/enable` when
//
//   - the workflow is in the state `disabled_inactivity` (GitHub switched it off: turn it on), or
//   - today is the 1st of the month (UTC), or
//   - its `updated_at` is more than 30 days ago (or missing or unreadable), or
//   - `--always` is given.
//
// and otherwise leaves it alone. A workflow that somebody disabled by hand (`disabled_manually`)
// is never enabled: that is a decision, not an accident.
//
// This is best effort, and it is worth being honest about what it can do:
//
//   - Enabling an enabled workflow is harmless (the call is idempotent), so the rules above can
//     err on the side of calling it.
//   - The `updated_at` of a workflow is the time its definition last changed, and it may or may
//     not move when the workflow is enabled again. It is a heuristic for "nobody has touched this
//     for a while". If it does not move, the age rule fires on every run after 30 days, which
//     costs one idempotent API call per run. The 1st-of-month rule is the backstop that does not
//     depend on it.
//   - GitHub counts repository activity, in practice commits, for the 60-day rule. Whether a call
//     to the enable endpoint restarts that clock is not documented, so the monthly call cannot be
//     relied on alone: a real commit resets the clock for certain, and a workflow that GitHub did
//     disable can be turned on again by this script only if something still runs it (that is the
//     monthly keepalive.yml, which is a second scheduled workflow, and it can be disabled in the
//     same way; the Actions tab then offers "Enable workflow" by hand).
//
// Failures are loud: a missing workflow or a failing API call makes the script exit with 1 (every
// workflow is still tried), so the job is red and the owner is told. A skipped workflow is not a
// failure. The token is only ever in the environment of the `gh` process; it never appears in the
// output, and any text that came back from `gh` is scrubbed of it before it is printed.
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A workflow whose `updated_at` is older than this many days is enabled again. */
export const STALE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An error of the GitHub API, or of running `gh`.
 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ notFound?: boolean }} [options]
   */
  constructor(message, { notFound = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.notFound = notFound;
  }
}

/**
 * Runs `gh` with the given arguments (never through a shell).
 *
 * @typedef {(args: string[]) => Promise<{ status: number, stdout: string, stderr: string }>} GhRunner
 */

/** @type {GhRunner} */
async function runGh(args) {
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, { env: process.env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = /** @type {{ code?: unknown, stdout?: string, stderr?: string, message?: string }} */ (error);
    return {
      status: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? 'gh could not be run',
    };
  }
}

/**
 * The part of the GitHub API this script uses, on top of the `gh` command.
 *
 * @param {object} options
 * @param {string} options.repository `owner/name`.
 * @param {GhRunner} [options.run] Replaces the `gh` command (tests).
 */
export function createApi({ repository, run = runGh }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').some((part) => /^\.+$/.test(part))) throw new ApiError(`"${repository}" is not a repository name (owner/name)`);

  /**
   * @param {string[]} args
   * @param {string} what
   * @returns {Promise<string>}
   */
  async function call(args, what) {
    const result = await run(['api', ...args]);
    if (result.status !== 0) {
      const detail = `${result.stderr}${result.stdout}`.trim().split('\n')[0] ?? '';
      throw new ApiError(`${what} failed: ${detail}`, { notFound: /HTTP 404|Not Found/i.test(`${result.stderr}${result.stdout}`) });
    }
    return result.stdout;
  }

  return {
    /**
     * @param {string} file
     * @returns {Promise<{ state: string, updated_at?: string }>}
     */
    async getWorkflow(file) {
      const body = await call([`repos/${repository}/actions/workflows/${file}`], `reading ${file}`);
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        return parsed;
      } catch {
        throw new ApiError(`reading ${file} failed: the answer is not JSON`);
      }
    },

    /**
     * @param {string} file
     * @returns {Promise<void>}
     */
    async enableWorkflow(file) {
      await call(['-X', 'PUT', `repos/${repository}/actions/workflows/${file}/enable`], `enabling ${file}`);
    },
  };
}

/**
 * Whether to call the enable endpoint for a workflow.
 *
 * @param {object} options
 * @param {{ state?: string, updated_at?: string }} options.workflow What the API says about it.
 * @param {Date} options.now
 * @param {boolean} [options.always]
 * @returns {{ enable: boolean, reason: string }}
 */
export function shouldEnable({ workflow, now, always = false }) {
  if (workflow.state === 'disabled_manually') return { enable: false, reason: 'it was disabled by hand, which is left alone' };
  if (workflow.state === 'disabled_fork') return { enable: false, reason: 'it is disabled because this repository is a fork, which is left alone' };
  if (workflow.state === 'disabled_inactivity') return { enable: true, reason: 'GitHub disabled it for inactivity' };
  if (always) return { enable: true, reason: 'it was asked for' };
  if (now.getUTCDate() === 1) return { enable: true, reason: 'it is the 1st of the month' };
  const updated = Date.parse(workflow.updated_at ?? '');
  if (Number.isNaN(updated)) return { enable: true, reason: 'its last update is unknown' };
  const days = Math.floor((now.getTime() - updated) / DAY_MS);
  if (days > STALE_DAYS) return { enable: true, reason: `it was last updated ${days} days ago` };
  return { enable: false, reason: `it was updated ${Math.max(days, 0)} days ago and it is not the 1st of the month` };
}

/**
 * @typedef {object} Outcome
 * @property {string} workflow
 * @property {'enabled' | 'skipped' | 'failed'} result
 * @property {string} detail
 */

/**
 * @param {object} options
 * @param {ReturnType<typeof createApi>} options.api
 * @param {string[]} options.workflows File names, such as `refresh.yml`.
 * @param {Date} [options.now]
 * @param {boolean} [options.always]
 * @returns {Promise<Outcome[]>} One outcome per workflow; it never throws for an API failure.
 */
export async function keepAlive({ api, workflows, now = new Date(), always = false }) {
  /** @type {Outcome[]} */
  const outcomes = [];
  for (const workflow of workflows) {
    try {
      if (!/^[\w.-]+\.ya?ml$/.test(workflow)) throw new ApiError(`"${workflow}" is not a workflow file name`);
      const info = await api.getWorkflow(workflow);
      const decision = shouldEnable({ workflow: info, now, always });
      if (!decision.enable) {
        outcomes.push({ workflow, result: 'skipped', detail: decision.reason });
        continue;
      }
      await api.enableWorkflow(workflow);
      outcomes.push({ workflow, result: 'enabled', detail: decision.reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = error instanceof ApiError && error.notFound ? ' (the workflow does not exist in this repository)' : '';
      outcomes.push({ workflow, result: 'failed', detail: `${message}${missing}` });
    }
  }
  return outcomes;
}

/**
 * @param {string} text
 * @param {string[]} secrets
 * @returns {string} The text without any of the secrets and on one line.
 */
export function scrub(text, secrets) {
  let result = text;
  for (const secret of secrets) if (secret !== '') result = result.split(secret).join('***');
  return result.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/**
 * @param {string[]} args
 * @param {object} [services]
 * @param {Record<string, string | undefined>} [services.env]
 * @param {Date} [services.now]
 * @param {GhRunner} [services.run] Replaces the `gh` command (tests).
 * @param {(text: string) => void} [services.out]
 * @param {(text: string) => void} [services.err]
 * @returns {Promise<number>} The exit code: 0, 1 when a workflow could not be handled, 2 for a usage error.
 */
export async function main(args, { env = process.env, now = new Date(), run, out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text) } = {}) {
  const secrets = [env.GH_TOKEN, env.GITHUB_TOKEN].filter((value) => value !== undefined && value !== '');
  const always = args.includes('--always');
  const workflows = args.filter((arg) => arg !== '--always');
  if (workflows.length === 0 || workflows.some((arg) => arg.startsWith('-'))) {
    err('Usage: node scripts/keepalive.mjs [--always] <workflow-file.yml>...\n');
    return 2;
  }
  let api;
  try {
    api = createApi({ repository: env.GITHUB_REPOSITORY ?? '', run });
  } catch (error) {
    err(`keepalive: ${scrub(error instanceof Error ? error.message : String(error), secrets)}\n`);
    return 2;
  }
  const outcomes = await keepAlive({ api, workflows, now, always });
  let failed = false;
  for (const outcome of outcomes) {
    const line = `keepalive: ${outcome.workflow}: ${outcome.result}, ${scrub(outcome.detail, secrets)}\n`;
    if (outcome.result === 'failed') {
      failed = true;
      err(line);
    } else {
      out(line);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
