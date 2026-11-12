// Assertions about the theme of ba3a.dev (themes/ba3a). `npm run test:sites`
// builds the sites into `.cache/test-dist` first; these tests read the theme
// sources, the engine's templates and that output. Every colour used in the
// contrast checks is read from the theme's own stylesheet and theme.yaml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { parse as parseYaml } from 'yaml';
import { CARD_HEIGHT, CARD_WIDTH, createCardMaker, loadConfig } from 'coffer';

import { assertFrame } from './lib/frame.mjs';
import { contrastRatio, readRules, readSchemes } from './lib/wcag.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, '.cache', 'test-dist');
const themeDir = join(root, 'themes', 'ba3a');
const engineTheme = join(root, 'node_modules', 'coffer', 'theme');
const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
const site = /** @type {import('coffer').SiteConfig} */ (config.sites.find((candidate) => candidate.id === 'ba3a.dev'));

const AA_TEXT = 4.5;
const AA_UI = 3;

/**
 * @param {string} siteId
 * @param {string} file Path inside the site's output, with forward slashes.
 * @returns {string}
 */
function output(siteId, file) {
  const path = join(dist, siteId, ...file.split('/'));
  assert.ok(existsSync(path), `${siteId}/${file} exists in .cache/test-dist (run "npm run test:sites")`);
  return readFileSync(path, 'utf8');
}

/**
 * @param {string} directory
 * @returns {string[]} Paths below `directory`, relative to it, with forward slashes.
 */
function listFiles(directory) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full).map((name) => `${entry.name}/${name}`));
    else found.push(entry.name);
  }
  return found.sort();
}

const stylesheet = readFileSync(join(themeDir, 'assets', 'ba3a.css'), 'utf8');

/** The header element of a page. */
function headerOf(html) {
  const match = /<header class="site-header">([\s\S]*?)<\/header>/.exec(html);
  assert.ok(match, 'the page has the site header');
  return match[1];
}

// --- the page frame -----------------------------------------------------------
//
// The build has no layout engine, so these tests read the rules. The defect they
// guard against: the engine resolved `--coffer-measure` (68ch) in the font size of the
// element that used it, so the footer (smaller font) was narrower than the header and
// its text was indented, and the side padding of the header, main and footer put the
// rules outside the text. The three are now one frame (see lib/frame.mjs).

/** @param {string} selectors A selector list. @returns {string[]} */
function selectorParts(selectors) {
  return selectors.split(',').map((part) => part.trim());
}

/**
 * The rules that may differ from the frame, listed explicitly: the landing page, whose main is full-bleed and
 * whose header and footer take the width of its content column (see the landing tests below). There is no
 * table-of-contents exception: the floating table fits the narrow column.
 */
const FRAME_EXCEPTIONS = ['.landing'];

test('ba3a.dev: the header, main and the footer are one frame: one width group, no side padding, no width that depends on the footer\'s font', () => {
  const groups = assertFrame(stylesheet, { exceptions: FRAME_EXCEPTIONS });
  const rules = readRules(stylesheet);

  // The frame is one rule for the three elements.
  const frame = rules.filter((rule) => rule.media === null && rule.selector === '.site-header, .site-footer, main');
  assert.equal(frame.length, 1, 'exactly one top-level rule sets the frame of the header, main and the footer');
  assert.deepEqual(frame[0].declarations, {
    'box-sizing': 'border-box',
    width: 'min(100% - 2rem, var(--frame))',
    'max-width': 'none',
    'margin-inline': 'auto',
    'padding-inline': '0',
  });
  assert.ok(groups.size >= 2, 'the frame and the print reset are both width groups');
});

test('ba3a.dev: the narrow reading column is the default, the wide one is for a documentation sidebar and the projects card grid', () => {
  const rules = readRules(stylesheet);
  const defaults = rules.filter((rule) => rule.media === null && rule.selector === ':where(body)');
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].declarations['--frame'], 'var(--coffer-measure)');

  const wide = rules.filter((rule) => rule.media === null && rule.declarations['--frame'] === 'calc(var(--coffer-measure) + 20rem)');
  assert.equal(wide.length, 1, 'one rule sets the wide frame');
  // The :where() keeps the specificity low, so that the print rule wins.
  assert.deepEqual(selectorParts(wide[0].selector), ['body:where(:has(.docs-layout))', 'body:where(:has(main > .project-cards))']);

  const setters = rules.filter((rule) => '--frame' in rule.declarations);
  assert.equal(setters.length, 2, 'the frame width is set by the default and the wide rule only');
});

