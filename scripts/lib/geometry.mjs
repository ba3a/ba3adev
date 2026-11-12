// The matrix and the pure comparisons of scripts/geometry-check.mjs. Nothing here starts a
// browser or a server, so scripts/test/geometry.test.mjs runs without one.
//
// The matrix is the one of polish-spec.md section 5: both sites, a page of every type, five
// viewport widths, two colour schemes.

/** Viewport widths, in CSS pixels. */
export const WIDTHS = Object.freeze([320, 375, 768, 1024, 1440]);

/** Colour schemes, emulated through `prefers-color-scheme`. */
export const SCHEMES = Object.freeze(['light', 'dark']);

/** Two edges (or widths) closer than this, in pixels, coincide. */
export const EDGE_TOLERANCE = 1;

/**
 * The pages of each site. `name` is what the report and --page use; `path` is the address in the
 * build output. The 404 pages use an address that does not exist, so the server answers with its
 * own 404 page the way Cloudflare Pages does.
 */
export const SITES = Object.freeze([
  Object.freeze({
    id: 'ba3a.dev',
    pages: Object.freeze([
      Object.freeze({ name: 'home', path: '/' }),
      Object.freeze({ name: 'devlog', path: '/devlog/' }),
      Object.freeze({ name: 'post-toc', path: '/devlog/finally-built-me-a-site/' }),
      Object.freeze({ name: 'tag', path: '/devlog/tags/coffer/' }),
      Object.freeze({ name: 'series', path: '/devlog/series/ai-rebirth/' }),
      Object.freeze({ name: 'made', path: '/made/' }),
      Object.freeze({ name: 'tool-landing', path: '/made/coffer/' }),
      Object.freeze({ name: 'game', path: '/made/faultory/' }),
      Object.freeze({ name: 'docs', path: '/made/coffer/docs/markdown/' }),
      Object.freeze({ name: 'search', path: '/devlog/search/' }),
      Object.freeze({ name: '404', path: '/no-such-page/' }),
    ]),
  }),
  Object.freeze({
    id: 'my.ba3a.dev',
    pages: Object.freeze([
      Object.freeze({ name: 'home', path: '/' }),
      Object.freeze({ name: 'post', path: '/built-finally/' }),
      Object.freeze({ name: 'tags', path: '/tags/' }),
      Object.freeze({ name: 'search', path: '/search/' }),
      Object.freeze({ name: '404', path: '/no-such-page/' }),
    ]),
  }),
]);

/**
 * Every cell of the matrix: one page at one width in one colour scheme.
 *
 * @param {{ sites?: string[], pages?: string[] }} [filter] Site ids and page names to keep; empty keeps all.
 * @returns {{ site: string, page: string, path: string, width: number, scheme: string }[]}
 */
export function expandMatrix({ sites = [], pages = [] } = {}) {
  for (const id of sites) {
    if (!SITES.some((site) => site.id === id)) {
      throw new Error(`unknown site "${id}" (known: ${SITES.map((site) => site.id).join(', ')})`);
    }
  }
  const names = new Set(SITES.flatMap((site) => site.pages.map((page) => page.name)));
  for (const name of pages) {
    if (!names.has(name)) throw new Error(`unknown page "${name}" (known: ${[...names].join(', ')})`);
  }
  /** @type {{ site: string, page: string, path: string, width: number, scheme: string }[]} */
  const cells = [];
  for (const site of SITES) {
    if (sites.length > 0 && !sites.includes(site.id)) continue;
    for (const page of site.pages) {
      if (pages.length > 0 && !pages.includes(page.name)) continue;
      for (const scheme of SCHEMES) {
        for (const width of WIDTHS) cells.push({ site: site.id, page: page.name, path: page.path, width, scheme });
      }
    }
  }
  return cells;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} [tolerance]
 */
export function closeTo(a, b, tolerance = EDGE_TOLERANCE) {
  return Math.abs(a - b) <= tolerance;
}

/**
 * @typedef {{ left: number, right: number }} Edges
 * @typedef {{ check: string, detail: string }} Problem
 */

/** @param {number} n */
function px(n) {
  return String(Math.round(n * 100) / 100);
}

/**
 * Header, main and footer must have the same left and right edges. The header is the reference.
 * On a landing page `main` is full-bleed on purpose and is left out.
 *
 * @param {{ header: Edges | null, main: Edges | null, footer: Edges | null, landing?: boolean }} frame
 * @returns {Problem[]}
 */
export function checkFrame(frame) {
  const names = frame.landing ? ['header', 'footer'] : ['header', 'main', 'footer'];
  const missing = names.filter((name) => !frame[/** @type {'header' | 'main' | 'footer'} */ (name)]);
  if (missing.length > 0) return [{ check: 'frame-missing', detail: `no ${missing.join(', ')} element` }];
  /** @type {Problem[]} */
  const problems = [];
  const reference = /** @type {Edges} */ (frame.header);
  for (const side of /** @type {const} */ (['left', 'right'])) {
    const others = names.slice(1).filter((name) => !closeTo(/** @type {Edges} */ (frame[/** @type {'main' | 'footer'} */ (name)])[side], reference[side]));
    if (others.length === 0) continue;
    const values = names.map((name) => `${name} ${px(/** @type {Edges} */ (frame[/** @type {'header' | 'main' | 'footer'} */ (name)])[side])}`);
    problems.push({ check: `frame-${side}`, detail: `${side} edges differ: ${values.join(', ')}` });
  }
  return problems;
}

