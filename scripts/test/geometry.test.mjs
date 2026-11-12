// Tests for scripts/lib/geometry.mjs, the matrix and the pure comparisons of the geometry check.
// No test starts a browser or a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { USAGE, main } from '../geometry-check.mjs';
import {
  EDGE_TOLERANCE,
  SCHEMES,
  SITES,
  WIDTHS,
  browserCandidates,
  checkFrame,
  checkRuleEnds,
  checkScrollWidth,
  checkStatus,
  closeTo,
  expandMatrix,
  expectedStatus,
  formatFailure,
  parseArgs,
  pickBrowser,
} from '../lib/geometry.mjs';

test('the matrix is the one of polish-spec.md section 5', () => {
  assert.deepEqual([...WIDTHS], [320, 375, 768, 1024, 1440]);
  assert.deepEqual([...SCHEMES], ['light', 'dark']);
  const ba3a = SITES.find((site) => site.id === 'ba3a.dev');
  const my = SITES.find((site) => site.id === 'my.ba3a.dev');
  assert.deepEqual(
    ba3a.pages.map((page) => page.name),
    ['home', 'devlog', 'post-toc', 'tag', 'series', 'made', 'tool-landing', 'game', 'docs', 'search', '404'],
  );
  assert.deepEqual(
    my.pages.map((page) => page.name),
    ['home', 'post', 'tags', 'search', '404'],
  );
  for (const site of SITES) {
    for (const page of site.pages) assert.match(page.path, /^\//, `${site.id} ${page.name}`);
  }
});

test('expandMatrix lists every page at every width in both schemes and can be filtered', () => {
  const all = expandMatrix();
  assert.equal(all.length, (11 + 5) * 5 * 2);
  assert.equal(new Set(all.map((cell) => `${cell.site}|${cell.page}|${cell.width}|${cell.scheme}`)).size, all.length);
  const some = expandMatrix({ sites: ['my.ba3a.dev'], pages: ['home', 'search'] });
  assert.equal(some.length, 2 * 5 * 2);
  assert.ok(some.every((cell) => cell.site === 'my.ba3a.dev' && cell.path));
  assert.throws(() => expandMatrix({ sites: ['nope'] }), /unknown site/);
  assert.throws(() => expandMatrix({ pages: ['nope'] }), /unknown page/);
});

test('closeTo compares within one pixel by default', () => {
  assert.equal(EDGE_TOLERANCE, 1);
  assert.ok(closeTo(10, 11));
  assert.ok(closeTo(11, 10));
  assert.ok(!closeTo(10, 11.2));
  assert.ok(closeTo(10, 10.5, 0.5));
});

test('checkFrame accepts header, main and footer with equal edges', () => {
  const frame = { header: { left: 16, right: 993 }, main: { left: 16, right: 993 }, footer: { left: 16.4, right: 992.6 } };
  assert.deepEqual(checkFrame(frame), []);
});

test('checkFrame names the element and the edge that differ', () => {
  const failures = checkFrame({ header: { left: 17, right: 992 }, main: { left: 17, right: 992 }, footer: { left: 72, right: 937 } });
  assert.equal(failures.length, 2);
  assert.equal(failures[0].check, 'frame-left');
  assert.match(failures[0].detail, /footer 72/);
  assert.match(failures[0].detail, /header 17/);
  assert.equal(failures[1].check, 'frame-right');
  assert.match(failures[1].detail, /footer 937/);
});

test('checkFrame leaves main out on a landing page and reports a missing element', () => {
  const landing = { header: { left: 16, right: 993 }, main: { left: 0, right: 1009 }, footer: { left: 16, right: 993 }, landing: true };
  assert.deepEqual(checkFrame(landing), []);
  assert.deepEqual(checkFrame({ ...landing, landing: false }).map((f) => f.check), ['frame-left', 'frame-right']);
  const missing = checkFrame({ header: { left: 16, right: 993 }, main: null, footer: { left: 16, right: 993 } });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].check, 'frame-missing');
  assert.match(missing[0].detail, /main/);
});

test('checkRuleEnds accepts rules that end on the text edges and reports the others', () => {
  const edges = { left: 16, right: 993 };
  const rules = [
    { selector: 'hr', left: 16, right: 993 },
    { selector: 'li.post-item', left: 158, right: 866 },
    { selector: 'details', left: 131.5, right: 992.5 },
  ];
  const failures = checkRuleEnds(rules, edges, 1009);
  assert.deepEqual(failures.map((f) => f.check), ['rule-ends', 'rule-ends']);
  assert.match(failures[0].detail, /li\.post-item 158-866/);
  assert.match(failures[0].detail, /16-993/);
  assert.match(failures[1].detail, /details 131\.5-992\.5/);
});

