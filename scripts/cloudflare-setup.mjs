// One-off, idempotent setup of the Cloudflare side of the two sites.
//
// Usage: node scripts/cloudflare-setup.mjs [--dry-run] [--env-dir <directory>]
//
// What it creates, when it does not exist yet:
//
//   - the Cloudflare Pages projects `ba3a-dev` and `my-ba3a-dev` (direct upload projects, production
//     branch `main`; the deploy workflow uploads the built files, so there is no Git source),
//   - the custom domains `ba3a.dev` (on `ba3a-dev`) and `my.ba3a.dev` (on `my-ba3a-dev`),
//   - the private R2 bucket `ba3a-media` that holds the photo originals.
//
// It is run by hand, once, by the owner of the Cloudflare account. It is never run from CI.
//
// Credentials: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, read from the environment first and
// from the git-ignored `.env.local` next to `coffer.yaml` second (the same lookup `coffer media` uses).
// The token is only ever sent to api.cloudflare.com as a bearer token; it is never printed, and any
// text that came back from the API is scrubbed of it before it is shown.
//
// `--dry-run` writes nothing:
//
//   - Without credentials it prints the whole plan and makes no network call at all ("plan only;
//     existing resources not checked").
//   - With credentials it makes read (GET) calls only, to compare the plan with what exists, and says
//     "would create" or "already exists" for each item.
//
// Idempotence: every item is looked up first, and only what is missing is created. A creation that
// the API refuses with an "already exists" answer (a race, or a lookup that missed it) counts as
// success only after the listing is read again and shows the item in the expected place; a domain
// that is "already in use" by another project is a failure. Running the script twice therefore
// changes nothing the second time.
//
// Custom domains: the script attaches the domain to the Pages project, nothing more. The domain
// stays "pending" until Cloudflare has validated it, which usually takes a few minutes. The script
// does not create or check DNS records. If a domain is still pending after a few minutes, open the
// zone `ba3a.dev` under DNS > Records: there must be a proxied CNAME record from the host (`@` for
// `ba3a.dev`, `my` for `my.ba3a.dev`) to `<project>.pages.dev`; create it if it is missing. That is
// why the token list below includes Zone DNS Edit.
//
// R2: a bucket is private by default. This script neither enables the public `r2.dev` address nor
// attaches a custom domain, so the originals can only be read with an S3 API token.
//
// Exit codes: 0 when done or nothing to do, 1 when something failed, 2 for a usage error.
import { fileURLToPath, pathToFileURL } from 'node:url';

import { lookUpVariables } from '../coffer/src/media/credentials.js';

/** The root of this repository, where `coffer.yaml` and `.env.local` live. */
const repository = fileURLToPath(new URL('..', import.meta.url));

/** The base of the Cloudflare REST API (version 4). */
export const API_BASE = 'https://api.cloudflare.com/client/v4';

/** The branch Pages treats as production. */
export const PRODUCTION_BRANCH = 'main';

/** The names of the variables that hold the credentials. */
export const TOKEN_VARIABLE = 'CLOUDFLARE_API_TOKEN';
export const ACCOUNT_VARIABLE = 'CLOUDFLARE_ACCOUNT_ID';

/**
 * What the sites need on Cloudflare.
 *
 * @typedef {object} Desired
 * @property {{ name: string, domain: string }[]} pages One Pages project per site, with its custom domain.
 * @property {string} bucket The R2 bucket for the photo originals.
 */

/** @type {Desired} */
export const DESIRED = {
  pages: [
    { name: 'ba3a-dev', domain: 'ba3a.dev' },
    { name: 'my-ba3a-dev', domain: 'my.ba3a.dev' },
  ],
  bucket: 'ba3a-media',
};

/** The most pages of a listing that are read before giving up. */
const MAX_LIST_PAGES = 50;

/** How long one API call may take. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * An error of the Cloudflare API, or of reaching it. The message never contains the token.
 */
