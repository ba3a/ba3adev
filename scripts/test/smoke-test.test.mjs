// Tests for scripts/smoke-test.mjs. No test reaches the network: the checks run against a fake
// `fetch` or against a server on the loopback interface. The pauses between attempts run on a fake
// clock, so a test that waits for five minutes takes no time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../node_modules/coffer/src/config.js';
import { SITES, describeStatus, feedIconOf, languageOf, main, parseArgs, readExpectedBuiltAt, runSmokeTests } from '../smoke-test.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

const BUILT_AT = { 'ba3a.dev': '2026-11-07T06:11:23.592Z', 'my.ba3a.dev': '2026-11-07T06:11:23.962Z' };

const EN_404 = '<!doctype html>\n<html lang="en"><head><title>Not found</title></head><body><h1>Page not found</h1></body></html>';
const RU_404 = '<!doctype html>\n<html lang="ru"><head><title>Нет такой страницы</title></head><body><h1>Страница не найдена</h1></body></html>';
const EN_HOME = '<!doctype html>\n<html lang="en"><head></head><body>Home</body></html>';
const RU_HOME = '<!doctype html>\n<html lang="ru"><head></head><body>Главная</body></html>';

/**
 * A fake of one deployed site.
 *
 * @param {import('../smoke-test.mjs').Site} site
 * @param {{ builtAt?: string, home?: () => Response, notFoundBody?: string, notFoundStatus?: number, redirectStatus?: number, redirectTo?: string | null, favicon?: (() => Response) | null, feed?: (() => Response) | null, icon?: string | null, iconPath?: string, iconResponse?: (() => Response) | null }} [options]
 */