test('ba3a.dev: a post with a table of contents has no column of its own; the floating table is only for wide screens and fits the narrow column', () => {
  const rules = readRules(stylesheet);
  for (const rule of rules) {
    if (!rule.selector.includes('has-toc')) continue;
    assert.ok(!('--frame' in rule.declarations), `${rule.selector} does not set the frame width: it is the same as on every text page`);
    assert.ok(!selectorParts(rule.selector).some((part) => FRAME_PARTS.test(part)), `${rule.selector} does not style the frame`);
  }
  const toc = rules.filter((rule) => rule.selector.includes('has-toc'));
  assert.ok(toc.length > 0);
  assert.ok(toc.every((rule) => rule.media === '(min-width: 60rem)'), 'the floating table is for screens of 60rem and wider');

  // The text beside the table keeps a readable width: the measure (68ch, at least 34rem
  // at 16px root with a typical body font) minus the table and its gap.
  const table = toc.find((rule) => rule.selector === '.post-layout.has-toc .toc');
  assert.ok(table, 'the table is floated');
  assert.equal(table.declarations.float, 'right');
  const tableRem = Number.parseFloat(table.declarations.width);
  const gapRem = Number.parseFloat(table.declarations.margin.split(/\s+/)[3]);
  assert.ok(table.declarations.width.endsWith('rem') && tableRem + gapRem <= 17, 'the table and its gap take at most 17rem of the narrow column');
});

test('ba3a.dev: the footer text is left-aligned with the body text and the footer sets no width in its own font units', () => {
  const rules = readRules(stylesheet);
  const footer = rules.find((rule) => rule.media === null && rule.selector === '.site-footer' && 'text-align' in rule.declarations);
  assert.ok(footer, 'the footer sets its text alignment');
  assert.equal(footer.declarations['text-align'], 'left');
  for (const rule of rules.filter((candidate) => selectorParts(candidate.selector).includes('.site-footer'))) {
    assert.ok(!('font-size' in rule.declarations) || rule.media !== null, `${rule.selector} does not change the footer font, so the footer is as wide as the header`);
    for (const property of ['text-indent', 'padding-left', 'padding-inline', 'margin-left']) {
      assert.ok(!(property in rule.declarations) || /^(0|auto)$/.test(rule.declarations[property]), `${rule.selector} does not indent the footer text (${property})`);
    }
  }
});

test('ba3a.dev: print drops the page frame again, so the engine\'s print layout is not narrowed by the theme', () => {
  const print = readRules(stylesheet).filter((rule) => rule.media === 'print');
  const rule = print.find((candidate) => selectorParts(candidate.selector).includes('body main'));
  assert.ok(rule, 'a print rule resets the frame of main');
  assert.deepEqual(selectorParts(rule.selector).sort(), ['body .site-footer', 'body .site-header', 'body main']);
  assert.equal(rule.declarations['max-width'], 'none');
  assert.equal(rule.declarations.width, 'auto');
  assert.equal(rule.declarations.margin, '0');
});

const FRAME_PARTS = /(^|[\s>])(\.site-header|\.site-footer|main)$/;

// --- the landing exception ----------------------------------------------------
//
// A landing page is full-bleed: its sections run edge to edge, but the text of every
// section sits in .lp-wrap, a column of 1080px with 16px padding. The header and footer
// of the page (the frame above) take that column's width, so their rules end where the
// text of the sections ends; main is the only element that is wider.

const landingStylesheet = readFileSync(join(themeDir, 'assets', 'landing.css'), 'utf8');
const landingRules = readRules(landingStylesheet);

test('ba3a.dev: the exception list of the frame names the landing page only, and ba3a.css has no landing rule', () => {
  assert.deepEqual(FRAME_EXCEPTIONS, ['.landing']);
  const hidden = readRules(stylesheet).filter((rule) => FRAME_EXCEPTIONS.some((exception) => rule.selector.includes(exception)));
  assert.deepEqual(hidden.map((rule) => rule.selector), [], 'the landing rules are all in landing.css');
});

test('ba3a.dev landing: the frame is the content column of the sections, so the header and footer rules end where the text ends', () => {
  const setters = landingRules.filter((rule) => '--frame' in rule.declarations);
  assert.equal(setters.length, 1, 'one rule sets the frame of a landing page');
  assert.equal(setters[0].media, null);
  assert.equal(setters[0].selector, 'body:has(.landing)');
  assert.equal(setters[0].declarations['--frame'], '1048px');

  // 1048px is the content box of .lp-wrap: its max-width minus the padding on both sides.
  const wrap = landingRules.find((rule) => rule.media === null && rule.selector === '.lp-wrap');
  assert.ok(wrap, '.lp-wrap exists');
  const side = /^0 (\d+)px$/.exec(wrap.declarations.padding)?.[1];
  assert.ok(side, '.lp-wrap pads its two sides equally');
  assert.equal(Number.parseFloat(wrap.declarations['max-width']) - 2 * Number(side), 1048);
});

test('ba3a.dev landing: main stays full-bleed: no frame width, no auto margin, no padding', () => {
  const main = landingRules.filter((rule) => rule.media === null && selectorParts(rule.selector).includes('main:has(.landing)'));
  assert.equal(main.length, 1);
  assert.deepEqual(selectorParts(main[0].selector), ['main:has(.landing)', 'main:has(.landing) > article']);
  assert.deepEqual(main[0].declarations, { 'max-width': 'none', width: 'auto', 'margin-inline': '0', padding: '0' });
});