export class CloudflareError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, codes?: number[] }} [details]
   */
  constructor(message, { status, codes = [] } = {}) {
    super(message);
    this.name = 'CloudflareError';
    /** @type {number | undefined} The HTTP status, when an answer came back. */
    this.status = status;
    /** @type {number[]} The Cloudflare error codes of the answer. */
    this.codes = codes;
  }
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
 * Whether a failed creation might only mean that the item exists already. This is a hint, not proof:
 * the caller must read the listing again and find the item before it counts as success (see
 * `applyPlan`).
 *
 * Known codes: 8000002 (Pages: a project with this name exists), 8000018 (Pages: the domain was added
 * before), 10004 (R2: the bucket exists). The wording is checked too, because the codes are not all
 * documented, and so is an HTTP 409 (a conflict). "Already in use" is deliberately not matched: it
 * says that something else holds the item, for example another Pages project holds the domain.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAlreadyExists(error) {
  if (!(error instanceof CloudflareError)) return false;
  if (error.codes.some((code) => code === 8000002 || code === 8000018 || code === 10004)) return true;
  return error.status === 409 || /already (exists?|added)(?![\w])/i.test(error.message);
}

// ---------------------------------------------------------------------------------------------
// The plan: a pure function from "what is wanted" and "what exists" to "what to do".
// ---------------------------------------------------------------------------------------------

/**
 * What exists on the account, or null when it was not looked up.
 *
 * @typedef {object} Existing
 * @property {string[]} projects Names of the Pages projects.
 * @property {Record<string, string[]>} domains Custom domains by Pages project (a project without an entry has none).
 * @property {string[]} buckets Names of the R2 buckets.
 */

/**
 * One thing the setup is about.
 *
 * @typedef {object} Action
 * @property {'pages-project' | 'pages-domain' | 'r2-bucket'} kind
 * @property {string} name The project name, the domain or the bucket name.
 * @property {string} [project] For a domain: the Pages project it belongs to.
 * @property {'create' | 'exists' | 'unknown'} state `unknown` when existing resources were not looked up.
 */

/**
 * Works out what has to be created. Projects come first, then their domains (a domain needs its
 * project), then the bucket.
 *
 * @param {Desired} desired
 * @param {Existing | null} existing Null when nothing was looked up: every state is then `unknown`.
 * @returns {Action[]}
 */
export function planSetup(desired, existing) {
  const projects = new Set((existing?.projects ?? []).map((name) => name.toLowerCase()));
  const buckets = new Set((existing?.buckets ?? []).map((name) => name.toLowerCase()));
  /** @param {string} project */
  const domainsOf = (project) => new Set((existing?.domains[project] ?? []).map((name) => name.toLowerCase()));
  /** @param {boolean} present @returns {Action['state']} */
  const state = (present) => (existing === null ? 'unknown' : present ? 'exists' : 'create');

  /** @type {Action[]} */
  const actions = [];
  for (const { name } of desired.pages) {
    actions.push({ kind: 'pages-project', name, state: state(projects.has(name.toLowerCase())) });
  }
  for (const { name, domain } of desired.pages) {
    actions.push({ kind: 'pages-domain', name: domain, project: name, state: state(domainsOf(name).has(domain.toLowerCase())) });
  }
  actions.push({ kind: 'r2-bucket', name: desired.bucket, state: state(buckets.has(desired.bucket.toLowerCase())) });
  return actions;
}

// ---------------------------------------------------------------------------------------------
// The Cloudflare API. Each endpoint is one small function with its path, so a change of the API
// is a change in one place. Responses are read tolerantly: unknown fields are ignored.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {typeof globalThis.fetch} Fetch
 */

/**
 * The part of the Cloudflare API this script uses.
 *
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.accountId
 * @param {Fetch} [options.fetch] Replaces the global `fetch` (tests).
 */
