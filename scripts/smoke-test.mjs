// Smoke test of the live sites, run by the deploy workflow after the upload:
//
//   node scripts/smoke-test.mjs [--dist <dir>] [--timeout <seconds>] [--site <id>]...
//
// For each site it checks, over HTTPS:
//   1. the home page answers 200 directly (no redirect, no downgrade to http);
//   2. the address without its trailing slash redirects to the canonical one, which answers 200;
//   3. an unknown address answers 404 with a page in the language of the site;
//   4. build-info.json says it was built at the moment recorded in this run's own
//      `{dist}/{site}/build-info.json`, which proves that the visitors see this deployment and
//      not an older one;
//   5. /favicon.ico answers 200 with an image content type;
//   6. the main feed answers 200 and has an <icon> element with an absolute URL on the address
//      of the site, and that icon answers 200 with an image content type. The icon is asked from
//      the address that is checked (--base), with the path of the URL in the feed, because the
//      custom domains answer CI runners with 403.
//
// A Cloudflare deployment can take a moment to reach every edge, so each check is repeated, with
// a growing pause, until it passes or the time given by --timeout (default 300 seconds, for the
// whole run) is used up; a check that never passes fails the run with the reason of its last
// attempt. Redirects are never followed implicitly: every request asks for the answer as the
// server gives it. The script reads no secret and sends no credential.
//
// The deploy workflow points the checks at the pages.dev addresses (--base), because Bot Fight Mode
// on the zone answers CI runners with 403 on the custom domains. A failing answer is reported with
// the Cloudflare headers that explain it.
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 the script was used wrongly.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * What is checked on each site. The lines must agree with coffer.yaml (a test compares them).
 * `redirect` is a page whose canonical address ends in a slash: the blog index of ba3a.dev, and
 * the tag tree of my.ba3a.dev, whose blog sits at the root of the site. `feed` is the address of
 * the main feed: the devlog of ba3a.dev, and the root blog of my.ba3a.dev.
 */
export const SITES = Object.freeze([
  Object.freeze({
    id: 'ba3a.dev',
    baseUrl: 'https://ba3a.dev',
    lang: 'en',
    redirect: Object.freeze({ from: '/devlog', to: '/devlog/' }),
    feed: '/devlog/feed.xml',
  }),
  Object.freeze({
    id: 'my.ba3a.dev',
    baseUrl: 'https://my.ba3a.dev',
    lang: 'ru',
    redirect: Object.freeze({ from: '/tags', to: '/tags/' }),
    feed: '/feed.xml',
  }),
]);

/** The whole run may take this long, in milliseconds, before a failing check gives up. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** The first pause between two attempts, in milliseconds; it doubles up to {@link MAX_DELAY_MS}. */
export const INITIAL_DELAY_MS = 5_000;

/** The longest pause between two attempts, in milliseconds. */
export const MAX_DELAY_MS = 30_000;

/** How long one request may take, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Response headers that tell who refused a request, in the order they are reported. */
const DIAGNOSTIC_HEADERS = Object.freeze(['server', 'cf-mitigated', 'cf-ray']);

/** Statuses that mean "moved, look at the Location header". */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Letters of the Russian alphabet. */
const CYRILLIC = /[А-яЁё]/;

/**
 * @typedef {object} Site
 * @property {string} id
 * @property {string} baseUrl The address of the site, `https://` and no trailing slash.
 * @property {string} lang The language of its pages and of its 404 page.
 * @property {{ from: string, to: string }} redirect
 * @property {string} feed The address of the main feed, with its leading slash.
 * @property {string} [publicOrigin] The address the feed icon must be on, when `baseUrl` is replaced (default `baseUrl`).
 */

/**
 * @typedef {object} Context
 * @property {typeof fetch} fetch
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now Milliseconds, only used to measure time.
 * @property {number} deadline The moment (on the clock of `now`) after which a failing check stops being retried.
 * @property {number} initialDelayMs
 * @property {number} maxDelayMs
 * @property {number} requestTimeoutMs
 * @property {boolean} allowInsecureLoopback Allows `http://` for 127.0.0.1, localhost and [::1], for tests.
 * @property {string} token A string that makes the unknown address of the 404 check unique.
 */