test('checkRuleEnds allows full-bleed dividers where the page says they are allowed', () => {
  const edges = { left: 16, right: 993 };
  const bleed = { selector: 'section.lp-section', left: 0, right: 1009, fullBleedAllowed: true };
  assert.deepEqual(checkRuleEnds([bleed], edges, 1009), []);
  assert.equal(checkRuleEnds([{ ...bleed, fullBleedAllowed: false }], edges, 1009).length, 1);
  // A half-width rule is not a full-bleed divider.
  assert.equal(checkRuleEnds([{ selector: 'x', left: 0, right: 500, fullBleedAllowed: true }], edges, 1009).length, 1);
});

test('checkRuleEnds compares a rule with its own column reference when it has one', () => {
  const edges = { left: 16, right: 993 };
  const column = { left: 16, right: 560 };
  const pager = { selector: 'ul', left: 16, right: 560, reference: column };
  assert.deepEqual(checkRuleEnds([pager], edges, 1009), []);
  // Without the reference the same rule is compared with the frame and fails.
  assert.equal(checkRuleEnds([{ ...pager, reference: null }], edges, 1009).length, 1);
  // A rule in the column that misses the column is still reported, against the column.
  const failures = checkRuleEnds([{ ...pager, right: 993 }], edges, 1009);
  assert.equal(failures.length, 1);
  assert.match(failures[0].detail, /16-560/);
});

test('checkRuleEnds reports rules on a page without frame edges once', () => {
  const failures = checkRuleEnds([{ selector: 'hr', left: 1, right: 2 }], null, 1009);
  assert.deepEqual(failures.map((f) => f.check), ['rule-ends']);
  assert.match(failures[0].detail, /no frame/);
});

test('checkScrollWidth wants the viewport width exactly', () => {
  assert.deepEqual(checkScrollWidth(375, 375), []);
  const failures = checkScrollWidth(412, 375);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].check, 'scroll-width');
  assert.match(failures[0].detail, /412/);
  assert.match(failures[0].detail, /375/);
});

test('expectedStatus is 404 for the 404 pages and 200 for all others', () => {
  assert.equal(expectedStatus('404'), 404);
  for (const site of SITES) {
    for (const page of site.pages) assert.equal(expectedStatus(page.name), page.name === '404' ? 404 : 200, `${site.id} ${page.name}`);
  }
});

test('checkStatus reports a page that answers with the wrong status', () => {
  assert.deepEqual(checkStatus(200, 'home'), []);
  assert.deepEqual(checkStatus(404, '404'), []);
  const typo = checkStatus(404, 'post-toc');
  assert.equal(typo.length, 1);
  assert.equal(typo[0].check, 'load');
  assert.match(typo[0].detail, /404/);
  assert.match(typo[0].detail, /200/);
  assert.equal(checkStatus(200, '404')[0].check, 'load');
  assert.match(checkStatus(undefined, 'home')[0].detail, /none/);
});

test('formatFailure prints one line with site, page, width, scheme and check', () => {
  const line = formatFailure({ site: 'ba3a.dev', page: 'home', width: 320, scheme: 'dark', check: 'scroll-width', detail: 'scrollWidth 400, viewport 320' });
  assert.equal(line, 'ba3a.dev home 320 dark scroll-width: scrollWidth 400, viewport 320');
  assert.ok(!line.includes('\n'));
});