export function createApi({ token, accountId, fetch = globalThis.fetch }) {
  if (!/^[\w-]+$/.test(accountId)) throw new CloudflareError(`${ACCOUNT_VARIABLE} does not look like an account id`);
  const account = `/accounts/${accountId}`;
  const secrets = [token];
  /**
   * @param {string} text
   * @returns {string} The text without the token, with the account id masked like in the normal output.
   */
  const shown = (text) => scrub(text.split(accountId).join(maskAccount(accountId)), secrets);

  /**
   * One call. Resolves with the parsed `result` and `result_info`; rejects with a CloudflareError
   * whose message is free of the token.
   *
   * @param {'GET' | 'POST'} method
   * @param {string} path
   * @param {{ query?: Record<string, string>, body?: unknown }} [options]
   * @returns {Promise<{ result: unknown, info: Record<string, unknown> }>}
   */
  async function call(method, path, { query, body } = {}) {
    const url = `${API_BASE}${path}${query === undefined ? '' : `?${new URLSearchParams(query)}`}`;
    const what = shown(`${method} ${path}`);
    /** @type {Response} */
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CloudflareError(`${what} could not be sent: ${shown(reason)}`);
    }
    const text = await response.text();
    /** @type {{ success?: boolean, errors?: { code?: number, message?: string }[], result?: unknown, result_info?: Record<string, unknown> } | null} */
    let parsed = null;
    try {
      const value = JSON.parse(text);
      if (typeof value === 'object' && value !== null) parsed = value;
    } catch {
      // handled below
    }
    if (parsed === null) {
      throw new CloudflareError(`${what} failed: HTTP ${response.status}, and the answer is not JSON`, { status: response.status });
    }
    if (!response.ok || parsed.success === false) {
      const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
      const detail = errors.map((entry) => `${entry.code ?? '?'}: ${entry.message ?? 'no message'}`).join('; ') || 'no error details';
      const codes = errors.map((entry) => entry.code).filter((code) => typeof code === 'number');
      throw new CloudflareError(`${what} failed: HTTP ${response.status}: ${shown(detail)}`, { status: response.status, codes });
    }
    return { result: parsed.result, info: parsed.result_info ?? {} };
  }

  /**
   * @param {unknown} value
   * @returns {string[]} The `name` of each entry that has one.
   */
  const namesOf = (value) =>
    (Array.isArray(value) ? value : [])
      .map((entry) => (typeof entry === 'object' && entry !== null ? /** @type {{ name?: unknown }} */ (entry).name : undefined))
      .filter((name) => typeof name === 'string');

  return {
    /**
     * GET /accounts/{id}/pages/projects, paged with `page`. Reading stops at the last page, or when a
     * page brings nothing new (so an API that ignores `page` cannot make this loop).
     *
     * @returns {Promise<string[]>}
     */
    async listPagesProjects() {
      /** @type {Set<string>} */
      const names = new Set();
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        const { result, info } = await call('GET', `${account}/pages/projects`, { query: { page: String(page), per_page: '50' } });
        const before = names.size;
        for (const name of namesOf(result)) names.add(name);
        const totalPages = typeof info.total_pages === 'number' ? info.total_pages : undefined;
        if (names.size === before || (totalPages !== undefined && page >= totalPages)) break;
      }
      return [...names];
    },

    /**
     * POST /accounts/{id}/pages/projects. A direct upload project has no `source`.
     *
     * @param {string} name
     * @returns {Promise<void>}
     */
    async createPagesProject(name) {
      await call('POST', `${account}/pages/projects`, { body: { name, production_branch: PRODUCTION_BRANCH } });
    },

    /**
     * GET /accounts/{id}/pages/projects/{name}/domains. A project that does not exist has no domains.
     *
     * @param {string} project
     * @returns {Promise<string[]>}
     */
    async listPagesDomains(project) {
      try {
        const { result } = await call('GET', `${account}/pages/projects/${encodeURIComponent(project)}/domains`);
        return namesOf(result);
      } catch (error) {
        if (error instanceof CloudflareError && error.status === 404) return [];
        throw error;
      }
    },

    /**
     * POST /accounts/{id}/pages/projects/{name}/domains. This registers the domain with the project;
     * the DNS record is not created or checked here.
     *
     * @param {string} project
     * @param {string} domain
     * @returns {Promise<string | undefined>} The status the API reports (for example "pending").
     */
    async createPagesDomain(project, domain) {
      const { result } = await call('POST', `${account}/pages/projects/${encodeURIComponent(project)}/domains`, { body: { name: domain } });
      const status = typeof result === 'object' && result !== null ? /** @type {{ status?: unknown }} */ (result).status : undefined;
      return typeof status === 'string' ? status : undefined;
    },

    /**
     * GET /accounts/{id}/r2/buckets. The answer is `{ buckets: [...] }`, paged by `cursor`; a plain
     * array is accepted too.
     *
     * @returns {Promise<string[]>}
     */
    async listBuckets() {
      /** @type {Set<string>} */
      const names = new Set();
      /** @type {string | undefined} */
      let cursor;
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        const { result, info } = await call('GET', `${account}/r2/buckets`, { query: cursor === undefined ? { per_page: '100' } : { per_page: '100', cursor } });
        const entries = Array.isArray(result) ? result : /** @type {{ buckets?: unknown }} */ (result ?? {}).buckets;
        const before = names.size;
        for (const name of namesOf(entries)) names.add(name);
        const next = typeof info.cursor === 'string' && info.cursor !== '' ? info.cursor : undefined;
        if (next === undefined || next === cursor || names.size === before) break;
        cursor = next;
      }
      return [...names];
    },

    /**
     * POST /accounts/{id}/r2/buckets. No public access is requested, so the bucket is private.
     *
     * @param {string} name
     * @returns {Promise<void>}
     */
    async createBucket(name) {
      await call('POST', `${account}/r2/buckets`, { body: { name } });
    },
  };
}