/**
 * The left and right ends of every horizontal rule must coincide with the text edges. A rule may
 * carry its own `reference`: the text edges of the column it sits in when that column is narrower
 * than the frame (the prose column of a docs page).
 *
 * @param {{ selector: string, left: number, right: number, fullBleedAllowed?: boolean, reference?: Edges | null }[]} rules
 * @param {Edges | null} edges The text edges of the page (the frame).
 * @param {number} viewportWidth
 * @returns {Problem[]}
 */
export function checkRuleEnds(rules, edges, viewportWidth) {
  if (!edges) {
    return rules.length > 0 ? [{ check: 'rule-ends', detail: `${rules.length} rules, but the page has no frame to compare them with` }] : [];
  }
  /** @type {Problem[]} */
  const problems = [];
  for (const rule of rules) {
    const target = rule.reference ?? edges;
    if (closeTo(rule.left, target.left) && closeTo(rule.right, target.right)) continue;
    if (rule.fullBleedAllowed && closeTo(rule.left, 0) && closeTo(rule.right, viewportWidth)) continue;
    problems.push({
      check: 'rule-ends',
      detail: `${rule.selector} ${px(rule.left)}-${px(rule.right)}, text edges ${px(target.left)}-${px(target.right)}`,
    });
  }
  return problems;
}

/**
 * @param {number} scrollWidth `document.documentElement.scrollWidth`
 * @param {number} viewportWidth
 * @returns {Problem[]}
 */
export function checkScrollWidth(scrollWidth, viewportWidth) {
  if (scrollWidth === viewportWidth) return [];
  return [{ check: 'scroll-width', detail: `scrollWidth ${scrollWidth}, viewport ${viewportWidth}` }];
}

/**
 * The HTTP status a page must answer with: 404 for the 404 pages, 200 for all others.
 *
 * @param {string} pageName
 */
export function expectedStatus(pageName) {
  return pageName === '404' ? 404 : 200;
}

/**
 * A page that answers with another status than expected is a wrong path (the server answers an
 * unknown address with its 404 page), so its geometry would be measured on the wrong page.
 *
 * @param {number | null | undefined} status
 * @param {string} pageName
 * @returns {Problem[]}
 */
export function checkStatus(status, pageName) {
  const expected = expectedStatus(pageName);
  if (status === expected) return [];
  return [{ check: 'load', detail: `HTTP status ${status ?? 'none'}, expected ${expected}` }];
}

/**
 * One line per failing check.
 *
 * @param {{ site: string, page: string, width: number, scheme: string, check: string, detail: string }} failure
 */
export function formatFailure({ site, page, width, scheme, check, detail }) {
  return `${site} ${page} ${width} ${scheme} ${check}: ${detail.replace(/\s+/g, ' ')}`;
}

/**
 * Places where a Chromium-based browser is usually installed, most wanted first.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 */
export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  /** @type {string[]} */
  const list = [];
  if (env.CHROME_PATH) list.push(env.CHROME_PATH);
  if (platform === 'win32') {
    const bases = [env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env.LOCALAPPDATA ?? ''].filter(Boolean);
    for (const base of bases) {
      list.push(`${base}\\Google\\Chrome\\Application\\chrome.exe`, `${base}\\Microsoft\\Edge\\Application\\msedge.exe`, `${base}\\Chromium\\Application\\chrome.exe`);
    }
  } else if (platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    );
  }
  // The environment variables may point at the same base; list each path once.
  const seen = new Set();
  return list.filter((path) => {
    const key = platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The browser to use: CHROME_PATH when set (it must exist, there is no fallback to another
 * browser), else the first common install location that exists, else null.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined>, exists: (path: string) => boolean }} options
 * @returns {string | null}
 * @throws {Error} when CHROME_PATH is set but does not exist
 */
export function pickBrowser({ platform = process.platform, env = process.env, exists }) {
  if (env.CHROME_PATH) {
    if (!exists(env.CHROME_PATH)) throw new Error(`CHROME_PATH is set to "${env.CHROME_PATH}", which does not exist`);
    return env.CHROME_PATH;
  }
  return browserCandidates({ platform, env }).find((path) => exists(path)) ?? null;
}

/**
 * @param {string[]} argv
 * @returns {{ help: boolean, dist: string | null, sites: string[], pages: string[] }}
 */
export function parseArgs(argv) {
  const options = { help: false, dist: /** @type {string | null} */ (null), sites: /** @type {string[]} */ ([]), pages: /** @type {string[]} */ ([]) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const match = /^(--dist|--site|--page)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown option ${arg}`);
    let value = match[2];
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${match[1]} needs a value`);
      i += 1;
    }
    if (match[1] === '--dist') options.dist = value;
    else if (match[1] === '--site') options.sites.push(value);
    else options.pages.push(value);
  }
  return options;
}