test('ba3a.dev landing: a section divider is the top border of a full-bleed section, and the FAQ column has the standard width', () => {
  const section = landingRules.find((rule) => rule.media === null && rule.selector === '.lp-section');
  assert.ok(section);
  assert.equal(section.declarations['border-top'], '1px solid var(--line)');
  assert.deepEqual(landingRules.filter((rule) => rule.selector === '.lp-s-faq .lp-wrap'), [], 'the details rules fill the column of the other sections');
});

// --- the links under the home page sections -----------------------------------
//
// The engine sets .all-projects to 0.9375rem (a rule shared with the licence line), leaves
// .all-posts at the inherited size, and sets .secondary-links to 0.875em, which is derived
// from whatever the parent is. The theme gives the two "all" links one size and one gap
// above, and the secondary line a stated rem size in the muted colour.

/**
 * The declaration a theme stylesheet gives a class at top level (not in a media query); the last rule
 * that lists the class on its own wins, as in the cascade for rules of equal specificity.
 *
 * @param {string} className
 * @param {string} property
 * @returns {string | undefined}
 */
function themeValue(className, property) {
  const rules = readRules(stylesheet).filter(
    (rule) => rule.media === null && selectorParts(rule.selector).includes(`.${className}`) && property in rule.declarations,
  );
  return rules.at(-1)?.declarations[property];
}

test('ba3a.dev: "All projects" and "All posts" have one font size and one gap above, in rem', () => {
  for (const property of ['font-size', 'margin-top']) {
    const projects = themeValue('all-projects', property);
    const posts = themeValue('all-posts', property);
    assert.ok(projects, `.all-projects sets ${property}`);
    assert.equal(projects, posts, `.all-projects and .all-posts have the same ${property}`);
    assert.match(projects, /^\d+(\.\d+)?rem$/, `${property} is a rem length, not derived from the parent`);
  }
  assert.equal(themeValue('all-projects', 'font-size'), '1rem');
  assert.equal(themeValue('all-projects', 'margin-top'), '1rem');
});

test('ba3a.dev: the secondary links are a muted, smaller line with a stated rem size and gap', () => {
  const size = themeValue('secondary-links', 'font-size');
  assert.equal(size, '0.875rem', 'a rem size, not the engine\'s em-derived one');
  assert.equal(themeValue('secondary-links', 'color'), 'var(--coffer-muted)');
  assert.match(themeValue('secondary-links', 'margin-top') ?? '', /^\d+(\.\d+)?rem$/, 'the gap above is stated');
  assert.ok(
    Number.parseFloat(size) < Number.parseFloat(/** @type {string} */ (themeValue('all-projects', 'font-size'))),
    'smaller than the section links',
  );
});

// --- the rule between the items of a post list --------------------------------
//
// The engine gives every `.post-item` a 1px rule below it, so the last item of a list closed the
// list with a rule right above the "All posts" link (home, blog index, tag and series pages). Both
// themes state the rule between items alike and drop it after the last item. The padding is left as
// the engine has it: 1rem below the last item plus the 1rem gap of the link below it is within 1px
// of the gap between two items (1rem, the rule, 1rem).

const myStylesheet = readFileSync(join(root, 'themes', 'my', 'assets', 'my.css'), 'utf8');

test('both themes: .post-item has the same 1px solid var(--coffer-border) rule below it, and the last item has none', () => {
  /** @type {string[]} */
  const borders = [];
  for (const [name, css] of [['ba3a.css', stylesheet], ['my.css', myStylesheet]]) {
    const top = readRules(css).filter((rule) => rule.media === null);
    const item = top.filter((rule) => rule.selector === '.post-item');
    assert.equal(item.length, 1, `${name} has one top-level .post-item rule`);
    assert.equal(item[0].declarations['border-bottom'], '1px solid var(--coffer-border)', `${name}: the rule between items`);
    borders.push(item[0].declarations['border-bottom']);

    const last = top.filter((rule) => rule.selector === '.post-item:last-child');
    assert.equal(last.length, 1, `${name} has one .post-item:last-child rule`);
    assert.equal(last[0].declarations['border-bottom'], '0', `${name}: no rule after the last item`);
    assert.ok(
      !('padding' in last[0].declarations || 'padding-bottom' in last[0].declarations),
      `${name}: the last item keeps the padding of the others`,
    );
    assert.ok(top.indexOf(last[0]) > top.indexOf(item[0]), `${name}: the last-child rule comes after the general one`);
  }
  assert.equal(new Set(borders).size, 1, 'one declaration on both sites');
});

// --- the contrast helper ------------------------------------------------------

test('the contrast helper follows WCAG 2.x', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#fff', '#fff'), 1);
  // #767676 on white is the darkest grey that still reaches 4.5:1; #777777 does not.
  assert.ok(contrastRatio('#767676', '#ffffff') >= AA_TEXT);
  assert.ok(contrastRatio('#777777', '#ffffff') < AA_TEXT);
  assert.equal(contrastRatio('#123456', '#abcdef'), contrastRatio('#abcdef', '#123456'));
});

// --- what the theme directory contains ---------------------------------------

