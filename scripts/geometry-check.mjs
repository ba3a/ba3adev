// On-demand geometry check of both sites (polish-spec.md section 5). It is not part of
// `npm test`: it needs a Chromium-based browser, which this repository does not install.
//
//   node scripts/geometry-check.mjs [--dist <dir>] [--site <id>]... [--page <name>]... [--help]
//
// It serves a build (default `.cache/test-dist`, made by `npm run test:sites` or
// `coffer build --out .cache/test-dist`) on the loopback interface with `startServer` from
// coffer, opens each page of the matrix at the widths 320, 375, 768, 1024 and 1440 in the light
// and the dark colour scheme (emulated), and checks on each:
//
//   frame-left / frame-right   header, main and footer have equal left and right edges (`main` of
//                              a landing page is full-bleed and is left out);
//   rule-ends                  the left and right ends of every horizontal rule, that is the
//                              border-top / border-bottom of a block element without side
//                              borders, and every <hr>, coincide with the text edges within 1 px.
//                              The text edges are those of the header, except for a rule inside
//                              .docs-page: the docs prose column is capped at the reading measure,
//                              so such a rule is compared with the edges of the page's h1 (or
//                              first paragraph). Full-bleed dividers inside a landing page may
//                              touch the viewport edges. Not looked at: rules inside tables, code
//                              blocks and svg, and rules inside a boxed ancestor (an element with
//                              a visible left or right border, such as a card), whose dividers
//                              belong to the box and not to the page;
//   scroll-width               document.documentElement.scrollWidth equals the viewport width;
//   load                       the page answers 200, the 404 pages answer 404 (a wrong path would
//                              otherwise be measured as the server's 404 page and pass).
//
// The matrix (pages, widths, schemes) and the comparisons are in scripts/lib/geometry.mjs.
// --site and --page narrow the run to the given site ids and page names.
//
// The browser is taken from the environment variable CHROME_PATH (exit 2 when it is set but does
// not exist), else from the common install locations of Chrome, Edge and Chromium.
// playwright-core ships no browser, and this script downloads none.
//
// Output: one line per failing check, "<site> <page> <width> <scheme> <check>: <detail>", then a
// summary. Exit codes: 0 all checks passed, 1 a check failed, 2 the script was used wrongly or no
// browser or build was found.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startServer } from 'coffer';

import {
  browserCandidates,
  checkFrame,
  checkRuleEnds,
  checkScrollWidth,
  checkStatus,
  expandMatrix,
  formatFailure,
  parseArgs,
  pickBrowser,
} from './lib/geometry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export const USAGE = `Usage: node scripts/geometry-check.mjs [--dist <dir>] [--site <id>]... [--page <name>]...

  --dist <dir>   build output to serve, with one folder per site (default .cache/test-dist)
  --site <id>    check only this site (ba3a.dev, my.ba3a.dev); repeatable
  --page <name>  check only the pages with this name (for example home, post-toc); repeatable
  --help         print this text

Needs a Chromium-based browser: set CHROME_PATH or install Chrome or Edge in the usual place.
Exit codes: 0 passed, 1 a check failed, 2 wrong use, no browser or no build.`;

/**
 * Runs in the page. Reads the geometry the checks need; it must not use anything from this module.
 * @param {{ viewportWidth: number }} input
 */
function collectGeometry({ viewportWidth }) {
  /** @param {Element | null} el */
  const edgesOf = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { left: box.left, right: box.right };
  };
  const header = document.querySelector('body > header');
  const main = document.querySelector('main');
  const footer = document.querySelector('body > footer');
  const landing = Boolean(document.querySelector('main .landing'));

  /** @param {Element} el */
  const describe = (el) => {
    const classes = [...el.classList].slice(0, 2).map((name) => `.${name}`).join('');
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${classes}`;
  };
  /** @param {CSSStyleDeclaration} style @param {'Top' | 'Bottom' | 'Left' | 'Right'} side */
  const hasBorder = (style, side) => {
    const width = parseFloat(style[`border${side}Width`]);
    const kind = style[`border${side}Style`];
    if (!(width > 0) || kind === 'none' || kind === 'hidden') return false;
    const color = style[`border${side}Color`];
    return !/^rgba\(.*,\s*0\)$/.test(color) && color !== 'transparent';
  };

  /** @param {Element} el True when an ancestor below <body> has a visible left or right border. */
  const insideBox = (el) => {
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (hasBorder(style, 'Left') || hasBorder(style, 'Right')) return true;
    }
    return false;
  };
  const docsPage = document.querySelector('.docs-page');
  const docsColumn = docsPage ? edgesOf(docsPage.querySelector(':scope > h1') ?? docsPage.querySelector(':scope > p')) : null;

  /** @type {Map<string, { selector: string, left: number, right: number, fullBleedAllowed: boolean, reference: { left: number, right: number } | null, count: number }>} */
  const found = new Map();
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('table, pre, svg, template, script, style, [hidden], [aria-hidden="true"]')) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.display.startsWith('inline')) continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0) continue;
    const isHr = el.tagName === 'HR';
    const horizontal = hasBorder(style, 'Top') || hasBorder(style, 'Bottom');
    const boxed = hasBorder(style, 'Left') || hasBorder(style, 'Right');
    if (!isHr && (!horizontal || boxed)) continue;
    if (insideBox(el)) continue;
    const selector = describe(el);
    const fullBleedAllowed = Boolean(el.closest('.landing'));
    const reference = docsColumn && el.closest('.docs-page') ? docsColumn : null;
    const key = `${selector}|${Math.round(box.left)}|${Math.round(box.right)}|${fullBleedAllowed}|${reference !== null}`;
    const previous = found.get(key);
    if (previous) previous.count += 1;
    else found.set(key, { selector, left: box.left, right: box.right, fullBleedAllowed, reference, count: 1 });
  }
  const rules = [...found.values()].map(({ count, selector, ...rest }) => ({ ...rest, selector: count > 1 ? `${selector} (x${count})` : selector }));

  return {
    frame: { header: edgesOf(header), main: edgesOf(main), footer: edgesOf(footer), landing },
    rules,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth,
  };
}