function fakeSite(site, options = {}) {
  const english = site.lang === 'en';
  return (/** @type {URL} */ url) => {
    const path = url.pathname;
    if (path === '/') {
      return options.home ? options.home() : new Response(english ? EN_HOME : RU_HOME, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (path === site.redirect.from) {
      if (options.redirectStatus === 200) return new Response('page', { status: 200 });
      const location = options.redirectTo === undefined ? site.redirect.to : options.redirectTo;
      return new Response('', { status: options.redirectStatus ?? 308, headers: location === null ? {} : { location } });
    }
    if (path === site.redirect.to) return new Response('page', { status: 200 });
    if (path === '/favicon.ico') {
      if (options.favicon === null) return new Response('missing', { status: 404, headers: { 'content-type': 'text/html' } });
      return options.favicon ? options.favicon() : new Response('ico', { status: 200, headers: { 'content-type': 'image/x-icon' } });
    }
    if (path === site.feed) {
      if (options.feed === null) return new Response('missing', { status: 404, headers: { 'content-type': 'text/html' } });
      if (options.feed) return options.feed();
      const icon = options.icon === undefined ? `${site.baseUrl}/assets/brand/icon-192.png` : options.icon;
      const iconElement = icon === null ? '' : `<icon>${icon}</icon>`;
      const feed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>${iconElement}<entry><content>&lt;icon&gt;x&lt;/icon&gt;</content></entry></feed>`;
      return new Response(feed, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
    }
    if (path === (options.iconPath ?? '/assets/brand/icon-192.png')) {
      return options.iconResponse ? options.iconResponse() : new Response('png', { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (path === '/build-info.json') {
      return new Response(JSON.stringify({ builtAt: options.builtAt ?? BUILT_AT[site.id], engineVersion: '0.0.0', sources: {}, nextScheduledAt: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(options.notFoundBody ?? (english ? EN_404 : RU_404), { status: options.notFoundStatus ?? 404, headers: { 'content-type': 'text/html' } });
  };
}

/**
 * Makes a `fetch` that answers from fake sites by host and records every request.
 *
 * @param {Record<string, (url: URL) => Response>} handlers By origin, such as `https://ba3a.dev`.
 */
function fakeFetch(handlers) {
  /** @type {{ url: string, init: RequestInit | undefined }[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    const handler = handlers[url.origin];
    if (!handler) throw new TypeError(`fetch failed: no fake for ${url.origin}`);
    return handler(url);
  };
  return { fetch: fetchImpl, calls };
}

/** A fake clock: sleeping advances it and records the pause. */
function fakeClock() {
  let time = 0;
  /** @type {number[]} */
  const pauses = [];
  return {
    now: () => time,
    sleep: async (/** @type {number} */ ms) => {
      pauses.push(ms);
      time += ms;
    },
    pauses,
  };
}

/** @param {Record<string, (url: URL) => Response>} handlers @param {Partial<import('../smoke-test.mjs').SmokeOptions>} [extra] */
function run(handlers, extra = {}) {
  const clock = fakeClock();
  const { fetch: fetchImpl, calls } = fakeFetch(handlers);
  const promise = runSmokeTests({
    expectedBuiltAt: BUILT_AT,
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 60_000,
    token: 'tok',
    ...extra,
  });
  return { promise, calls, clock };
}

const allGood = () => ({
  'https://ba3a.dev': fakeSite(SITES[0]),
  'https://my.ba3a.dev': fakeSite(SITES[1]),
});

test('the sites of the smoke test match coffer.yaml', () => {
  const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
  assert.deepEqual(
    SITES.map((site) => ({ id: site.id, baseUrl: site.baseUrl, lang: site.lang })),
    config.sites.map((site) => ({ id: site.id, baseUrl: site.baseUrl, lang: site.lang })),
  );
  for (const site of SITES) {
    const blog = config.sites.find((candidate) => candidate.id === site.id)?.blogs[0];
    assert.equal(site.feed, `/${blog?.prefix ? `${blog.prefix}/` : ''}feed.xml`, `${site.id} checks the feed of its blog`);
    assert.equal(site.redirect.to, `${site.redirect.from}/`, `${site.id} redirect is a trailing slash`);
    assert.ok(site.baseUrl.startsWith('https://'), `${site.id} is checked over https`);
  }
});

test('all checks pass when both sites are as expected, and nothing is followed implicitly', async () => {
  const { promise, calls } = run(allGood());
  const outcome = await promise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 12);
  assert.ok(outcome.results.every((result) => result.ok && result.attempts === 1));
  assert.ok(calls.every((call) => call.init?.redirect === 'manual'), 'every request asks for redirect: manual');
  assert.ok(calls.every((call) => call.url.startsWith('https://')), 'only https addresses are requested');
  const notFoundRequest = calls.find((call) => call.url.includes('smoke-test-no-such-page-tok'));
  assert.ok(notFoundRequest, 'the 404 address is made unique by the token');
  for (const site of SITES) {
    for (const path of ['/favicon.ico', site.feed, '/assets/brand/icon-192.png']) {
      assert.ok(calls.some((call) => call.url === `${site.baseUrl}${path}`), `${site.id} ${path} is requested`);
    }
  }
  const buildInfoRequest = calls.find((call) => call.url.endsWith('/build-info.json'));
  assert.match(JSON.stringify(buildInfoRequest?.init?.headers), /no-cache/i, 'build-info.json is requested with no-cache');
});

test('a site with an http address fails the HTTPS checks', async () => {
  const sites = [{ ...SITES[0], baseUrl: 'http://ba3a.dev' }];
  const { promise } = run({ 'http://ba3a.dev': fakeSite(SITES[0]) }, { sites, timeoutMs: 0 });
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.match(outcome.results[0].error ?? '', /not an https:\/\/ address/);
});

test('a home page that redirects fails, naming the target', async () => {
  const handlers = allGood();
  handlers['https://ba3a.dev'] = fakeSite(SITES[0], { home: () => new Response('', { status: 301, headers: { location: 'https://example.org/' } }) });
  const outcome = await run(handlers, { timeoutMs: 0 }).promise;
  assert.equal(outcome.ok, false);
  const failure = outcome.results.find((result) => !result.ok);
  assert.equal(failure?.site, 'ba3a.dev');
  assert.match(failure?.error ?? '', /answered 301 to https:\/\/example\.org\//);
});

test('a refusal is reported with the Cloudflare headers', async () => {
  const refused = () => new Response('', { status: 403, headers: { server: 'cloudflare', 'cf-mitigated': 'challenge', 'cf-ray': 'abc-FRA' } });
  const handlers = allGood();
  handlers['https://ba3a.dev'] = fakeSite(SITES[0], { home: refused });
  const outcome = await run(handlers, { timeoutMs: 0 }).promise;
  const failure = outcome.results.find((result) => !result.ok);
  assert.match(failure?.error ?? '', /answered 403 \(server: cloudflare, cf-mitigated: challenge, cf-ray: abc-FRA\); expected 200/);
  assert.equal(describeStatus({ status: 200, headers: new Headers({ server: 'cloudflare' }) }), '200');
  assert.equal(describeStatus({ status: 403, headers: new Headers() }), '403');
});

test('a home page in the wrong language fails', async () => {
  const handlers = allGood();
  handlers['https://my.ba3a.dev'] = fakeSite(SITES[1], { home: () => new Response(EN_HOME, { status: 200 }) });
  const outcome = await run(handlers, { timeoutMs: 0 }).promise;
  const failure = outcome.results.find((result) => !result.ok);
  assert.equal(failure?.site, 'my.ba3a.dev');
  assert.match(failure?.error ?? '', /language "ru"/);
});

test('the trailing-slash check needs a redirect to exactly the canonical address', async () => {
  for (const [options, message] of /** @type {const} */ ([
    [{ redirectStatus: 200 }, /answered 200; expected a redirect to https:\/\/ba3a\.dev\/devlog\//],
    [{ redirectTo: '/elsewhere/' }, /redirects to https:\/\/ba3a\.dev\/elsewhere\/; expected https:\/\/ba3a\.dev\/devlog\//],
    [{ redirectTo: null }, /\(no Location\)/],
  ])) {
    const handlers = allGood();
    handlers['https://ba3a.dev'] = fakeSite(SITES[0], options);
    const outcome = await run(handlers, { timeoutMs: 0 }).promise;
    const failure = outcome.results.find((result) => !result.ok);
    assert.match(failure?.error ?? '', message);
  }
  // An absolute Location is accepted as well as a relative one.
  const handlers = allGood();
  handlers['https://ba3a.dev'] = fakeSite(SITES[0], { redirectTo: 'https://ba3a.dev/devlog/', redirectStatus: 301 });
  assert.equal((await run(handlers).promise).ok, true);
});

test('the 404 check needs status 404 and the language of the site', async () => {
  const cases = /** @type {const} */ ([
    ['ba3a.dev', { notFoundStatus: 200 }, /answered 200; expected 404/],
    ['ba3a.dev', { notFoundBody: RU_404 }, /lang="ru"; expected "en"/],
    ['my.ba3a.dev', { notFoundBody: EN_404 }, /lang="en"; expected "ru"/],
    ['my.ba3a.dev', { notFoundBody: '<html lang="ru"><body>Not found</body></html>' }, /no Russian text/],
    ['ba3a.dev', { notFoundBody: '<html lang="en"><body>Страница не найдена</body></html>' }, /contains Russian text/],
    ['ba3a.dev', { notFoundBody: 'Not Found' }, /lang="none"/],
  ]);
  for (const [id, options, message] of cases) {
    const handlers = allGood();
    const site = SITES.find((candidate) => candidate.id === id);
    assert.ok(site);
    handlers[site.baseUrl] = fakeSite(site, options);
    const outcome = await run(handlers, { timeoutMs: 0 }).promise;
    const failure = outcome.results.find((result) => !result.ok);
    assert.equal(failure?.site, id);
    assert.match(failure?.error ?? '', message);
  }
});

test('the Russian text inside a script or a style does not make an English 404 fail', async () => {
  const handlers = allGood();
  handlers['https://ba3a.dev'] = fakeSite(SITES[0], { notFoundBody: '<html lang="en"><script>var x = "Привет";</script><body>Not found</body></html>' });
  assert.equal((await run(handlers).promise).ok, true);
});

test('build-info.json must carry the builtAt of this run', async () => {
  const handlers = allGood();
  handlers['https://ba3a.dev'] = fakeSite(SITES[0], { builtAt: '2020-01-01T00:00:00.000Z' });
  const outcome = await run(handlers, { timeoutMs: 0 }).promise;
  const failure = outcome.results.find((result) => !result.ok);
  assert.match(failure?.check ?? '', /build-info\.json/);
  assert.match(failure?.error ?? '', /says builtAt 2020-01-01T00:00:00\.000Z; this run built 2026-11-07T06:11:23\.592Z/);
});

test('a site without an expected builtAt fails instead of passing silently', async () => {
  const outcome = await run(allGood(), { expectedBuiltAt: { 'my.ba3a.dev': BUILT_AT['my.ba3a.dev'] }, timeoutMs: 0 }).promise;
  const failure = outcome.results.find((result) => !result.ok);
  assert.equal(failure?.site, 'ba3a.dev');
  assert.match(failure?.error ?? '', /no expected builtAt/);
});

test('a deployment that arrives late is waited for, with growing pauses', async () => {
  const handlers = allGood();
  let asked = 0;
  const fresh = fakeSite(SITES[0]);
  const stale = fakeSite(SITES[0], { builtAt: '2020-01-01T00:00:00.000Z' });
  handlers['https://ba3a.dev'] = (url) => {
    if (url.pathname === '/build-info.json') {
      asked += 1;
      return asked < 5 ? stale(url) : fresh(url);
    }
    return fresh(url);
  };
  const { promise, clock } = run(handlers, { timeoutMs: 300_000 });
  const outcome = await promise;
  assert.equal(outcome.ok, true);
  const buildInfo = outcome.results.find((result) => result.site === 'ba3a.dev' && /build-info/.test(result.check));
  assert.equal(buildInfo?.attempts, 5);
  assert.deepEqual(clock.pauses, [5000, 10_000, 20_000, 30_000]);
});

test('a check that never passes stops after the time limit', async () => {
  const handlers = allGood();
  handlers['https://ba3a.dev'] = fakeSite(SITES[0], { builtAt: '2020-01-01T00:00:00.000Z' });
  const { promise, clock } = run(handlers, { timeoutMs: 100_000, sites: [SITES[0]] });
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.ok(clock.now() <= 100_000, `waited ${clock.now()} ms at most`);
  const failure = outcome.results.find((result) => !result.ok);
  assert.ok((failure?.attempts ?? 0) > 3);
});

test('/favicon.ico must answer 200 with an image content type', async () => {
  const cases = /** @type {const} */ ([
    [{ favicon: null }, /\/favicon\.ico answered 404; expected 200/],
    [{ favicon: () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) }, /content type text\/html; expected an image/],
    [{ favicon: () => new Response('x', { status: 200 }) }, /content type text\/plain.*; expected an image/],
  ]);
  for (const [options, message] of cases) {
    const handlers = allGood();
    handlers['https://my.ba3a.dev'] = fakeSite(SITES[1], options);
    const outcome = await run(handlers, { timeoutMs: 0 }).promise;
    const failures = outcome.results.filter((result) => !result.ok);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].site, 'my.ba3a.dev');
    assert.match(failures[0].check, /favicon\.ico/);
    assert.match(failures[0].error ?? '', message);
  }
});

test('the main feed must have an absolute <icon> on the site, and the icon must be served as an image', async () => {
  const cases = /** @type {const} */ ([
    [{ feed: null }, /\/devlog\/feed\.xml answered 404; expected 200/],
    [{ icon: null }, /has no <icon>/],
    [{ icon: '/assets/brand/icon-192.png' }, /is not an absolute URL: \/assets\/brand\/icon-192\.png/],
    [{ icon: 'assets/brand/icon-192.png' }, /is not an absolute URL/],
    [{ icon: 'ftp://ba3a.dev/assets/brand/icon-192.png' }, /not an absolute http\(s\) URL/],
    [{ icon: 'https://example.org/assets/brand/icon-192.png' }, /is on https:\/\/example\.org; expected https:\/\/ba3a\.dev/],
    [{ iconPath: '/elsewhere.png' }, /icon-192\.png\) answered 404; expected 200/],
    [{ iconResponse: () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) }, /content type text\/html; expected an image/],
    // An <icon> in a post does not count as the icon of the feed.
    [{ feed: () => new Response('<feed><title>t</title><entry><content>&lt;icon&gt;x&lt;/icon&gt;</content><icon>https://ba3a.dev/assets/brand/icon-192.png</icon></entry></feed>', { status: 200 }) }, /has no <icon>/],
  ]);
  for (const [options, message] of cases) {
    const handlers = allGood();
    handlers['https://ba3a.dev'] = fakeSite(SITES[0], options);
    const outcome = await run(handlers, { timeoutMs: 0 }).promise;
    const failures = outcome.results.filter((result) => !result.ok);
    assert.equal(failures.length, 1, JSON.stringify(options));
    assert.equal(failures[0].site, 'ba3a.dev');
    assert.match(failures[0].check, /<icon>/);
    assert.match(failures[0].error ?? '', message);
  }
});

test('the feed icon is asked from the checked address, with the path of the URL in the feed', async () => {
  const sites = [{ ...SITES[0], baseUrl: 'https://ba3a-dev.pages.dev', publicOrigin: 'https://ba3a.dev' }];
  const site = SITES[0];
  const { fetch: fetchImpl, calls } = fakeFetch({
    'https://ba3a-dev.pages.dev': fakeSite({ ...site, baseUrl: 'https://ba3a.dev' }, { icon: 'https://ba3a.dev/assets/brand/icon-192.png?v=2' }),
  });
  const outcome = await runSmokeTests({ sites, expectedBuiltAt: BUILT_AT, fetch: fetchImpl, timeoutMs: 0, token: 'tok' });
  const failures = outcome.results.filter((result) => !result.ok);
  assert.deepEqual(failures.map((result) => result.check), [], JSON.stringify(failures));
  assert.ok(calls.some((call) => call.url === 'https://ba3a-dev.pages.dev/assets/brand/icon-192.png?v=2'));
  assert.ok(calls.every((call) => call.url.startsWith('https://ba3a-dev.pages.dev/')), 'the custom domain is not asked');
});

test('feedIconOf reads the icon of the feed and not the one of a post', () => {
  assert.equal(feedIconOf('<feed><icon> https://a.test/i.png </icon><entry/></feed>'), 'https://a.test/i.png');
  assert.equal(feedIconOf('<feed><entry><icon>https://a.test/i.png</icon></entry></feed>'), null);
  assert.equal(feedIconOf('<feed><title>t</title></feed>'), null);
});

test('a request that throws is a failed attempt with the reason', async () => {
  const { promise } = run({ 'https://my.ba3a.dev': fakeSite(SITES[1]) }, { timeoutMs: 0, sites: [SITES[0]] });
  const outcome = await promise;
  assert.equal(outcome.ok, false);
  assert.match(outcome.results[0].error ?? '', /GET https:\/\/ba3a\.dev\/ failed: fetch failed/);
});

test('languageOf reads the language of the root element', () => {
  assert.equal(languageOf('<!doctype html><html lang="RU-ru" data-x="1">'), 'ru-ru');
  assert.equal(languageOf("<html class='a' lang='en'>"), 'en');
  assert.equal(languageOf('<p lang="en">'), null);
  assert.equal(languageOf('no html'), null);
});

test('parseArgs reads the options and refuses unknown ones', () => {
  const parsed = parseArgs(['--dist', 'out', '--timeout', '12', '--site', 'ba3a.dev', '--base', 'ba3a.dev=http://127.0.0.1:9/', '--allow-insecure-loopback']);
  assert.ok(!('error' in parsed));
  assert.equal(parsed.timeoutMs, 12_000);
  assert.deepEqual(parsed.siteIds, ['ba3a.dev']);
  assert.deepEqual(parsed.bases, { 'ba3a.dev': 'http://127.0.0.1:9' });
  assert.equal(parsed.allowInsecureLoopback, true);
  assert.match(String(/** @type {any} */ (parseArgs(['--nope'])).error), /unexpected argument/);
  assert.match(String(/** @type {any} */ (parseArgs(['--timeout', 'abc'])).error), /number of seconds/);
  assert.match(String(/** @type {any} */ (parseArgs(['--base', 'nothing'])).error), /--base needs/);
  assert.match(String(/** @type {any} */ (parseArgs(['--dist'])).error), /needs a value/);
});

/**
 * Runs `body` with a folder that holds the build-info.json files of a run.
 *
 * @param {(dist: string) => Promise<void> | void} body
 */
async function withDist(body) {
  const dist = mkdtempSync(join(tmpdir(), 'smoke-dist-'));
  try {
    for (const [id, builtAt] of Object.entries(BUILT_AT)) {
      mkdirSync(join(dist, id), { recursive: true });
      writeFileSync(join(dist, id, 'build-info.json'), JSON.stringify({ builtAt }));
    }
    await body(dist);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

test('readExpectedBuiltAt reads the build time of a built site and explains a missing file', async () => {
  await withDist((dist) => {
    assert.equal(readExpectedBuiltAt(dist, 'ba3a.dev'), BUILT_AT['ba3a.dev']);
    assert.throws(() => readExpectedBuiltAt(dist, 'nope.dev'), /cannot read .*build-info\.json/);
    writeFileSync(join(dist, 'ba3a.dev', 'build-info.json'), '{}');
    assert.throws(() => readExpectedBuiltAt(dist, 'ba3a.dev'), /has no builtAt/);
  });
});

test('main exits 2 for a bad command line or an unbuilt site, 0 for success and 1 for a failure', async () => {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const io = (/** @type {typeof fetch} */ fetchImpl) => ({ out: (/** @type {string} */ line) => out.push(line), err: (/** @type {string} */ line) => err.push(line), fetch: fetchImpl });

  assert.equal(await main(['--wat'], io(fetch)), 2);
  assert.equal(await main(['--site', 'nope.dev'], io(fetch)), 2);
  assert.match(err.join('\n'), /unknown site nope\.dev/);

  await withDist(async (dist) => {
    const good = fakeFetch(allGood());
    assert.equal(await main(['--dist', dist], io(good.fetch)), 0);
    assert.match(out.join('\n'), /all 12 checks passed/);

    err.length = 0;
    const handlers = allGood();
    handlers['https://my.ba3a.dev'] = fakeSite(SITES[1], { builtAt: '2020-01-01T00:00:00.000Z' });
    const bad = fakeFetch(handlers);
    assert.equal(await main(['--dist', dist, '--timeout', '0'], io(bad.fetch)), 1);
    assert.match(err.join('\n'), /FAIL my\.ba3a\.dev: build-info\.json/);
    assert.match(err.join('\n'), /1 check\(s\) failed/);

    assert.equal(await main(['--dist', join(dist, 'missing')], io(good.fetch)), 2);
  });
});

test('the checks work against a real HTTP server on the loopback interface', async () => {
  const handler = fakeSite(SITES[0]);
  const server = createServer(async (request, response) => {
    const answer = handler(new URL(request.url ?? '/', 'http://127.0.0.1'));
    /** @type {Record<string, string>} */
    const headers = {};
    answer.headers.forEach((value, key) => {
      headers[key] = value;
    });
    response.writeHead(answer.status, headers);
    response.end(await answer.text());
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const sites = [{ ...SITES[0], baseUrl: base, publicOrigin: SITES[0].baseUrl }];
    const allowed = await runSmokeTests({ sites, expectedBuiltAt: BUILT_AT, allowInsecureLoopback: true, timeoutMs: 0 });
    assert.equal(allowed.ok, true, JSON.stringify(allowed.results));
    // Without the explicit permission the same plain-http address is refused.
    const refused = await runSmokeTests({ sites, expectedBuiltAt: BUILT_AT, timeoutMs: 0 });
    assert.equal(refused.ok, false);
    // And the permission is only for loopback addresses.
    const elsewhere = await runSmokeTests({ sites: [{ ...SITES[0], baseUrl: 'http://example.test' }], expectedBuiltAt: BUILT_AT, allowInsecureLoopback: true, timeoutMs: 0, fetch: async () => { throw new Error('must not be called'); } });
    assert.equal(elsewhere.ok, false);
    assert.match(elsewhere.results[0].error ?? '', /not an https:\/\/ address/);
  } finally {
    await new Promise((done) => server.close(() => done(undefined)));
  }
});