test('the theme directory holds only styles, fonts, templates, UI strings, the card, the brand pictures and documentation', () => {
  const allowed = [
    /^README\.md$/,
    /^theme\.yaml$/,
    /^card\.svg\.njk$/,
    /^templates\/base\.njk$/,
    // The landing layout (see specloop-landing.test.mjs).
    /^templates\/project-tool\.njk$/,
    /^templates\/partials\/landing(-facts)?\.njk$/,
    /^i18n\/en\.yaml$/,
    /^assets\/landing\.css$/,
    /^assets\/(specloop|coffer)\/[a-z-]+\.(svg|ico|png)$/, // the brand pictures of the landing pages, copied from their brand kits
    /^assets\/brand\/[a-z0-9-]+\.(svg|png|ico)$/, // the logo and favicons of the site, generated by scripts/make-ba3a-brand.mjs
    /^assets\/ba3a\.css$/,
    /^assets\/fonts\/[a-z0-9-]+\.woff2$/,
    /^assets\/fonts\/OFL\.txt$/,
    /^assets\/fonts\/OFL-(Inter|JetBrains-Mono)\.txt$/, // the licenses of the fonts of the landing layout
    /^assets\/fonts\/OFL-Handjet\.txt$/, // the license of the Handjet font of the Faultory page, published with the theme
    /^fonts\/[A-Za-z0-9-]+\.ttf$/,
    /^fonts\/OFL\.txt$/,
  ];
  for (const file of listFiles(themeDir)) {
    assert.ok(
      allowed.some((pattern) => pattern.test(file)),
      `themes/ba3a/${file} is not an expected kind of theme file`,
    );
  }
  for (const required of ['templates/base.njk', 'assets/ba3a.css', 'theme.yaml', 'card.svg.njk', 'README.md']) {
    assert.ok(existsSync(join(themeDir, required)), `themes/ba3a/${required} exists`);
  }
});