test('browserCandidates puts CHROME_PATH first and covers the common installs', () => {
  const win = browserCandidates({ platform: 'win32', env: { CHROME_PATH: 'C:\\x\\chrome.exe', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\L' } });
  assert.equal(win[0], 'C:\\x\\chrome.exe');
  assert.ok(win.some((path) => /Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/.test(path)));
  assert.ok(win.some((path) => /Edge[\\/]Application[\\/]msedge\.exe$/.test(path)));
  const mac = browserCandidates({ platform: 'darwin', env: {} });
  assert.ok(mac.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  const linux = browserCandidates({ platform: 'linux', env: {} });
  assert.ok(linux.includes('/usr/bin/google-chrome'));
  assert.ok(linux.includes('/usr/bin/chromium'));
});

test('browserCandidates lists each path once when the environment variables share a base', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'c:\\program files',
    LOCALAPPDATA: 'C:\\Program Files',
    CHROME_PATH: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  };
  const list = browserCandidates({ platform: 'win32', env });
  assert.equal(new Set(list.map((path) => path.toLowerCase())).size, list.length);
  assert.equal(list.length, 3);
  assert.equal(list[0], env.CHROME_PATH);
});

test('pickBrowser returns the first existing candidate, or null', () => {
  assert.equal(pickBrowser({ platform: 'linux', env: {}, exists: (path) => path === '/usr/bin/chromium' }), '/usr/bin/chromium');
  assert.equal(pickBrowser({ platform: 'linux', env: {}, exists: () => false }), null);
  assert.equal(pickBrowser({ platform: 'linux', env: { CHROME_PATH: '/first' }, exists: (path) => path === '/first' }), '/first');
});

test('pickBrowser refuses a CHROME_PATH that does not exist instead of using another browser', () => {
  assert.throws(
    () => pickBrowser({ platform: 'linux', env: { CHROME_PATH: '/nonexistent' }, exists: (path) => path === '/usr/bin/chromium' }),
    /CHROME_PATH is set to "\/nonexistent", which does not exist/,
  );
});

test('parseArgs understands --help, --dist, --site and --page', () => {
  assert.deepEqual(parseArgs([]), { help: false, dist: null, sites: [], pages: [] });
  assert.deepEqual(parseArgs(['--help']), { help: true, dist: null, sites: [], pages: [] });
  assert.deepEqual(parseArgs(['--dist', 'out', '--site', 'ba3a.dev', '--site=my.ba3a.dev', '--page', 'home']), {
    help: false,
    dist: 'out',
    sites: ['ba3a.dev', 'my.ba3a.dev'],
    pages: ['home'],
  });
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
  assert.throws(() => parseArgs(['--dist']), /--dist needs a value/);
});

/** Runs main() with captured output. */
async function run(argv, lookup) {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, lookup);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A build folder with an index.html for the given sites. */
function fakeBuild(...sites) {
  const dir = mkdtempSync(join(tmpdir(), 'geometry-build-'));
  for (const site of sites) {
    mkdirSync(join(dir, site), { recursive: true });
    writeFileSync(join(dir, site, 'index.html'), '<!doctype html>');
  }
  return dir;
}

test('main --help prints the usage and returns 0 without looking for a browser', async () => {
  const lookup = { env: {}, exists: () => assert.fail('must not look for a browser') };
  const result = await run(['--help'], lookup);
  assert.equal(result.code, 0);
  assert.equal(result.out, USAGE);
  assert.match(result.out, /^Usage: node scripts\/geometry-check\.mjs/);
  assert.equal(result.err, '');
});

test('main returns 2 for an unknown option and prints the usage', async () => {
  const result = await run(['--bogus'], { env: {}, exists: () => false });
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown option --bogus/);
  assert.match(result.err, /Usage:/);
});

test('main returns 2 for an unknown site or page', async () => {
  const lookup = { env: {}, exists: () => false };
  const site = await run(['--site', 'nope.dev'], lookup);
  assert.equal(site.code, 2);
  assert.match(site.err, /unknown site "nope\.dev"/);
  const page = await run(['--page', 'nope'], lookup);
  assert.equal(page.code, 2);
  assert.match(page.err, /unknown page "nope"/);
});

test('main returns 2 when the build folder has no build', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'geometry-empty-'));
  try {
    const result = await run(['--dist', dist, '--site', 'ba3a.dev'], { env: {}, exists: () => true });
    assert.equal(result.code, 2);
    assert.match(result.err, /has no build/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('main returns 2 and names CHROME_PATH when no browser is found', async () => {
  const dist = fakeBuild('ba3a.dev');
  try {
    const result = await run(['--dist', dist, '--site', 'ba3a.dev'], { env: {}, exists: () => false });
    assert.equal(result.code, 2);
    assert.match(result.err, /no browser found/);
    assert.match(result.err, /CHROME_PATH/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('main returns 2 when CHROME_PATH is set but does not exist, even if another browser is installed', async () => {
  const dist = fakeBuild('ba3a.dev');
  try {
    const result = await run(['--dist', dist, '--site', 'ba3a.dev'], { env: { CHROME_PATH: '/nonexistent/chrome' }, exists: (path) => path !== '/nonexistent/chrome' });
    assert.equal(result.code, 2);
    assert.match(result.err, /CHROME_PATH is set to "\/nonexistent\/chrome", which does not exist/);
    assert.doesNotMatch(result.err, /no browser found/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