/**
 * @typedef {ReturnType<typeof createApi>} Api
 */

/**
 * Looks up what exists (GET calls only).
 *
 * @param {Api} api
 * @param {Desired} desired
 * @returns {Promise<Existing>}
 */
export async function lookUpExisting(api, desired) {
  const projects = await api.listPagesProjects();
  const known = new Set(projects.map((name) => name.toLowerCase()));
  /** @type {Record<string, string[]>} */
  const domains = {};
  for (const { name } of desired.pages) {
    // A project that is not there has no domains; do not ask the API about it.
    domains[name] = known.has(name.toLowerCase()) ? await api.listPagesDomains(name) : [];
  }
  return { projects, domains, buckets: await api.listBuckets() };
}

/**
 * @typedef {object} Outcome
 * @property {Action} action
 * @property {'created' | 'already exists' | 'skipped' | 'failed'} result
 * @property {string} [detail]
 */

/**
 * Reads the listing again after a creation was refused as "already exists", and checks that the item
 * is really there: the project in the account, the domain on the expected project, the bucket in the
 * account.
 *
 * @param {Api} api
 * @param {Action} action
 * @returns {Promise<string | undefined>} Undefined when the item is there, otherwise why it does not count as existing.
 */
async function verifyPresent(api, action) {
  const wanted = action.name.toLowerCase();
  /** @param {string[]} names */
  const has = (names) => names.some((name) => name.toLowerCase() === wanted);
  try {
    if (action.kind === 'pages-project') {
      return has(await api.listPagesProjects()) ? undefined : `reported as existing, but ${action.name} is not in the list of Pages projects`;
    }
    if (action.kind === 'pages-domain') {
      return has(await api.listPagesDomains(action.project ?? ''))
        ? undefined
        : `reported as existing, but ${action.name} is not a domain of the Pages project ${action.project}; it may be attached to another project or account`;
    }
    return has(await api.listBuckets()) ? undefined : `reported as existing, but ${action.name} is not in the list of R2 buckets`;
  } catch (error) {
    return `the check that it exists failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Applies a plan: creates what is marked `create`. Never called for a dry run.
 *
 * @param {Api} api
 * @param {Action[]} plan
 * @param {(text: string) => string} [clean] Scrubs error text.
 * @returns {Promise<Outcome[]>}
 */
export async function applyPlan(api, plan, clean = (text) => text) {
  /** @type {Outcome[]} */
  const outcomes = [];
  /** @type {Set<string>} */
  const failedProjects = new Set();
  for (const action of plan) {
    if (action.state === 'exists') {
      outcomes.push({ action, result: 'already exists' });
      continue;
    }
    if (action.kind === 'pages-domain' && failedProjects.has(action.project ?? '')) {
      outcomes.push({ action, result: 'skipped', detail: `the Pages project ${action.project} could not be created` });
      continue;
    }
    try {
      /** @type {string | undefined} */
      let detail;
      if (action.kind === 'pages-project') await api.createPagesProject(action.name);
      else if (action.kind === 'pages-domain') detail = await api.createPagesDomain(action.project ?? '', action.name);
      else await api.createBucket(action.name);
      outcomes.push({ action, result: 'created', detail });
    } catch (error) {
      if (isAlreadyExists(error)) {
        // Trust the answer only when the listing shows the item where it is expected.
        const problem = await verifyPresent(api, action);
        if (problem === undefined) {
          outcomes.push({ action, result: 'already exists' });
          continue;
        }
        if (action.kind === 'pages-project') failedProjects.add(action.name);
        outcomes.push({ action, result: 'failed', detail: clean(`${error instanceof Error ? error.message : String(error)}; ${problem}`) });
        continue;
      }
      if (action.kind === 'pages-project') failedProjects.add(action.name);
      outcomes.push({ action, result: 'failed', detail: clean(error instanceof Error ? error.message : String(error)) });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/** The permissions the API token needs. */
export const TOKEN_PERMISSIONS = [
  'Account > Cloudflare Pages > Edit (create the Pages projects and attach the custom domains; also used by the deploy workflow)',
  'Account > Workers R2 Storage > Edit (create the bucket)',
  'Zone > DNS > Edit, for the zone ba3a.dev (to check, and if needed create, the CNAME records that point the custom domains to the Pages projects)',
  'Zone > Zone > Read, for the zone ba3a.dev, if Cloudflare asks for it when a domain is attached',
];

/**
 * @param {Action} action
 * @returns {string}
 */
function describe(action) {
  if (action.kind === 'pages-project') return `Pages project  ${action.name}  (direct upload, production branch ${PRODUCTION_BRANCH})`;
  if (action.kind === 'pages-domain') return `Pages domain   ${action.name}  on ${action.project}`;
  return `R2 bucket      ${action.name}  (private)`;
}

/**
 * @param {Action} action
 * @param {{ dryRun: boolean }} mode
 * @returns {string}
 */
function stateText(action, { dryRun }) {
  if (action.state === 'unknown') return 'planned';
  if (action.state === 'exists') return 'already exists';
  return dryRun ? 'would create' : 'create';
}

/**
 * The steps after the script, and the permissions it needed.
 *
 * @returns {string[]}
 */
export function nextStepsLines() {
  return [
    '',
    'Token permissions required (create the token at https://dash.cloudflare.com/profile/api-tokens, "Create Custom Token"):',
    ...TOKEN_PERMISSIONS.map((line) => `  - ${line}`),
    '',
    'Next steps:',
    '  1. Domain activation can take a few minutes: a custom domain stays "pending" until Cloudflare has validated it.',
    '     Check the status under Workers & Pages > the project > Custom domains. If a domain stays pending, open the zone ba3a.dev under DNS > Records:',
    '     there must be a proxied CNAME record from the host (ba3a.dev, or my for my.ba3a.dev) to <project>.pages.dev (ba3a-dev.pages.dev, my-ba3a-dev.pages.dev); create it if it is missing.',
    `  2. Create an R2 API token for the S3 credentials (R2 > Manage R2 API Tokens > Create API token, "Object Read & Write", limited to the bucket ${DESIRED.bucket}).`,
    '     Put its Access Key ID and Secret Access Key into the git-ignored .env.local as R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (see .env.local.example).',
    '  3. Create the four GitHub Actions secrets in the content repository: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.',
    '     The deploy workflow needs at least Account > Cloudflare Pages > Edit; one token with all the permissions above works for both.',
    '  4. Upload the photo originals to the bucket: "npx coffer media push" (the pre-push git hook does the same on every push).',
    '  5. Run the deploy workflow, then check https://ba3a.dev and https://my.ba3a.dev.',
    'The exact commands, in order, are in OPERATIONS.md (step 5 is this script and what follows it).',
  ];
}

const USAGE = 'Usage: node scripts/cloudflare-setup.mjs [--dry-run] [--env-dir <directory>]\n';

/**
 * @param {string} value
 * @returns {string} The id with its middle hidden.
 */
function maskAccount(value) {
  return value.length <= 8 ? '***' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * @param {string[]} args
 * @returns {{ dryRun: boolean, envDir: string } | { error: string } | { help: true }}
 */
function parseArguments(args) {
  let dryRun = false;
  let envDir = repository;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--env-dir') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) return { error: '--env-dir needs a directory' };
      envDir = value;
      index += 1;
    } else return { error: `unknown argument "${arg}"` };
  }
  return { dryRun, envDir };
}

/**
 * @typedef {object} Services
 * @property {Record<string, string | undefined>} [env]
 * @property {(names: string[], envDir: string) => Promise<{ values: Map<string, string>, missing: string[] }>} [readVariables] Looks the credentials up (tests replace it).
 * @property {Fetch} [fetch] Replaces the global `fetch` (tests).
 * @property {(text: string) => void} [out]
 * @property {(text: string) => void} [err]
 * @property {Desired} [desired]
 */

/**
 * @param {string[]} args
 * @param {Services} [services]
 * @returns {Promise<number>} The exit code.
 */
export async function main(args, services = {}) {
  const env = services.env ?? process.env;
  const out = services.out ?? ((text) => process.stdout.write(text));
  const err = services.err ?? ((text) => process.stderr.write(text));
  const desired = services.desired ?? DESIRED;
  const readVariables =
    services.readVariables ??
    ((names, envDir) => lookUpVariables(names, { env, configDir: envDir, warn: (message) => err(`cloudflare-setup: warning: ${message}\n`) }));

  const parsed = parseArguments(args);
  if ('help' in parsed) {
    out(USAGE);
    return 0;
  }
  if ('error' in parsed) {
    err(`cloudflare-setup: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { dryRun } = parsed;

  /** @type {{ values: Map<string, string>, missing: string[] }} */
  let found;
  try {
    found = await readVariables([TOKEN_VARIABLE, ACCOUNT_VARIABLE], parsed.envDir);
  } catch (error) {
    err(`cloudflare-setup: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const token = found.values.get(TOKEN_VARIABLE);
  const accountId = found.values.get(ACCOUNT_VARIABLE);
  const secrets = token === undefined ? [] : [token];
  const clean = (/** @type {string} */ text) => scrub(text, secrets);

  if (token === undefined || accountId === undefined) {
    if (!dryRun) {
      err(
        [
          `cloudflare-setup: ${found.missing.join(' and ')} ${found.missing.length === 1 ? 'is' : 'are'} not set.`,
          `Set ${found.missing.length === 1 ? 'it' : 'them'} in the environment, or in the git-ignored file .env.local next to coffer.yaml (see .env.local.example).`,
          'Run with --dry-run to see the plan without credentials.',
          ...nextStepsLines().slice(0, 6),
        ].join('\n') + '\n',
      );
      return 1;
    }
    out(`cloudflare-setup: dry run, plan only; existing resources not checked (${found.missing.join(', ')} not set, so no call is made to Cloudflare).\n`);
    for (const action of planSetup(desired, null)) out(`  ${describe(action)}\n`);
    out('Everything above is created when it does not exist yet; set the credentials to compare the plan with the account.\n');
    for (const line of nextStepsLines()) out(`${line}\n`);
    return 0;
  }

  /** @type {Api} */
  let api;
  try {
    api = createApi({ token, accountId, fetch: services.fetch });
  } catch (error) {
    err(`cloudflare-setup: ${clean(error instanceof Error ? error.message : String(error))}\n`);
    return 2;
  }

  out(`cloudflare-setup: ${dryRun ? 'dry run (read calls only)' : 'setup'} for account ${maskAccount(accountId)}\n`);
  /** @type {Existing} */
  let existing;
  try {
    existing = await lookUpExisting(api, desired);
  } catch (error) {
    err(`cloudflare-setup: cannot read the account: ${clean(error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }
  const plan = planSetup(desired, existing);

  if (dryRun) {
    for (const action of plan) out(`  ${stateText(action, { dryRun })}: ${describe(action)}\n`);
    const pending = plan.filter((action) => action.state === 'create').length;
    out(pending === 0 ? 'Nothing to do: everything exists already.\n' : `${pending} item(s) would be created. Run without --dry-run to create them.\n`);
    for (const line of nextStepsLines()) out(`${line}\n`);
    return 0;
  }

  const outcomes = await applyPlan(api, plan, clean);
  let failed = false;
  for (const { action, result, detail } of outcomes) {
    const suffix = detail === undefined || detail === '' ? '' : ` (${detail})`;
    const line = `  ${result}: ${describe(action)}${suffix}\n`;
    if (result === 'failed') {
      failed = true;
      err(line);
    } else {
      out(line);
    }
  }
  if (failed) {
    err('cloudflare-setup: some items could not be created; fix the cause and run the script again (it only creates what is missing).\n');
    return 1;
  }
  const changed = outcomes.filter(({ result }) => result === 'created').length;
  out(changed === 0 ? 'Nothing to do: everything exists already.\n' : `Created ${changed} item(s).\n`);
  for (const line of nextStepsLines()) out(`${line}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