/**
 * @typedef {object} CheckResult
 * @property {string} site
 * @property {string} check
 * @property {boolean} ok
 * @property {number} attempts
 * @property {string} [error] The reason of the last failed attempt.
 */

/**
 * A failed check. The message says what was expected and what was seen.
 */
class CheckFailure extends Error {}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/**
 * Requires the address of a site to be HTTPS (or loopback http, when the context allows it).
 *
 * @param {string} baseUrl
 * @param {Context} ctx
 * @returns {void}
 * @throws {CheckFailure}
 */
function requireSecureBase(baseUrl, ctx) {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && ctx.allowInsecureLoopback && isLoopback(url.hostname)) return;
  throw new CheckFailure(`${baseUrl} is not an https:// address`);
}

/**
 * Fetches one address without following redirects, reads the whole body and returns the parts a
 * check needs.
 *
 * @param {Context} ctx
 * @param {string} url
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, location: string | null, body: string, headers: Headers, url: string }>}
 * @throws {CheckFailure} When the request fails or times out.
 */
async function request(ctx, url, headers = {}) {
  try {
    const response = await ctx.fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'ba3a-smoke-test', ...headers },
      signal: AbortSignal.timeout(ctx.requestTimeoutMs),
    });
    const body = await response.text();
    return {
      status: response.status,
      location: response.headers.get('location'),
      body,
      headers: response.headers,
      url: response.url || url,
    };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    const reason = error instanceof Error ? `${error.message}${cause}` : String(error);
    throw new CheckFailure(`GET ${url} failed: ${reason}`);
  }
}

/**
 * A status for a failure message: the number, and for a refusal (status 400 or more) the response
 * headers that show whether Cloudflare or the origin gave it.
 *
 * @param {{ status: number, headers: Headers }} answer
 * @returns {string}
 */
export function describeStatus(answer) {
  if (answer.status < 400) return String(answer.status);
  const found = DIAGNOSTIC_HEADERS.flatMap((name) => {
    const value = answer.headers.get(name);
    return value ? [`${name}: ${value}`] : [];
  });
  return found.length > 0 ? `${answer.status} (${found.join(', ')})` : String(answer.status);
}

/**
 * The language declared on the root element of an HTML text.
 *
 * @param {string} html
 * @returns {string | null}
 */