/**
 * @param {string[]} argv
 * @param {{ out: (line: string) => void, err: (line: string) => void }} io
 * @param {{ env?: Record<string, string | undefined>, exists?: (path: string) => boolean }} [browserLookup] Where to look for the browser; tests inject it.
 * @returns {Promise<number>}
 */
export async function main(argv, io, { env = process.env, exists = existsSync } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.err(`geometry-check: ${error instanceof Error ? error.message : String(error)}`);
    io.err(USAGE);
    return 2;
  }
  if (options.help) {
    io.out(USAGE);
    return 0;
  }
  let cells;
  try {
    cells = expandMatrix({ sites: options.sites, pages: options.pages });
  } catch (error) {
    io.err(`geometry-check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (cells.length === 0) {
    io.err('geometry-check: no page matches --site and --page');
    return 2;
  }
  const dist = resolve(options.dist ?? join(root, '.cache', 'test-dist'));
  const siteIds = [...new Set(cells.map((cell) => cell.site))];
  for (const id of siteIds) {
    if (!existsSync(join(dist, id, 'index.html'))) {
      io.err(`geometry-check: ${join(dist, id)} has no build (run "coffer build --out .cache/test-dist" or "npm run test:sites")`);
      return 2;
    }
  }
  /** @type {string | null} */
  let executablePath;
  try {
    executablePath = pickBrowser({ env, exists });
  } catch (error) {
    io.err(`geometry-check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (!executablePath) {
    io.err('geometry-check: no browser found. Set CHROME_PATH to a Chrome, Edge or Chromium executable. Looked at:');
    for (const path of browserCandidates({ env })) io.err(`  ${path}`);
    return 2;
  }

  const { chromium } = await import('playwright-core');
  /** @type {{ close: () => Promise<void>, url: string }[]} */
  const servers = [];
  /** @type {import('playwright-core').Browser | undefined} */
  let browser;
  let failed = 0;
  let checked = 0;
  try {
    /** @type {Map<string, string>} */
    const urls = new Map();
    for (const id of siteIds) {
      const server = await startServer({ dir: join(dist, id), host: '127.0.0.1', port: 0 });
      servers.push(server);
      urls.set(id, server.url);
    }
    try {
      browser = await chromium.launch({ executablePath, headless: true });
    } catch (error) {
      io.err(`geometry-check: cannot start ${executablePath}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      return 2;
    }

    // Group by page and scheme: one load, then one resize per width.
    /** @type {Map<string, typeof cells>} */
    const groups = new Map();
    for (const cell of cells) {
      const key = `${cell.site}|${cell.page}|${cell.scheme}`;
      groups.set(key, [...(groups.get(key) ?? []), cell]);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const context = await browser.newContext({ colorScheme: /** @type {'light' | 'dark'} */ (first.scheme), viewport: { width: first.width, height: 900 } });
      const page = await context.newPage();
      try {
        const url = new URL(first.path, urls.get(first.site)).href;
        /** @type {string | null} */
        let loadError = null;
        try {
          const response = await page.goto(url, { waitUntil: 'load' });
          const [wrongStatus] = checkStatus(response?.status(), first.page);
          if (wrongStatus) loadError = wrongStatus.detail;
          else await page.evaluate(() => document.fonts.ready.then(() => true));
        } catch (error) {
          loadError = error instanceof Error ? error.message.split('\n')[0] : String(error);
        }
        for (const cell of group) {
          /** @type {{ check: string, detail: string }[]} */
          let problems;
          if (loadError) {
            problems = [{ check: 'load', detail: loadError }];
          } else {
            await page.setViewportSize({ width: cell.width, height: 900 });
            const geometry = await page.evaluate(collectGeometry, { viewportWidth: cell.width });
            const frame = geometry.frame;
            const edges = frame.header ?? frame.main ?? frame.footer;
            problems = [...checkFrame(frame), ...checkRuleEnds(geometry.rules, edges, cell.width), ...checkScrollWidth(geometry.scrollWidth, cell.width)];
          }
          checked += 1;
          if (problems.length > 0) failed += 1;
          for (const problem of problems) io.out(formatFailure({ ...cell, ...problem }));
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await Promise.all(servers.map((server) => server.close()));
  }

  io.out(`geometry-check: ${checked} page/width/scheme cells checked, ${failed} with failing checks`);
  return failed > 0 ? 1 : 0;
}

// Run as a script (not when a test imports it).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