test('the theme templates only extend the engine and override its blocks', () => {
  const templatesDir = join(themeDir, 'templates');
  const engineTemplatesDir = join(engineTheme, 'templates');
  const engineTemplates = listFiles(engineTemplatesDir);
  const engineLines = new Set(
    engineTemplates.flatMap((name) =>
      readFileSync(join(engineTemplatesDir, name), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 60),
    ),
  );

  // The landing layout (project-tool.njk and partials/) has its own test, in specloop-landing.test.mjs.
  for (const name of listFiles(templatesDir).filter((file) => !file.startsWith('partials/') && file !== 'project-tool.njk')) {
    const source = readFileSync(join(templatesDir, name), 'utf8');
    assert.ok(engineTemplates.includes(name), `${name} replaces an engine template`);
    assert.match(
      source.replace(/\{#[\s\S]*?#\}/g, '').trimStart(),
      new RegExp(`^\\{%-?\\s*extends\\s+"coffer:${name.replace('.', '\\.')}"\\s*-?%\\}`),
      `${name} starts by extending the engine's own ${name}`,
    );

    const engineBlocks = new Set(
      [...readFileSync(join(engineTemplatesDir, name), 'utf8').matchAll(/\{%-?\s*block\s+([a-z_]+)/g)].map((m) => m[1]),
    );
    const blocks = [...source.matchAll(/\{%-?\s*block\s+([a-z_]+)/g)].map((m) => m[1]);
    assert.ok(blocks.length > 0, `${name} overrides at least one block`);
    for (const block of blocks) assert.ok(engineBlocks.has(block), `${name}: block "${block}" exists in the engine's ${name}`);
    // The navigation is the point of the theme; the head only adds the stylesheet and the font.
    assert.ok(blocks.includes('nav'), 'the nav block of the header is overridden');
    assert.deepEqual(
      blocks.filter((block) => !['head', 'footer', 'nav'].includes(block)),
      [],
      `${name} overrides no block besides head, footer and nav`,
    );
    const footer = /\{%-?\s*block footer\s*-?%\}([\s\S]*?)\{%-?\s*endblock/.exec(source);
    assert.ok(footer && /\{\{\s*super\(\)/.test(footer[1]), 'the footer block keeps the engine footer with super()');
    const head = /\{%-?\s*block head\s*-?%\}([\s\S]*?)\{%-?\s*endblock/.exec(source);
    assert.ok(head && /\{\{\s*super\(\)\s*\}\}/.test(head[1]), 'the head block keeps the engine head with super()');

    for (const line of source.split('\n').map((text) => text.trim())) {
      assert.ok(!engineLines.has(line), `${name} copies a long line of an engine template: ${line}`);
    }
  }
});

test('the card template is the theme\'s own and is not a copy of the engine\'s', () => {
  const own = readFileSync(join(themeDir, 'card.svg.njk'), 'utf8');
  const engine = readFileSync(join(engineTheme, 'card.svg.njk'), 'utf8');
  assert.notEqual(own, engine);
  assert.match(own, /\{\{\s*titleLines|\{%\s*for line in titleLines/);
});

test('no theme file hard-codes a font host or a script', () => {
  for (const name of ['assets/ba3a.css', 'templates/base.njk', 'card.svg.njk']) {
    const source = readFileSync(join(themeDir, name), 'utf8');
    assert.doesNotMatch(source, /@import/, `${name} has no @import`);
    assert.doesNotMatch(source, /fonts\.(googleapis|gstatic)\.com|https?:\/\/(?!www\.w3\.org)/, `${name} names no external host`);
    assert.doesNotMatch(source, /<script/i, `${name} adds no script`);
  }
});

// --- the stylesheet, colours and contrast -------------------------------------

const CORE_VARIABLES = [
  '--coffer-bg',
  '--coffer-text',
  '--coffer-muted',
  '--coffer-accent',
  '--coffer-border',
  '--coffer-code-bg',
  '--coffer-code-fg',
];

test('the colours are set in the four places of the engine stylesheet, for light and dark', () => {
  const { light, darkMedia, darkChoice, lightChoice } = readSchemes(stylesheet);
  for (const variable of [...CORE_VARIABLES, '--ba3a-control-border']) {
    for (const [name, scheme] of Object.entries({ light, darkMedia, darkChoice, lightChoice })) {
      assert.match(scheme[variable] ?? '', /^#[0-9a-f]{6}$/i, `${variable} is a hex colour in ${name}`);
    }
  }
  assert.deepEqual(darkChoice, darkMedia, 'the dark colours are the same for the system setting and for the switch');
  const colourOnly = (/** @type {Record<string, string>} */ scheme) =>
    Object.fromEntries(Object.entries(scheme).filter(([name]) => !name.startsWith('--coffer-font')));
  assert.deepEqual(lightChoice, colourOnly(light), 'the light colours are the same on :root and when light is chosen');
  assert.equal(darkMedia['color-scheme'], 'dark');
  assert.equal(light['color-scheme'], 'light');
  for (const variable of ['--coffer-bg', '--coffer-text', '--coffer-accent']) {
    assert.notEqual(light[variable], darkMedia[variable], `${variable} differs between light and dark`);
  }
  assert.ok(
    readRules(stylesheet).some((rule) => rule.media === '(prefers-color-scheme: dark)'),
    'dark colours are applied through prefers-color-scheme',
  );
});

test('the theme has one accent, distinct from the default theme', () => {
  const { light, darkMedia } = readSchemes(stylesheet);
  const defaults = readSchemes(readFileSync(join(engineTheme, 'assets', 'coffer.css'), 'utf8'));
  assert.notEqual(light['--coffer-accent'].toLowerCase(), defaults.light['--coffer-accent'].toLowerCase());
  assert.notEqual(darkMedia['--coffer-accent'].toLowerCase(), defaults.darkMedia['--coffer-accent'].toLowerCase());
});

for (const [scheme, key] of /** @type {const} */ ([
  ['light', 'light'],
  ['dark', 'darkMedia'],
])) {
  test(`WCAG AA contrast of every colour pair in the ${scheme} scheme`, () => {
    const colours = readSchemes(stylesheet)[key];
    const bg = colours['--coffer-bg'];
    const codeBg = colours['--coffer-code-bg'];
    /** @type {Array<[string, string, string, number]>} foreground, background, use, minimum ratio */
    const pairs = [
      [colours['--coffer-text'], bg, 'body text', AA_TEXT],
      [colours['--coffer-muted'], bg, 'muted text (dates, footer, quotes)', AA_TEXT],
      [colours['--coffer-accent'], bg, 'links', AA_TEXT],
      [colours['--coffer-bg'], colours['--coffer-accent'], 'text on an accent button (the engine sets the page background on it)', AA_TEXT],
      [colours['--coffer-code-fg'], codeBg, 'code', AA_TEXT],
      [colours['--coffer-text'], codeBg, 'inline code', AA_TEXT],
      [colours['--coffer-muted'], codeBg, 'muted text on a code background', AA_TEXT],
      [colours['--coffer-accent'], codeBg, 'a link on a code background', AA_TEXT],
      [colours['--coffer-accent'], bg, 'focus outline and skip link border (non-text)', AA_UI],
      [colours['--ba3a-control-border'], bg, 'border of buttons and the search field (non-text)', AA_UI],
      [colours['--ba3a-control-border'], codeBg, 'border of a control on a code background (non-text)', AA_UI],
    ];
    for (const [foreground, background, use, minimum] of pairs) {
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= minimum, `${use}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1 (${scheme})`);
    }
  });
}

test('print always uses the engine\'s black on white, whatever scheme the reader chose', () => {
  const print = readRules(stylesheet).filter((rule) => rule.media === 'print');
  assert.ok(print.length > 0, 'the stylesheet has a print rule');
  const declared = Object.assign({}, ...print.map((rule) => rule.declarations));
  assert.equal(declared['--coffer-bg'], '#ffffff');
  assert.ok(contrastRatio(declared['--coffer-text'], declared['--coffer-bg']) >= AA_TEXT);
  assert.ok(print.some((rule) => /:root\[data-theme\]/.test(rule.selector)));
});

test('the card colours of theme.yaml have enough contrast', () => {
  const colours = /** @type {{ accent: string, card: Record<string, string> }} */ (
    parseYaml(readFileSync(join(themeDir, 'theme.yaml'), 'utf8'))
  );
  const { background, text, mutedText } = colours.card;
  assert.ok(contrastRatio(text, background) >= AA_TEXT, 'the page title on the card');
  assert.ok(contrastRatio(mutedText, background) >= AA_TEXT, 'the site title on the card');
  assert.ok(contrastRatio(colours.accent, background) >= AA_UI, 'the accent bars on the card');
  const { light, darkMedia } = readSchemes(stylesheet);
  assert.equal(colours.accent.toLowerCase(), darkMedia['--coffer-accent'].toLowerCase(), 'the card uses the dark accent of the site');
  assert.equal(background.toLowerCase(), darkMedia['--coffer-bg'].toLowerCase(), 'the card is as dark as the dark scheme');
  assert.notEqual(light['--coffer-accent'], undefined);
});

// --- fonts --------------------------------------------------------------------

test('the heading font is a real woff2 under the SIL OFL, with its license next to it', () => {
  const fontsDir = join(themeDir, 'assets', 'fonts');
  const woff2 = readdirSync(fontsDir).filter((name) => name.endsWith('.woff2'));
  assert.ok(woff2.length >= 2, 'a latin and a latin-ext subset');
  let total = 0;
  for (const name of woff2) {
    const bytes = readFileSync(join(fontsDir, name));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${name} starts with the woff2 signature`);
    total += bytes.length;
  }
  assert.ok(total < 150 * 1024, `the web fonts weigh ${total} bytes, under 150 KB`);

  for (const dir of [fontsDir, join(themeDir, 'fonts')]) {
    const license = readFileSync(join(dir, 'OFL.txt'), 'utf8');
    assert.match(license, /^Copyright 20\d\d The Manrope Project Authors/);
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(license, /Permission is hereby granted, free of charge/);
  }
  assert.equal(
    readFileSync(join(fontsDir, 'OFL.txt'), 'utf8'),
    readFileSync(join(themeDir, 'fonts', 'OFL.txt'), 'utf8'),
  );

  const ttf = readFileSync(join(themeDir, 'fonts', 'Manrope-Bold.ttf'));
  assert.equal(ttf.readUInt32BE(0), 0x00010000, 'the card font is a TrueType file');

  const readme = readFileSync(join(themeDir, 'README.md'), 'utf8');
  assert.match(readme, /https:\/\/github\.com\/sharanda\/manrope/);
  assert.match(readme, /@fontsource\/manrope/);
  assert.match(readme, /5\.\d+\.\d+/, 'the README names the version the files come from');
  assert.match(readme, /SIL Open Font License/);
});

test('the stylesheet declares the web font with swap and a fallback stack, from files that exist', () => {
  const faces = readRules(stylesheet).filter((rule) => rule.selector === '@font-face');
  assert.ok(faces.length >= 2);
  for (const face of faces) {
    assert.equal(face.declarations['font-display'], 'swap');
    assert.match(face.declarations['font-family'], /Manrope/);
    assert.equal(face.declarations['font-weight'], '700');
    assert.ok(face.declarations['unicode-range']);
    const url = /url\(\s*"?([^")]+)"?\s*\)\s*format\("woff2"\)/.exec(face.declarations.src);
    assert.ok(url, 'the source is a woff2 file');
    assert.ok(!/^[a-z]+:|^\//.test(url[1]), 'the address is relative to the stylesheet');
    assert.ok(existsSync(join(themeDir, 'assets', url[1])), `${url[1]} exists`);
  }
  const { light } = readSchemes(stylesheet);
  assert.match(light['--coffer-font-heading'], /^"?Manrope"?, /);
  assert.match(light['--coffer-font-heading'], /sans-serif$/);
});

// --- the built site -----------------------------------------------------------

test('ba3a.dev: pages load the theme stylesheet after the engine\'s and preload the heading font', () => {
  for (const file of ['index.html', 'devlog/index.html', '404.html', 'devlog/search/index.html']) {
    const html = output('ba3a.dev', file);
    const engineAt = html.indexOf('<link rel="stylesheet" href="/assets/coffer.css">');
    const themeAt = html.indexOf('<link rel="stylesheet" href="/assets/ba3a.css">');
    assert.ok(engineAt > 0, `${file} loads the engine stylesheet`);
    assert.ok(themeAt > engineAt, `${file} loads the theme stylesheet after it`);
    assert.match(
      html,
      /<link rel="preload" href="\/assets\/fonts\/manrope-latin-700\.woff2" as="font" type="font\/woff2" crossorigin>/,
    );
    assert.match(html, /<html lang="en">/);
  }
});

test('ba3a.dev: the built stylesheet and fonts are the theme\'s files', () => {
  assert.equal(output('ba3a.dev', 'assets/ba3a.css'), stylesheet);
  for (const name of readdirSync(join(themeDir, 'assets', 'fonts'))) {
    const built = join(dist, 'ba3a.dev', 'assets', 'fonts', name);
    assert.ok(existsSync(built), `assets/fonts/${name} is in the output`);
    assert.deepEqual(readFileSync(built), readFileSync(join(themeDir, 'assets', 'fonts', name)));
  }
  const engineCss = readFileSync(join(engineTheme, 'assets', 'coffer.css'), 'utf8');
  assert.equal(output('ba3a.dev', 'assets/coffer.css'), engineCss, 'the engine stylesheet is untouched');
});

test('ba3a.dev: the compact header has the wordmark, the navigation and the engine\'s theme switch', () => {
  const html = output('ba3a.dev', 'index.html');
  assert.match(html, /<a class="skip-link" href="#main">Skip to content<\/a>/);
  const header = headerOf(html);
  assert.match(header, /<a class="site-title"[^>]* href="\/"[^>]*>ba3a\.dev<\/a>/, 'the wordmark is the site name and links home');
  assert.match(header, /<nav aria-label="Main navigation">/);
  const links = [...header.matchAll(/<nav[\s\S]*?<\/nav>/g)].flatMap(([nav]) =>
    [...nav.matchAll(/<a\b([^>]*)href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[3], m[2]]),
  );
  const expected = [
    ...(site.projects ? [['Projects', `/${site.urls.projects}/`]] : []),
    ['Devlog', '/devlog/'],
    ['Search', '/devlog/search/'],
  ];
  assert.deepEqual(links, expected);
  assert.ok(!links.some(([label]) => label === 'Home'), 'the wordmark is the link home');
  assert.match(header, /<button type="button" class="theme-switch" data-theme-toggle /, 'the engine\'s theme switch is kept');
  assert.match(header, /data-label-dark="Theme: Dark"/);
  assert.equal(header.match(/<nav\b/g)?.length, 1);
  // Every link of the header goes to a page that exists in the output.
  for (const [, href] of links) {
    assert.ok(existsSync(join(dist, 'ba3a.dev', ...href.split('/').filter(Boolean), 'index.html')), `${href} exists`);
  }
});

test('ba3a.dev: the Projects link follows the site\'s project configuration', () => {
  const header = headerOf(output('ba3a.dev', 'index.html'));
  const hasLink = header.includes('>Projects</a>');
  assert.equal(hasLink, site.projects !== null, 'a Projects link exists exactly when the site has projects');
});

test('ba3a.dev has projects, so its navigation leads with the Projects link to the projects page', () => {
  assert.ok(site.projects, 'the site configures projects');
  const header = headerOf(output('ba3a.dev', 'index.html'));
  assert.match(header, /<nav aria-label="Main navigation">\s*<ul>\s*<li><a href="\/made\/">Projects<\/a><\/li>/);
  assert.ok(existsSync(join(dist, 'ba3a.dev', 'made', 'index.html')), 'the projects page exists');
});

test('ba3a.dev: the current section is marked in the navigation', () => {
  const devlog = headerOf(output('ba3a.dev', 'devlog/index.html'));
  assert.match(devlog, /<a href="\/devlog\/" aria-current="page">Devlog<\/a>/);
  assert.doesNotMatch(devlog, /<a href="\/devlog\/search\/" aria-current/);
  const home = headerOf(output('ba3a.dev', 'index.html'));
  assert.doesNotMatch(home, /aria-current/, 'no section is current on the home page');
});

test('ba3a.dev: the header has no inline style or script of its own', () => {
  const header = headerOf(output('ba3a.dev', 'index.html'));
  assert.doesNotMatch(header, /style=|<script/);
});

test('my.ba3a.dev does not use the ba3a.dev theme: nothing of it leaks into the other site', () => {
  const html = output('my.ba3a.dev', 'index.html');
  assert.doesNotMatch(html, /ba3a\.css|Manrope|manrope/);
  assert.ok(!existsSync(join(dist, 'my.ba3a.dev', 'assets', 'ba3a.css')));
  assert.ok(!existsSync(join(dist, 'my.ba3a.dev', 'assets', 'fonts', 'manrope-latin-700.woff2')));
});

// --- title cards --------------------------------------------------------------

test('the theme card renders at the right size in the theme colours, even for a long title', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'ba3a-card-'));
  try {
    const maker = createCardMaker({ themeDir, cacheDir, siteTitle: site.title });
    const colours = /** @type {{ accent: string, card: Record<string, string> }} */ (
      parseYaml(readFileSync(join(themeDir, 'theme.yaml'), 'utf8'))
    );
    const title =
      'A very long title about building a static site engine, a media store and a devlog that keeps going well past three lines of text';
    const card = maker.make(title);
    const { data, info } = await sharp(card.file).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, CARD_WIDTH);
    assert.equal(info.height, CARD_HEIGHT);
    /** @type {(x: number, y: number) => string} */
    const pixel = (x, y) => {
      const at = (y * info.width + x) * info.channels;
      return `#${[0, 1, 2].map((i) => data[at + i].toString(16).padStart(2, '0')).join('')}`;
    };
    assert.equal(pixel(CARD_WIDTH - 40, 300), colours.card.background.toLowerCase(), 'the background');
    assert.equal(pixel(8, 300), colours.accent.toLowerCase(), 'the accent bar');

    // Nothing is drawn in the right-hand margin: the title wrapped or shrank to fit.
    let drawn = 0;
    for (let y = 0; y < CARD_HEIGHT; y += 1) {
      for (let x = CARD_WIDTH - 60; x < CARD_WIDTH; x += 1) {
        if (pixel(x, y) !== colours.card.background.toLowerCase()) drawn += 1;
      }
    }
    assert.equal(drawn, 0, 'the right-hand margin of the card stays empty');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('the theme asset and font files have sane sizes', () => {
  for (const file of listFiles(themeDir)) {
    const size = statSync(join(themeDir, ...file.split('/'))).size;
    assert.ok(size < 200 * 1024, `${relative(root, join(themeDir, file))} is ${size} bytes`);
  }
});

// --- the brand pictures ------------------------------------------------------

test('ba3a.dev: pages declare the favicons, and the files are in the output', () => {
  for (const file of ['index.html', '404.html', 'devlog/index.html']) {
    const html = output('ba3a.dev', file);
    const ico = html.indexOf('<link rel="icon" href="/assets/brand/favicon.ico" sizes="any">');
    const svg = html.indexOf('<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">');
    assert.ok(ico > 0, `${file} links the .ico`);
    assert.ok(svg > ico, `${file} links the SVG icon after the .ico, so browsers that read SVG pick the SVG`);
    assert.ok(html.includes('<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">'), `${file} links the apple touch icon`);
  }
  for (const name of listFiles(join(themeDir, 'assets', 'brand'))) {
    const built = join(dist, 'ba3a.dev', 'assets', 'brand', name);
    assert.ok(existsSync(built), `assets/brand/${name} is in the output`);
    assert.deepEqual(readFileSync(built), readFileSync(join(themeDir, 'assets', 'brand', name)));
  }
});

test('a landing page links the favicons of its project only, never two sets', () => {
  for (const slug of ['coffer', 'specloop']) {
    const html = output('ba3a.dev', `made/${slug}/index.html`);
    assert.match(html, new RegExp(`<link rel="icon" href="/assets/${slug}/favicon\\.svg"`));
    assert.ok(!html.includes('/assets/brand/'), `${slug}: no favicon of the site`);
    assert.equal(html.match(/<link rel="icon"/g)?.length, 2, `${slug}: the .ico and the SVG of the project`);
  }
});

test('the mark before the wordmark is the light logo on light pages and the bare dark logo on dark pages', () => {
  const rules = readRules(stylesheet);
  const mark = (/** @type {string} */ selector, /** @type {string | null} */ media) => {
    const found = rules.filter((rule) => rule.selector === selector && rule.media === media);
    assert.equal(found.length, 1, `one rule "${selector}" (${media})`);
    return found[0].declarations;
  };
  const base = mark('.site-header .site-title::before', null);
  assert.equal(base.content, '""');
  assert.match(base.background, /^url\("brand\/logo\.svg"\)/);
  assert.match(mark('.site-header .site-title::before', '(prefers-color-scheme: dark)')['background-image'], /brand\/logo-dark\.svg/);
  assert.match(mark(':root[data-theme="dark"] .site-header .site-title::before', null)['background-image'], /brand\/logo-dark\.svg/);
  assert.match(mark(':root[data-theme="light"] .site-header .site-title::before', null)['background-image'], /brand\/logo\.svg/);
  for (const name of ['logo.svg', 'logo-dark.svg']) {
    assert.ok(existsSync(join(themeDir, 'assets', 'brand', name)), `${name} exists next to the stylesheet's brand/ path`);
  }
});

test('the logo colours contrast with the page: teal on the dark page, slate tile on the light page, teal on the tile', () => {
  const { light, darkMedia } = readSchemes(stylesheet);
  assert.ok(contrastRatio('#4fc8df', darkMedia['--coffer-bg']) >= AA_UI, 'the teal letter on the dark page');
  assert.ok(contrastRatio('#0c1320', light['--coffer-bg']) >= AA_UI, 'the slate tile on the light page');
  assert.ok(contrastRatio('#4fc8df', '#0c1320') >= AA_UI, 'the teal letter on the slate tile');
});

// --- the credit line ---------------------------------------------------------

test('ba3a.dev: the credit in the footer of every page links "coffer" to its page', () => {
  const root = join(dist, 'ba3a.dev');
  const pages = listFiles(root).filter((file) => file.endsWith('.html'));
  assert.ok(pages.length > 0);
  let credits = 0;
  for (const page of pages) {
    const html = readFileSync(join(root, ...page.split('/')), 'utf8');
    if (!html.includes('<footer class="site-footer">')) continue;
    credits += 1;
    assert.ok(
      html.includes('<p class="credit">Built with <a href="/made/coffer/">coffer</a></p>'),
      `${page}: the credit is "Built with coffer" with a link on "coffer"`,
    );
    assert.ok(!html.includes('Built with coffer'), `${page}: no unlinked credit`);
  }
  assert.ok(credits >= 10, `${credits} pages carry the credit`);
});