export function languageOf(html) {
  const match = /<html\b[^>]*?\blang\s*=\s*["']?([A-Za-z-]+)/i.exec(html);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Check 1: the home page, over HTTPS, answered directly.
 *
 * @param {Site} site
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
async function checkHome(site, ctx) {
  requireSecureBase(site.baseUrl, ctx);
  const url = `${site.baseUrl}/`;
  const answer = await request(ctx, url);
  if (REDIRECT_STATUSES.has(answer.status)) {
    throw new CheckFailure(`GET ${url} answered ${answer.status} to ${answer.location ?? '(no Location)'}; expected 200 without a redirect`);
  }
  if (answer.status !== 200) throw new CheckFailure(`GET ${url} answered ${describeStatus(answer)}; expected 200`);
  if (!answer.url.startsWith('https://') && !(ctx.allowInsecureLoopback && answer.url.startsWith(`${site.baseUrl}/`))) {
    throw new CheckFailure(`GET ${url} was answered from ${answer.url}, which is not https://`);
  }
  const lang = languageOf(answer.body);
  if (lang !== site.lang) {
    throw new CheckFailure(`GET ${url} is not a page in language "${site.lang}" (found lang="${lang ?? 'none'}")`);
  }
}

/**
 * Check 2: an address without its trailing slash redirects to the one with it.
 *
 * @param {Site} site
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
async function checkRedirect(site, ctx) {
  requireSecureBase(site.baseUrl, ctx);
  const from = `${site.baseUrl}${site.redirect.from}`;
  const expected = `${site.baseUrl}${site.redirect.to}`;
  const answer = await request(ctx, from);
  if (!REDIRECT_STATUSES.has(answer.status)) {
    throw new CheckFailure(`GET ${from} answered ${describeStatus(answer)}; expected a redirect to ${expected}`);
  }
  const target = answer.location === null ? null : new URL(answer.location, from).href;
  if (target !== expected) {
    throw new CheckFailure(`GET ${from} redirects to ${target ?? '(no Location)'}; expected ${expected}`);
  }
  const final = await request(ctx, expected);
  if (final.status !== 200) throw new CheckFailure(`GET ${expected} answered ${describeStatus(final)}; expected 200`);
}

/**
 * Check 3: an unknown address answers 404 with the 404 page of the site, in its language.
 *
 * @param {Site} site
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
async function checkNotFound(site, ctx) {
  requireSecureBase(site.baseUrl, ctx);
  const url = `${site.baseUrl}/smoke-test-no-such-page-${ctx.token}/`;
  const answer = await request(ctx, url);
  if (answer.status !== 404) throw new CheckFailure(`GET ${url} answered ${describeStatus(answer)}; expected 404`);
  const lang = languageOf(answer.body);
  if (lang !== site.lang) {
    throw new CheckFailure(`the 404 page of ${site.id} has lang="${lang ?? 'none'}"; expected "${site.lang}"`);
  }
  const visibleText = answer.body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
  const cyrillic = CYRILLIC.test(visibleText);
  if (site.lang === 'ru' && !cyrillic) throw new CheckFailure(`the 404 page of ${site.id} contains no Russian text`);
  if (site.lang !== 'ru' && cyrillic) throw new CheckFailure(`the 404 page of ${site.id} contains Russian text; expected "${site.lang}"`);
}

/**
 * Check 4: the live build-info.json is the one this run built.
 *
 * @param {Site} site
 * @param {Context} ctx
 * @param {string} expectedBuiltAt
 * @returns {Promise<void>}
 */
async function checkBuildInfo(site, ctx, expectedBuiltAt) {
  requireSecureBase(site.baseUrl, ctx);
  const url = `${site.baseUrl}/build-info.json`;
  const answer = await request(ctx, url, { 'cache-control': 'no-cache', pragma: 'no-cache' });
  if (answer.status !== 200) throw new CheckFailure(`GET ${url} answered ${describeStatus(answer)}; expected 200`);
  /** @type {unknown} */
  let info;
  try {
    info = JSON.parse(answer.body);
  } catch {
    throw new CheckFailure(`${url} is not JSON`);
  }
  const builtAt = typeof info === 'object' && info !== null ? /** @type {Record<string, unknown>} */ (info).builtAt : undefined;
  if (typeof builtAt !== 'string') throw new CheckFailure(`${url} has no builtAt`);
  if (builtAt !== expectedBuiltAt) {
    throw new CheckFailure(`${url} says builtAt ${builtAt}; this run built ${expectedBuiltAt}, so the deployment is not live yet (or an older one is served)`);
  }
}

/**
 * Whether a response says it carries an image.
 *
 * @param {{ headers: Headers }} answer
 * @returns {boolean}
 */
function isImage(answer) {
  return /^image\//i.test(answer.headers.get('content-type') ?? '');
}

/**
 * The text of the `<icon>` element of an Atom feed. Only the part before the first entry is read,
 * so that an `<icon>` inside a post cannot be taken for the one of the feed.
 *
 * @param {string} feed
 * @returns {string | null}
 */
export function feedIconOf(feed) {
  const entry = feed.search(/<entry[\s>]/i);
  const head = entry === -1 ? feed : feed.slice(0, entry);
  const match = /<icon>([\s\S]*?)<\/icon>/i.exec(head);
  return match ? match[1].trim() : null;
}

/**
 * Check 5: /favicon.ico is served, as an image.
 *
 * @param {Site} site
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
async function checkFavicon(site, ctx) {
  requireSecureBase(site.baseUrl, ctx);
  const url = `${site.baseUrl}/favicon.ico`;
  const answer = await request(ctx, url);
  if (answer.status !== 200) throw new CheckFailure(`GET ${url} answered ${describeStatus(answer)}; expected 200`);
  if (!isImage(answer)) throw new CheckFailure(`GET ${url} has content type ${answer.headers.get('content-type') ?? '(none)'}; expected an image`);
}

/**
 * Check 6: the main feed has an absolute <icon> on the address of the site, and the icon is served.
 *
 * @param {Site} site
 * @param {Context} ctx
 * @returns {Promise<void>}
 */
async function checkFeedIcon(site, ctx) {
  requireSecureBase(site.baseUrl, ctx);
  const feedUrl = `${site.baseUrl}${site.feed}`;
  const feed = await request(ctx, feedUrl);
  if (feed.status !== 200) throw new CheckFailure(`GET ${feedUrl} answered ${describeStatus(feed)}; expected 200`);
  const icon = feedIconOf(feed.body);
  if (icon === null || icon === '') throw new CheckFailure(`the feed ${feedUrl} has no <icon>`);
  /** @type {URL} */
  let iconUrl;
  try {
    iconUrl = new URL(icon);
  } catch {
    throw new CheckFailure(`the <icon> of ${feedUrl} is not an absolute URL: ${icon}`);
  }
  if (iconUrl.protocol !== 'https:' && iconUrl.protocol !== 'http:') throw new CheckFailure(`the <icon> of ${feedUrl} is not an absolute http(s) URL: ${icon}`);
  const origin = new URL(site.publicOrigin ?? site.baseUrl).origin;
  if (iconUrl.origin !== origin) throw new CheckFailure(`the <icon> of ${feedUrl} is on ${iconUrl.origin}; expected ${origin}`);
  const checked = `${site.baseUrl}${iconUrl.pathname}${iconUrl.search}`;
  const answer = await request(ctx, checked);
  if (answer.status !== 200) throw new CheckFailure(`GET ${checked} (the <icon> ${icon}) answered ${describeStatus(answer)}; expected 200`);
  if (!isImage(answer)) throw new CheckFailure(`GET ${checked} (the <icon> ${icon}) has content type ${answer.headers.get('content-type') ?? '(none)'}; expected an image`);
}

/**
 * Runs `check` until it passes, with a growing pause, or until the deadline of the context.
 *
 * @param {Context} ctx
 * @param {() => Promise<void>} check
 * @returns {Promise<{ ok: boolean, attempts: number, error?: string }>}
 */
async function retrying(ctx, check) {
  let attempts = 0;
  let delay = ctx.initialDelayMs;
  for (;;) {
    attempts += 1;
    try {
      await check();
      return { ok: true, attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.now() + delay > ctx.deadline) return { ok: false, attempts, error: message };
      await ctx.sleep(delay);
      delay = Math.min(delay * 2, ctx.maxDelayMs);
    }
  }
}

/**
 * @typedef {object} SmokeOptions
 * @property {readonly Site[]} [sites] Default {@link SITES}.
 * @property {Record<string, string>} expectedBuiltAt The builtAt of this run's build, by site id.
 * @property {typeof fetch} [fetch]
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [now]
 * @property {number} [timeoutMs] Default {@link DEFAULT_TIMEOUT_MS}.
 * @property {number} [initialDelayMs]
 * @property {number} [maxDelayMs]
 * @property {number} [requestTimeoutMs]
 * @property {boolean} [allowInsecureLoopback]
 * @property {string} [token]
 * @property {(line: string) => void} [log] Receives one line per finished check.
 */

/**
 * Runs the checks of every site.
 *
 * @param {SmokeOptions} options
 * @returns {Promise<{ ok: boolean, results: CheckResult[] }>}
 */
export async function runSmokeTests(options) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  /** @type {Context} */
  const ctx = {
    fetch: options.fetch ?? globalThis.fetch,
    sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    now,
    deadline: now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    initialDelayMs: options.initialDelayMs ?? INITIAL_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? MAX_DELAY_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    allowInsecureLoopback: options.allowInsecureLoopback ?? false,
    token: options.token ?? Date.now().toString(36),
  };
  /** @type {CheckResult[]} */
  const results = [];
  for (const site of options.sites ?? SITES) {
    const expected = options.expectedBuiltAt[site.id];
    /** @type {[string, () => Promise<void>][]} */
    const checks = [
      ['home page answers 200 over HTTPS', () => checkHome(site, ctx)],
      [`${site.redirect.from} redirects to ${site.redirect.to}`, () => checkRedirect(site, ctx)],
      [`unknown address answers 404 in "${site.lang}"`, () => checkNotFound(site, ctx)],
      [
        'build-info.json is the one of this run',
        expected === undefined
          ? async () => {
              throw new CheckFailure(`no expected builtAt for ${site.id}`);
            }
          : () => checkBuildInfo(site, ctx, expected),
      ],
      ['/favicon.ico answers 200 as an image', () => checkFavicon(site, ctx)],
      [`${site.feed} has an absolute <icon> that answers 200`, () => checkFeedIcon(site, ctx)],
    ];
    for (const [check, run] of checks) {
      const outcome = await retrying(ctx, run);
      /** @type {CheckResult} */
      const result = { site: site.id, check, ...outcome };
      results.push(result);
      log(result.ok ? `PASS ${site.id}: ${check}` : `FAIL ${site.id}: ${check}\n     ${result.error} (after ${result.attempts} attempt(s))`);
    }
  }
  return { ok: results.every((result) => result.ok), results };
}

/**
 * Reads the moment a built site says it was built.
 *
 * @param {string} distDir
 * @param {string} siteId
 * @returns {string}
 * @throws {Error} When the file is missing or has no builtAt.
 */
export function readExpectedBuiltAt(distDir, siteId) {
  const file = join(distDir, siteId, 'build-info.json');
  let info;
  try {
    info = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof info?.builtAt !== 'string') throw new Error(`${file} has no builtAt`);
  return info.builtAt;
}

/**
 * @typedef {object} CliOptions
 * @property {string} dist
 * @property {number} timeoutMs
 * @property {string[]} siteIds
 * @property {Record<string, string>} bases Replacement addresses by site id (tests).
 * @property {boolean} allowInsecureLoopback
 */

/**
 * Reads the command line.
 *
 * @param {string[]} args
 * @returns {CliOptions | { error: string }}
 */
export function parseArgs(args) {
  /** @type {CliOptions} */
  const options = { dist: resolve('dist'), timeoutMs: DEFAULT_TIMEOUT_MS, siteIds: [], bases: {}, allowInsecureLoopback: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--allow-insecure-loopback') {
      options.allowInsecureLoopback = true;
      continue;
    }
    if (!['--dist', '--timeout', '--site', '--base'].includes(arg)) return { error: `unexpected argument "${arg}"` };
    const value = args[i + 1];
    if (value === undefined || value === '') return { error: `${arg} needs a value` };
    i += 1;
    if (arg === '--dist') options.dist = resolve(value);
    else if (arg === '--site') options.siteIds.push(value);
    else if (arg === '--timeout') {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) return { error: '--timeout needs a number of seconds' };
      options.timeoutMs = seconds * 1000;
    } else {
      const at = value.indexOf('=');
      if (at <= 0) return { error: '--base needs <site id>=<address>' };
      options.bases[value.slice(0, at)] = value.slice(at + 1).replace(/\/+$/, '');
    }
  }
  return options;
}

/**
 * The command line program.
 *
 * @param {string[]} args
 * @param {{ out: (line: string) => void, err: (line: string) => void, fetch?: typeof fetch }} io
 * @returns {Promise<number>} The exit code.
 */
export async function main(args, io) {
  const options = parseArgs(args);
  if ('error' in options) {
    io.err(`smoke-test: ${options.error}`);
    return 2;
  }
  const known = SITES.map((site) => site.id);
  const unknown = [...options.siteIds, ...Object.keys(options.bases)].filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    io.err(`smoke-test: unknown site ${unknown.join(', ')} (known: ${known.join(', ')})`);
    return 2;
  }
  const sites = SITES.filter((site) => options.siteIds.length === 0 || options.siteIds.includes(site.id)).map((site) => ({
    ...site,
    publicOrigin: site.baseUrl,
    baseUrl: options.bases[site.id] ?? site.baseUrl,
  }));
  /** @type {Record<string, string>} */
  const expectedBuiltAt = {};
  try {
    for (const site of sites) expectedBuiltAt[site.id] = readExpectedBuiltAt(options.dist, site.id);
  } catch (error) {
    io.err(`smoke-test: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const outcome = await runSmokeTests({
    sites,
    expectedBuiltAt,
    fetch: io.fetch,
    timeoutMs: options.timeoutMs,
    allowInsecureLoopback: options.allowInsecureLoopback,
    log: (line) => (line.startsWith('FAIL') ? io.err(line) : io.out(line)),
  });
  if (!outcome.ok) {
    io.err(`smoke-test: ${outcome.results.filter((result) => !result.ok).length} check(s) failed`);
    return 1;
  }
  io.out(`smoke-test: all ${outcome.results.length} checks passed`);
  return 0;
}

// Run as a script (not when a test imports it).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
