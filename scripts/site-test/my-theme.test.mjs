// Assertions about the theme of my.ba3a.dev (themes/my) and how it differs from
// the theme of ba3a.dev. `npm run test:sites` builds the sites into
// `.cache/test-dist` first; these tests read the theme sources, the engine's
// templates and that output. Every colour used in the contrast checks is read
// from the theme's own stylesheet and theme.yaml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';
import nunjucks from 'nunjucks';
import sharp from 'sharp';
import { parse as parseYaml } from 'yaml';
import { CARD_HEIGHT, CARD_WIDTH, createCardMaker, loadConfig, readFontMetrics } from 'coffer';

import { contrastRatio, parseHex, readRules, readSchemes } from './lib/wcag.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, '.cache', 'test-dist');
const themeDir = join(root, 'themes', 'my');
const otherThemeDir = join(root, 'themes', 'ba3a');
const engineDir = join(root, 'node_modules', 'coffer');
const engineTheme = join(engineDir, 'theme');
const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
const site = /** @type {import('coffer').SiteConfig} */ (config.sites.find((candidate) => candidate.id === 'my.ba3a.dev'));

const AA_TEXT = 4.5;
const AA_UI = 3;

/**
 * Reads a text file with the line endings normalised, so that a checkout with
 * CRLF line endings gives the same result as one with LF.
 *
 * @param {string} path
 * @returns {string}
 */
function read(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * @param {string} siteId
 * @param {string} file Path inside the site's output, with forward slashes.
 * @returns {string}
 */
function output(siteId, file) {
  const path = join(dist, siteId, ...file.split('/'));
  assert.ok(existsSync(path), `${siteId}/${file} exists in .cache/test-dist (run "npm run test:sites")`);
  return read(path);
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
    if (entry.isDirectory()) {
      found.push(...listFiles(full).map((name) => `${entry.name}/${name}`));
    } else {
      found.push(entry.name);
    }
  }
  return found.sort();
}

/** @param {string} path */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** The header element of a page. */
function headerOf(/** @type {string} */ html) {
  const match = /<header class="site-header">([\s\S]*?)<\/header>/.exec(html);
  assert.ok(match, 'the page has the site header');
  return match[1];
}

/** The main element of a page. */
function mainOf(/** @type {string} */ html) {
  const match = /<main id="main">([\s\S]*?)<\/main>/.exec(html);
  assert.ok(match, 'the page has the main element');
  return match[1];
}

/** @param {string} html */
function textOf(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const stylesheet = read(join(themeDir, 'assets', 'my.css'));
const otherStylesheet = read(join(otherThemeDir, 'assets', 'ba3a.css'));
const themeStrings = /** @type {Record<string, Record<string, string>>} */ (parseYaml(read(join(themeDir, 'i18n', 'ru.yaml'))));
const engineRu = /** @type {Record<string, Record<string, string>>} */ (parseYaml(read(join(engineDir, 'i18n', 'ru.yaml'))));
const engineEn = /** @type {Record<string, Record<string, string>>} */ (parseYaml(read(join(engineDir, 'i18n', 'en.yaml'))));

/**
 * @param {string} value A CSS value such as `var(--coffer-accent)`.
 * @param {Record<string, string>} scheme
 * @returns {string} The hex colour the value stands for.
 */
function resolve(value, scheme) {
  const match = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  assert.ok(match, `${value} is a custom property reference`);
  const colour = scheme[match[1]];
  assert.ok(colour, `${match[1]} is defined in the scheme`);
  return colour;
}

/**
 * @param {string} selector
 * @returns {Record<string, string>} The declarations of the one top-level rule with this selector.
 */
function ruleOf(selector) {
  const found = readRules(stylesheet).filter((rule) => rule.selector === selector && rule.media === null);
  assert.equal(found.length, 1, `the stylesheet has exactly one top-level rule "${selector}"`);
  return found[0].declarations;
}

/** @param {string} colour @returns {number} Hue in degrees, 0 to 360. */
function hue(colour) {
  const [r, g, b] = parseHex(colour).map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/**
 * @param {string} ranges A CSS `unicode-range` value.
 * @param {number} codePoint
 */
function inRanges(ranges, codePoint) {
  return ranges.split(',').some((part) => {
    const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(part.trim());
    assert.ok(match, `${part} is a unicode range`);
    const from = Number.parseInt(match[1], 16);
    const to = match[2] ? Number.parseInt(match[2], 16) : from;
    return codePoint >= from && codePoint <= to;
  });
}

// --- what the theme directory contains ---------------------------------------

test('the theme directory holds only styles, fonts, brand pictures, the header template, UI strings, the card and documentation', () => {
  const allowed = [
    /^README\.md$/,
    /^theme\.yaml$/,
    /^card\.svg\.njk$/,
    /^templates\/base\.njk$/,
    /^i18n\/ru\.yaml$/,
    /^assets\/my\.css$/,
    /^assets\/fonts\/[a-z0-9-]+\.woff2$/,
    /^assets\/fonts\/OFL\.txt$/,
    /^assets\/brand\/[a-z0-9-]+\.(svg|png|ico)$/,
    /^fonts\/[A-Za-z0-9-]+\.ttf$/,
    /^fonts\/OFL\.txt$/,
  ];
  for (const file of listFiles(themeDir)) {
    assert.ok(
      allowed.some((pattern) => pattern.test(file)),
      `themes/my/${file} is not an expected kind of theme file`,
    );
  }
  for (const required of ['templates/base.njk', 'assets/my.css', 'theme.yaml', 'card.svg.njk', 'i18n/ru.yaml', 'README.md']) {
    assert.ok(existsSync(join(themeDir, required)), `themes/my/${required} exists`);
  }
});

test('the theme templates only extend the engine and override its head and nav blocks', () => {
  const templatesDir = join(themeDir, 'templates');
  const engineTemplatesDir = join(engineTheme, 'templates');
  const engineTemplates = listFiles(engineTemplatesDir);
  const engineLines = new Set(
    engineTemplates.flatMap((name) =>
      read(join(engineTemplatesDir, name))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 60),
    ),
  );

  for (const name of listFiles(templatesDir)) {
    const source = read(join(templatesDir, name));
    assert.ok(engineTemplates.includes(name), `${name} replaces an engine template`);
    assert.match(
      source.replace(/\{#[\s\S]*?#\}/g, '').trimStart(),
      new RegExp(`^\\{%-?\\s*extends\\s+"coffer:${name.replace('.', '\\.')}"\\s*-?%\\}`),
      `${name} starts by extending the engine's own ${name}`,
    );

    const engineBlocks = new Set([...read(join(engineTemplatesDir, name)).matchAll(/\{%-?\s*block\s+([a-z_]+)/g)].map((m) => m[1]));
    const blocks = [...source.matchAll(/\{%-?\s*block\s+([a-z_]+)/g)].map((m) => m[1]);
    for (const block of blocks) assert.ok(engineBlocks.has(block), `${name}: block "${block}" exists in the engine's ${name}`);
    // Overriding "header" and redeclaring the blocks nested in it would drop the theme switch.
    assert.deepEqual([...blocks].sort(), ['head', 'nav'], `${name} overrides head and nav and nothing else`);
    const head = /\{%-?\s*block head\s*-?%\}([\s\S]*?)\{%-?\s*endblock/.exec(source);
    assert.ok(head && /\{\{\s*super\(\)\s*\}\}/.test(head[1]), 'the head block keeps the engine head with super()');

    for (const line of source.split('\n').map((text) => text.trim())) {
      assert.ok(!engineLines.has(line), `${name} copies a long line of an engine template: ${line}`);
    }
  }
});

test('no theme file hard-codes a font host or a script', () => {
  for (const name of ['assets/my.css', 'templates/base.njk', 'card.svg.njk']) {
    const source = read(join(themeDir, name));
    assert.doesNotMatch(source, /@import/, `${name} has no @import`);
    assert.doesNotMatch(source, /fonts\.(googleapis|gstatic)\.com|https?:\/\/(?!www\.w3\.org)/, `${name} names no external host`);
    assert.doesNotMatch(source, /<script/i, `${name} adds no script`);
  }
});

test('the copy written for the author is marked to be rewritten', () => {
  assert.match(read(join(themeDir, 'i18n', 'ru.yaml')), /#\s*TODO: rewrite\s*\n\s*site:/, 'the tagline');
  assert.match(read(join(themeDir, 'i18n', 'ru.yaml')), /#\s*TODO: rewrite\s*\n\s*not_found:/, 'the 404 copy');
  assert.match(read(join(themeDir, 'templates', 'base.njk')), /TODO: rewrite/, 'the template points to the tagline');
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
  for (const variable of [...CORE_VARIABLES, '--my-control-border']) {
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

test('the palette is warm: a paper-coloured page and a terracotta accent in light, warm browns in dark', () => {
  const { light, darkMedia } = readSchemes(stylesheet);
  for (const [name, scheme] of Object.entries({ light, dark: darkMedia })) {
    const [r, , b] = parseHex(scheme['--coffer-bg']);
    assert.ok(r > b, `the ${name} page background leans warm (red above blue)`);
    const accentHue = hue(scheme['--coffer-accent']);
    assert.ok(accentHue >= 8 && accentHue <= 40, `the ${name} accent is terracotta or amber (hue ${accentHue.toFixed(0)})`);
  }
  assert.ok(relativeLightness(light['--coffer-bg']) > 0.9, 'the light page is paper-like: very light, but not pure white');
  assert.notEqual(light['--coffer-bg'].toLowerCase(), '#ffffff');
  assert.ok(relativeLightness(darkMedia['--coffer-bg']) < 0.15, 'the dark page is dark');
});

/** @param {string} colour @returns {number} Mean channel value, 0 to 1. */
function relativeLightness(colour) {
  const channels = parseHex(colour);
  return channels.reduce((sum, channel) => sum + channel, 0) / (3 * 255);
}

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
      [colours['--my-control-border'], bg, 'border of buttons and the search field (non-text)', AA_UI],
      [colours['--my-control-border'], codeBg, 'border of a control on a code background (non-text)', AA_UI],
    ];
    for (const [foreground, background, use, minimum] of pairs) {
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= minimum, `${use}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1 (${scheme})`);
    }
  });

  test(`WCAG AA contrast of the colours the header and the 404 page use, as declared in the stylesheet (${scheme})`, () => {
    const colours = readSchemes(stylesheet)[key];
    const bg = colours['--coffer-bg'];
    /** @type {Array<[string, string, string, string, number]>} selector, foreground property, background property or '', use, minimum */
    const uses = [
      ['.site-header .site-tagline', 'color', '', 'the tagline', AA_TEXT],
      ['.site-header nav a', 'color', '', 'a navigation link', AA_TEXT],
      ['.site-header nav a:hover', 'color', '', 'a hovered navigation link', AA_TEXT],
      ['.site-header nav a[aria-current="page"]', 'color', '', 'the current navigation link', AA_TEXT],
      ['.site-header .site-title:hover', 'color', '', 'the hovered site title', AA_TEXT],
      ['.not-found p', 'color', '', 'the 404 text', AA_TEXT],
      ['.not-found a', 'color', 'background', 'the 404 button', AA_TEXT],
      ['::selection', 'color', 'background', 'selected text', AA_TEXT],
    ];
    for (const [selector, foregroundProperty, backgroundProperty, use, minimum] of uses) {
      const declarations = ruleOf(selector);
      const foreground = resolve(declarations[foregroundProperty], colours);
      const background = backgroundProperty ? resolve(declarations[backgroundProperty], colours) : bg;
      const ratio = contrastRatio(foreground, background);
      assert.ok(ratio >= minimum, `${use} (${selector}): ${foreground} on ${background} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
    }
    // The 404 heading, the accent rule above it and the button border follow the text colour or the accent.
    assert.ok(contrastRatio(colours['--coffer-accent'], bg) >= AA_UI, 'the accent rule on the 404 page and the header');
    const rule = ruleOf('.not-found h1::before');
    assert.equal(rule.background, 'var(--coffer-accent)');
  });
}

test('the stylesheet uses no colour of its own outside the schemes, so every colour is one that is checked', () => {
  for (const rule of readRules(stylesheet)) {
    if (rule.selector === '@font-face') continue;
    if (rule.media === 'print') continue;
    if (/^:root/.test(rule.selector)) continue;
    for (const [property, value] of Object.entries(rule.declarations)) {
      assert.doesNotMatch(
        value,
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\bcolor\(/i,
        `${rule.selector} { ${property} } hard-codes a colour instead of using a custom property`,
      );
    }
  }
});

test('print always uses the engine\'s black on white, whatever scheme the reader chose', () => {
  const print = readRules(stylesheet).filter((rule) => rule.media === 'print');
  assert.ok(print.length > 0, 'the stylesheet has a print rule');
  const declared = Object.assign({}, ...print.map((rule) => rule.declarations));
  assert.equal(declared['--coffer-bg'], '#ffffff');
  assert.ok(contrastRatio(declared['--coffer-text'], declared['--coffer-bg']) >= AA_TEXT);
  assert.ok(print.some((rule) => /:root\[data-theme\]/.test(rule.selector)));
});

// --- the text column ----------------------------------------------------------
//
// The build has no layout engine, so these tests read the rules. The defect they
// guard against: the engine caps every child of `main` at `max-width:
// var(--coffer-measure)` (68ch), and `ch` is measured in the child's own font size,
// so centring each child with `margin: auto` gave every child its own width and
// indent, and a class rule such as `.tags-link { margin: 0 0 1rem }` beat the
// theme's `main > *` rule, so some children stayed at the left edge. The column
// must be centred once, as a whole, and every child of `main` must fill it.

const PAGE_ELEMENTS = ['.site-header', '.site-footer', 'main'];

/** @param {string} selectors A selector list. @returns {string[]} */
function selectorParts(selectors) {
  return selectors.split(',').map((part) => part.trim());
}

test('the text column is not centred child by child: no rule gives anything in main an automatic side margin', () => {
  const offenders = [];
  for (const rule of readRules(stylesheet)) {
    if (!selectorParts(rule.selector).some((part) => /(^|[\s>+~(])main\b/.test(part) && part !== 'main')) continue;
    for (const [property, value] of Object.entries(rule.declarations)) {
      if (/^margin(-left|-right|-inline|-inline-start|-inline-end)?$/.test(property) && /\bauto\b/.test(value)) {
        offenders.push(`${rule.selector} { ${property}: ${value} }`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'a child of main is centred by its own margin, so its indent depends on its font size');
});

test('the header, main and the footer share one width, as the engine centres them, and the children of main fill it', () => {
  const rules = readRules(stylesheet).filter((rule) => rule.media === null);
  const widthOf = (/** @type {string} */ selector) => {
    const found = rules.filter((rule) => rule.selector === selector && rule.declarations['max-width']);
    assert.equal(found.length, 1, `exactly one top-level rule "${selector}" sets max-width`);
    return found[0].declarations['max-width'];
  };

  // The narrow column: the engine's measure plus the side padding of 1rem each side.
  const narrow = widthOf('.site-header, .site-footer, main');
  assert.equal(narrow, 'calc(var(--coffer-measure) + 2rem)');

  // Every rule that sets a max-width on one of the three elements sets it on all three.
  /** @type {Map<string, Set<string>>} */
  const groups = new Map();
  for (const rule of rules) {
    if (!rule.declarations['max-width']) continue;
    for (const part of selectorParts(rule.selector)) {
      const element = PAGE_ELEMENTS.find((candidate) => part === candidate || part.endsWith(` ${candidate}`));
      if (!element) continue;
      const prefix = part.slice(0, part.length - element.length).trim();
      const key = `${prefix}|${rule.declarations['max-width']}`;
      groups.set(key, (groups.get(key) ?? new Set()).add(element));
    }
  }
  assert.ok(groups.size >= 2, 'the narrow and the wide widths are both declared');
  for (const [key, elements] of groups) {
    assert.deepEqual([...elements].sort(), [...PAGE_ELEMENTS].sort(), `"${key}" sets the width of the header, main and the footer together`);
  }

  // The wide width is the engine's own, for the pages with a second column, and is
  // chosen by a selector with no specificity of its own, so the print rule wins.
  const wide = [...groups.keys()].find((key) => key.includes('has-toc'));
  assert.ok(wide, 'a page with a table of contents gets a wider column');
  assert.ok(wide.includes(':where(:has(.post-layout.has-toc))'));
  assert.ok(wide.endsWith('calc(var(--coffer-measure) + 22rem)'));
  const engineFrame = readRules(read(join(engineTheme, 'assets', 'coffer.css'))).find((rule) => rule.selector === '.site-header, .site-footer, main' && rule.media === null);
  assert.ok(engineFrame, 'the engine styles the header, main and the footer together');
  assert.equal(engineFrame.declarations['max-width'], 'calc(var(--coffer-measure) + 22rem)', 'the wide width is the engine\'s own');

  // The children fill the column instead of keeping their own measure.
  assert.equal(ruleOf('main > *')['max-width'], 'none');
});

test('the rule that lets the children of main fill the column is not beaten by the engine\'s rules', () => {
  const engine = readRules(read(join(engineTheme, 'assets', 'coffer.css')));
  // The engine's measure for the children of main has the same specificity as the
  // theme's rule, and the theme's stylesheet is loaded later, so the theme's wins.
  assert.ok(engine.some((rule) => rule.media === null && selectorParts(rule.selector).includes('main > *') && rule.declarations['max-width'] === 'var(--coffer-measure)'));
  // No engine rule with a class selector sets a side margin or a width on a direct
  // child of main in a way the single rule of the theme would lose to.
  const maxWidthSelectors = engine
    .filter((rule) => rule.media === null && rule.declarations['max-width'] && rule.declarations['max-width'] !== 'none')
    .flatMap((rule) => selectorParts(rule.selector))
    .filter((part) => /^\.(tags-link|feed-link|breadcrumbs|post-tags|tag-count|tag-description|empty|post-list|tag-tree|search|not-found)$/.test(part));
  assert.deepEqual(maxWidthSelectors, [], 'no class rule of the engine sets a max-width on the direct children of the pages');
  const stylesheetOrder = ['coffer.css', 'my.css'].map((name) => output('my.ba3a.dev', 'index.html').indexOf(`/${name}`));
  assert.ok(stylesheetOrder[0] > 0 && stylesheetOrder[0] < stylesheetOrder[1], 'the theme stylesheet comes after the engine\'s');
});

test('print drops the page width again, so the engine\'s print layout is not narrowed by the theme', () => {
  const print = readRules(stylesheet).filter((rule) => rule.media === 'print');
  const rule = print.find((candidate) => selectorParts(candidate.selector).includes('body main'));
  assert.ok(rule, 'a print rule resets the width of main');
  assert.deepEqual(selectorParts(rule.selector).sort(), ['body .site-footer', 'body .site-header', 'body main']);
  assert.equal(rule.declarations['max-width'], 'none');
});

test('the card colours of theme.yaml have enough contrast and are the light scheme of the site', () => {
  const colours = /** @type {{ accent: string, card: Record<string, string> }} */ (parseYaml(read(join(themeDir, 'theme.yaml'))));
  const { background, text, mutedText } = colours.card;
  assert.ok(contrastRatio(text, background) >= AA_TEXT, 'the page title on the card');
  assert.ok(contrastRatio(mutedText, background) >= AA_TEXT, 'the site title on the card');
  assert.ok(contrastRatio(colours.accent, background) >= AA_UI, 'the frame and the rule on the card');
  const { light } = readSchemes(stylesheet);
  assert.equal(colours.accent.toLowerCase(), light['--coffer-accent'].toLowerCase(), 'the card uses the accent of the site');
  assert.equal(background.toLowerCase(), light['--coffer-bg'].toLowerCase(), 'the card is the paper of the site');
  assert.equal(text.toLowerCase(), light['--coffer-text'].toLowerCase());
  assert.equal(mutedText.toLowerCase(), light['--coffer-muted'].toLowerCase());
});

// --- the two sites differ at a glance ----------------------------------------

/** @param {string} css @param {'--coffer-font-body' | '--coffer-font-heading'} variable */
function fontFamilyOf(css, variable) {
  const { light } = readSchemes(css);
  const value = light[variable];
  // The ba3a.dev theme does not set the body font, so the engine's default applies.
  if (value) return value;
  const defaults = readSchemes(read(join(engineTheme, 'assets', 'coffer.css'))).light;
  return defaults[variable];
}

test('the two themes differ in accent, background, text colour, typefaces and kind of typeface', () => {
  const mine = readSchemes(stylesheet);
  const theirs = readSchemes(otherStylesheet);
  for (const [name, a, b] of /** @type {const} */ ([
    ['light', mine.light, theirs.light],
    ['dark', mine.darkMedia, theirs.darkMedia],
  ])) {
    for (const variable of ['--coffer-accent', '--coffer-bg', '--coffer-text']) {
      assert.notEqual(a[variable].toLowerCase(), b[variable].toLowerCase(), `${variable} differs in ${name}`);
    }
    // Not a near miss: the accents are different colours, a clearly different hue.
    const gap = Math.abs(hue(a['--coffer-accent']) - hue(b['--coffer-accent']));
    assert.ok(Math.min(gap, 360 - gap) > 60, `the ${name} accents differ in hue by more than 60 degrees (${gap.toFixed(0)})`);
  }
  for (const variable of /** @type {const} */ (['--coffer-font-heading', '--coffer-font-body'])) {
    const own = fontFamilyOf(stylesheet, variable);
    const other = fontFamilyOf(otherStylesheet, variable);
    assert.notEqual(own.split(',')[0].trim(), other.split(',')[0].trim(), `${variable}: the first family differs`);
  }
  assert.match(fontFamilyOf(stylesheet, '--coffer-font-heading'), /^"Literata", .*\bserif$/, 'headings are set in a serif');
  assert.match(fontFamilyOf(stylesheet, '--coffer-font-body'), /^"Literata", .*\bserif$/, 'the text is set in a serif');
  assert.match(fontFamilyOf(otherStylesheet, '--coffer-font-heading'), /sans-serif$/, 'the other site is sans-serif');
});

test('the two sites differ in the markup of the header and in the stylesheet they load', () => {
  const mine = headerOf(output('my.ba3a.dev', 'index.html'));
  const theirs = headerOf(output('ba3a.dev', 'index.html'));
  const classes = (/** @type {string} */ html) => new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  assert.ok(classes(mine).has('site-tagline'), 'this site has a tagline in the header');
  assert.ok(!classes(theirs).has('site-tagline'), 'the other site has none');
  assert.notEqual(
    mine.replace(/>[^<]*</g, '><'),
    theirs.replace(/>[^<]*</g, '><'),
    'the structure of the two headers is not the same',
  );
  assert.match(output('my.ba3a.dev', 'index.html'), /\/assets\/my\.css/);
  assert.doesNotMatch(output('my.ba3a.dev', 'index.html'), /ba3a\.css/);
  assert.match(output('ba3a.dev', 'index.html'), /\/assets\/ba3a\.css/);
  assert.doesNotMatch(output('ba3a.dev', 'index.html'), /my\.css|literata/i);

  // The header is centred in this theme and is a compact row in the other.
  const header = ruleOf('.site-header');
  assert.equal(header['text-align'], 'center');
  assert.equal(header['justify-content'], 'center');
  assert.equal(ruleOf('.site-header .site-title').flex, '0 0 100%', 'the title takes the whole first row');
  assert.equal(ruleOf('.site-header .site-tagline').flex, '0 0 100%', 'the tagline takes the whole second row');
  assert.ok(!readRules(otherStylesheet).some((rule) => rule.selector === '.site-header' && rule.declarations['text-align'] === 'center'));
});

// --- fonts --------------------------------------------------------------------

test('the web fonts are real woff2 files under the SIL OFL, with Latin, Cyrillic and Cyrillic extended subsets', () => {
  const fontsDir = join(themeDir, 'assets', 'fonts');
  const woff2 = readdirSync(fontsDir).filter((name) => name.endsWith('.woff2'));
  let total = 0;
  for (const name of woff2) {
    const bytes = readFileSync(join(fontsDir, name));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${name} starts with the woff2 signature`);
    total += bytes.length;
  }
  assert.ok(total < 150 * 1024, `the web fonts weigh ${total} bytes, under 150 KB`);
  for (const subset of ['latin', 'cyrillic', 'cyrillic-ext']) {
    for (const face of ['400-normal', '400-italic', '700-normal']) {
      assert.ok(woff2.includes(`literata-${subset}-${face}.woff2`), `the ${subset} subset of ${face} is shipped`);
    }
  }

  for (const dir of [fontsDir, join(themeDir, 'fonts')]) {
    const license = read(join(dir, 'OFL.txt'));
    assert.match(license, /^Copyright 20\d\d The Literata Project Authors/);
    assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(license, /Permission is hereby granted, free of charge/);
    // Literata has no Reserved Font Name, so converting the files is allowed under the same name.
    const copyrightLine = license.split('\n')[0];
    assert.doesNotMatch(copyrightLine, /Reserved Font Name/i);
  }
  assert.equal(read(join(fontsDir, 'OFL.txt')), read(join(themeDir, 'fonts', 'OFL.txt')));
});

test('the card font is a TrueType file with Latin and Cyrillic letters, so Russian titles do not turn into boxes', () => {
  const ttfPath = join(themeDir, 'fonts', 'Literata-Bold.ttf');
  assert.equal(readFileSync(ttfPath).readUInt32BE(0), 0x00010000, 'the card font is a TrueType file');
  const metrics = readFontMetrics(ttfPath);
  assert.equal(metrics.family, 'Literata');
  assert.equal(metrics.weight, 700);
  const needed = [
    ...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя',
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    ...'«»—–…№&<>"\'.,:;!?()-',
  ];
  for (const char of needed) assert.ok(metrics.has(/** @type {number} */ (char.codePointAt(0))), `the card font has a glyph for ${char}`);
});

test('the web font files and the card font are exactly the ones the README records, with their checksums', () => {
  const readme = read(join(themeDir, 'README.md'));
  const files = [
    ...readdirSync(join(themeDir, 'assets', 'fonts'))
      .filter((name) => name.endsWith('.woff2'))
      .map((name) => join(themeDir, 'assets', 'fonts', name)),
    join(themeDir, 'fonts', 'Literata-Bold.ttf'),
  ];
  assert.ok(files.length >= 10);
  for (const file of files) {
    const name = file.split(/[\\/]/).at(-1);
    const row = readme.split('\n').find((line) => line.includes(`${name}`) && /[0-9a-f]{64}/.test(line));
    assert.ok(row, `the README lists ${name} with a SHA-256`);
    assert.ok(row.includes(sha256(file)), `the SHA-256 of ${name} in the README is the file's`);
  }
  assert.match(readme, /https:\/\/github\.com\/googlefonts\/literata/);
  assert.match(readme, /@fontsource\/literata/);
  assert.match(readme, /5\.\d+\.\d+/, 'the README names the version the files come from');
  assert.match(readme, /SIL Open Font License/);
  assert.match(readme, /Reserved Font Name/);
});

test('the stylesheet declares every web font file with swap, the right unicode range and a serif fallback stack', () => {
  const faces = readRules(stylesheet).filter((rule) => rule.selector === '@font-face');
  const fontsDir = join(themeDir, 'assets', 'fonts');
  const shipped = readdirSync(fontsDir).filter((name) => name.endsWith('.woff2'));
  /** @type {string[]} */
  const used = [];
  for (const face of faces) {
    assert.equal(face.declarations['font-display'], 'swap');
    assert.equal(face.declarations['font-family'], '"Literata"');
    assert.ok(['400', '700'].includes(face.declarations['font-weight']));
    assert.ok(['normal', 'italic'].includes(face.declarations['font-style']));
    assert.ok(face.declarations['unicode-range']);
    const url = /url\(\s*"?([^")]+)"?\s*\)\s*format\("woff2"\)/.exec(face.declarations.src);
    assert.ok(url, 'the source is a woff2 file');
    assert.ok(!/^[a-z]+:|^\//.test(url[1]), 'the address is relative to the stylesheet');
    assert.ok(existsSync(join(themeDir, 'assets', url[1])), `${url[1]} exists`);
    // The file matches the face: weight, style and subset are in its name.
    const style = face.declarations['font-style'];
    assert.match(url[1], new RegExp(`-${face.declarations['font-weight']}-${style}\\.woff2$`));
    used.push(url[1].replace('fonts/', ''));
  }
  assert.deepEqual([...used].sort(), [...shipped].sort(), 'every shipped font file is declared, and every declared file is shipped');

  // Every letter of the Russian alphabet is in the range of the Cyrillic face of each style, and no Cyrillic letter in a Latin face.
  const russian = [...'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя№'];
  for (const [weight, style] of [['400', 'normal'], ['400', 'italic'], ['700', 'normal']]) {
    const cyrillic = faces.find((face) => face.declarations.src.includes(`literata-cyrillic-${weight}-${style}.woff2`));
    const latin = faces.find((face) => face.declarations.src.includes(`literata-latin-${weight}-${style}.woff2`));
    const ext = faces.find((face) => face.declarations.src.includes(`literata-cyrillic-ext-${weight}-${style}.woff2`));
    assert.ok(cyrillic && latin && ext, `${weight} ${style} has Latin, Cyrillic and Cyrillic extended faces`);
    for (const char of russian) {
      assert.ok(inRanges(cyrillic.declarations['unicode-range'], /** @type {number} */ (char.codePointAt(0))), `${char} is in the Cyrillic range (${weight} ${style})`);
      assert.ok(!inRanges(latin.declarations['unicode-range'], /** @type {number} */ (char.codePointAt(0))), `${char} is not in the Latin range`);
    }
    for (const char of '«»—ABCabc.,') {
      assert.ok(inRanges(latin.declarations['unicode-range'], /** @type {number} */ (char.codePointAt(0))), `${char} is in the Latin range (${weight} ${style})`);
    }
    assert.ok(inRanges(ext.declarations['unicode-range'], 0x0482), 'the extended range holds historic and non-Russian Cyrillic');
  }

  const { light } = readSchemes(stylesheet);
  for (const variable of ['--coffer-font-heading', '--coffer-font-body']) {
    assert.match(light[variable], /^"Literata", /);
    assert.match(light[variable], /Georgia/);
    assert.match(light[variable], /serif$/);
  }
});

// --- the built site -----------------------------------------------------------

test('my.ba3a.dev: pages load the theme stylesheet after the engine\'s and preload the Cyrillic fonts', () => {
  for (const file of ['index.html', '404.html', 'search/index.html']) {
    const html = output('my.ba3a.dev', file);
    const engineAt = html.indexOf('<link rel="stylesheet" href="/assets/coffer.css">');
    const themeAt = html.indexOf('<link rel="stylesheet" href="/assets/my.css">');
    assert.ok(engineAt > 0, `${file} loads the engine stylesheet`);
    assert.ok(themeAt > engineAt, `${file} loads the theme stylesheet after it`);
    for (const weight of ['400', '700']) {
      assert.ok(
        html.includes(
          `<link rel="preload" href="/assets/fonts/literata-cyrillic-${weight}-normal.woff2" as="font" type="font/woff2" crossorigin>`,
        ),
        `${file} preloads the Cyrillic ${weight} font with crossorigin`,
      );
    }
    assert.match(html, /<html lang="ru">/);
  }
});

test('my.ba3a.dev: the built stylesheet and fonts are the theme\'s files and the engine stylesheet is untouched', () => {
  assert.equal(output('my.ba3a.dev', 'assets/my.css'), stylesheet);
  for (const name of readdirSync(join(themeDir, 'assets', 'fonts'))) {
    const built = join(dist, 'my.ba3a.dev', 'assets', 'fonts', name);
    assert.ok(existsSync(built), `assets/fonts/${name} is in the output`);
    assert.deepEqual(readFileSync(built), readFileSync(join(themeDir, 'assets', 'fonts', name)));
  }
  assert.equal(output('my.ba3a.dev', 'assets/coffer.css'), read(join(engineTheme, 'assets', 'coffer.css')));
  assert.ok(!existsSync(join(dist, 'my.ba3a.dev', 'assets', 'ba3a.css')));
  assert.ok(!existsSync(join(dist, 'my.ba3a.dev', 'assets', 'fonts', 'manrope-latin-700.woff2')));
});

test('my.ba3a.dev: the header is the title, a tagline, the navigation without project links and the engine\'s theme switch', () => {
  const html = output('my.ba3a.dev', 'index.html');
  assert.match(html, /<a class="skip-link" href="#main">Перейти к содержимому<\/a>/);
  const header = headerOf(html);
  assert.match(header, /^\s*<a class="site-title" href="\/">ba3a<\/a>/, 'the title links home and comes first');
  const tagline = /<p class="site-tagline">([^<]+)<\/p>/.exec(header);
  assert.ok(tagline, 'the header has a tagline');
  assert.equal(tagline[1], themeStrings.site.tagline);
  assert.match(tagline[1], /[А-Яа-яЁё]/, 'the tagline is Russian');
  assert.ok(header.indexOf('site-title') < header.indexOf('site-tagline') && header.indexOf('site-tagline') < header.indexOf('<nav'));
  assert.match(header, /<nav aria-label="Основная навигация">/);
  assert.equal(header.match(/<nav\b/g)?.length, 1);

  const links = [...header.matchAll(/<nav[\s\S]*?<\/nav>/g)].flatMap(([nav]) =>
    [...nav.matchAll(/<a\b([^>]*)href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[3], m[2]]),
  );
  assert.deepEqual(links, [['Поиск', '/search/']], 'only the search is in the navigation; no project links, no second link home');
  assert.equal(site.projects, null, 'the site has no projects');
  assert.doesNotMatch(header, /Проекты|made\//);
  for (const [, href] of links) {
    assert.ok(existsSync(join(dist, 'my.ba3a.dev', ...href.split('/').filter(Boolean), 'index.html')), `${href} exists`);
  }

  assert.match(header, /<button type="button" class="theme-switch" data-theme-toggle /, 'the engine\'s theme switch is kept');
  assert.match(header, /data-label-dark="Тема: Тёмная"/);
  assert.match(header, /data-label-light="Тема: Светлая"/);
  assert.doesNotMatch(header, /style=|<script/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /<footer class="site-footer">/);
});

test('my.ba3a.dev: the current page is marked in the navigation', () => {
  const search = headerOf(output('my.ba3a.dev', 'search/index.html'));
  assert.match(search, /<a href="\/search\/" aria-current="page">Поиск<\/a>/);
  assert.doesNotMatch(headerOf(output('my.ba3a.dev', 'index.html')), /aria-current/);
});

// --- Russian strings and the 404 page ----------------------------------------

test('the theme strings only change keys that the engine has, apart from the tagline', () => {
  const flat = (/** @type {Record<string, unknown>} */ tree, prefix = '') =>
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'object' && value !== null ? flat(/** @type {Record<string, unknown>} */ (value), `${prefix}${key}.`) : [`${prefix}${key}`],
    );
  const engineKeys = new Set(flat(engineRu));
  const own = flat(themeStrings);
  assert.deepEqual(
    own.filter((key) => !engineKeys.has(key)),
    ['site.tagline'],
  );
  for (const key of ['not_found.title', 'not_found.text', 'not_found.home']) assert.ok(own.includes(key), `${key} is set`);
  assert.deepEqual(
    own.filter((key) => key !== 'site.tagline' && !key.startsWith('not_found.')),
    [],
    'nothing else of the engine\'s Russian UI strings is changed',
  );
  assert.ok(!existsSync(join(themeDir, 'i18n', 'en.yaml')), 'the site is Russian only');
});

test('my.ba3a.dev: the 404 page is Russian, in the theme\'s words, and has none of the engine\'s English copy', () => {
  const html = output('my.ba3a.dev', '404.html');
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  const main = mainOf(html);
  assert.match(main, /<article class="not-found">/);
  assert.match(main, new RegExp(`<h1>${themeStrings.not_found.title}</h1>`));
  assert.ok(main.includes(`<p>${themeStrings.not_found.text}</p>`));
  assert.ok(main.includes(`<a href="/">${themeStrings.not_found.home}</a>`));
  assert.match(html, new RegExp(`<title>${themeStrings.not_found.title} \\| ba3a</title>`));

  // The copy comes from the theme, not from the engine's Russian default.
  for (const key of /** @type {const} */ (['title', 'text', 'home'])) {
    assert.notEqual(themeStrings.not_found[key], engineRu.not_found[key], `not_found.${key} is the theme's own wording`);
    assert.ok(!main.includes(engineRu.not_found[key]), `the engine's Russian ${key} is not on the page`);
    assert.ok(!html.includes(engineEn.not_found[key]), `the engine's English ${key} is not on the page`);
  }
  // All the words on the page, in the header, the 404 text and the footer, are Russian.
  const visible = textOf(html.replace(/<head>[\s\S]*?<\/head>/, ''));
  assert.deepEqual(visible.replace(/ba3a|coffer/g, '').match(/[A-Za-z]{2,}/g), null, 'no English word is shown');
  assert.match(visible, /Страница потерялась/);

  // It is styled by the theme: the stylesheet is loaded and has rules for what the page contains.
  assert.match(html, /<link rel="stylesheet" href="\/assets\/my\.css">/);
  for (const selector of ['.not-found', '.not-found h1', '.not-found p', '.not-found a']) {
    assert.ok(readRules(stylesheet).some((rule) => rule.selector === selector), `the stylesheet styles ${selector}`);
  }
  const engineCss = read(join(engineTheme, 'assets', 'coffer.css'));
  assert.ok(!engineCss.includes('.not-found'), 'the engine does not style the 404 page, so the styling is the theme\'s');
});

test('my.ba3a.dev: no page shows an English UI string, so no string fell back to English', () => {
  for (const file of ['index.html', '404.html', 'search/index.html', 'tags/index.html']) {
    const html = output('my.ba3a.dev', file);
    const visible = textOf(html.replace(/<head>[\s\S]*?<\/head>/, '').replace(/<script[\s\S]*?<\/script>/g, ''));
    assert.deepEqual(visible.replace(/ba3a|coffer/g, '').match(/[A-Za-z]{2,}/g), null, `${file} shows no English word`);
  }
});

// --- title cards --------------------------------------------------------------

/** @param {string} title */
function renderCard(title) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'my-card-'));
  const maker = createCardMaker({ themeDir, cacheDir, siteTitle: site.title });
  return { cacheDir, maker, card: maker.make(title) };
}

test('the theme card renders Russian titles at the right size in the theme colours, without overflow', async () => {
  const colours = /** @type {{ accent: string, card: Record<string, string> }} */ (parseYaml(read(join(themeDir, 'theme.yaml'))));
  const titles = [
    'Как я делал верстак из лиственницы',
    'Очень длинное название заметки о том, как мы ходили в поход по Южному Уралу, ночевали у реки и возвращались домой три дня подряд, не считая остановок на ягоды',
    'Ёжик & «Ёлка» <b> "в тумане"',
    'Несоединимоедлинноесловонеимеющееникаких пробеловдостаточнодлинноечтобыневлезтиводнустрокукарточки',
  ];
  for (const title of titles) {
    const { cacheDir, maker, card } = renderCard(title);
    try {
      assert.equal(maker.fontFamily, 'Literata');
      for (const char of title) assert.ok(char === ' ' || maker.hasGlyph(char), `the card font has a glyph for ${char} (${title.slice(0, 20)})`);
      const { data, info } = await sharp(card.file).raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, CARD_WIDTH);
      assert.equal(info.height, CARD_HEIGHT);
      /** @type {(x: number, y: number) => string} */
      const pixel = (x, y) => {
        const at = (y * info.width + x) * info.channels;
        return `#${[0, 1, 2].map((i) => data[at + i].toString(16).padStart(2, '0')).join('')}`;
      };
      const background = colours.card.background.toLowerCase();
      assert.equal(pixel(CARD_WIDTH - 12, 300), background, 'the paper');
      assert.equal(pixel(14, 14), background, 'the paper in the corner');
      // The frame is drawn in the accent colour.
      const frame = [...Array(CARD_HEIGHT).keys()].filter((y) => pixel(28, y) === colours.accent.toLowerCase());
      assert.ok(frame.length > CARD_HEIGHT / 2, 'the frame is drawn in the accent colour');

      // The text stays inside the 80 px margin: the strips between the frame and the margin are empty on both sides.
      let drawn = 0;
      for (let y = 40; y < CARD_HEIGHT - 40; y += 1) {
        for (let x = 32; x < 80; x += 1) if (pixel(x, y) !== background) drawn += 1;
        for (let x = CARD_WIDTH - 79; x < CARD_WIDTH - 31; x += 1) if (pixel(x, y) !== background) drawn += 1;
      }
      assert.equal(drawn, 0, 'nothing is drawn between the frame and the text margin');

      // Text is drawn: the title area is not blank, and the glyphs are ink-coloured, not accent-coloured boxes.
      let ink = 0;
      for (let y = 60; y < 450; y += 1) {
        for (let x = 80; x < CARD_WIDTH - 80; x += 1) if (pixel(x, y) !== background) ink += 1;
      }
      assert.ok(ink > 2000, `the title is drawn (${ink} pixels)`);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }
});

test('the card template makes valid SVG and escapes & < > " in a title', () => {
  const colours = /** @type {{ accent: string, card: Record<string, string> }} */ (parseYaml(read(join(themeDir, 'theme.yaml'))));
  const environment = new nunjucks.Environment([], { autoescape: true });
  const svg = environment.renderString(read(join(themeDir, 'card.svg.njk')), {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    padding: 80,
    background: colours.card.background,
    foreground: colours.card.text,
    muted: colours.card.mutedText,
    accent: colours.accent,
    fontFamily: 'Literata',
    siteTitle: 'ba3a & <co> "my"',
    siteTitleSize: 36,
    siteTitleY: 566,
    titleSize: 60,
    titleLines: [
      { text: 'Ёжик & Ёлка', y: 200 },
      { text: '<script>"в тумане"</script>', y: 280 },
    ],
  });
  assert.match(svg, /Ёжик &amp; Ёлка/);
  assert.match(svg, /&lt;script&gt;&quot;в тумане&quot;&lt;\/script&gt;/);
  assert.match(svg, /ba3a &amp; &lt;co&gt; &quot;my&quot;/);
  assert.doesNotMatch(svg, /<script/i);
  assert.doesNotMatch(svg, /&(?!amp;|lt;|gt;|quot;|#\d+;)/, 'every ampersand starts an entity');
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630" viewBox="0 0 1200 630">/);
  // A well-formedness check: the renderer refuses SVG it cannot parse.
  const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
  assert.equal(resvg.width, CARD_WIDTH);
  assert.equal(resvg.height, CARD_HEIGHT);
});

test('the card template is the theme\'s own and not a copy of the engine\'s or of the other theme\'s', () => {
  const own = read(join(themeDir, 'card.svg.njk'));
  assert.notEqual(own, read(join(engineTheme, 'card.svg.njk')));
  assert.notEqual(own, read(join(otherThemeDir, 'card.svg.njk')));
  assert.match(own, /\{%\s*for line in titleLines/);
});

test('my.ba3a.dev: the theme\'s cards are the ones used for link previews', async () => {
  const html = output('my.ba3a.dev', 'index.html');
  const image = /<meta property="og:image" content="https:\/\/my\.ba3a\.dev(\/cards\/[0-9a-f]+\.png)">/.exec(html);
  assert.ok(image, 'the home page has a generated card');
  const file = join(dist, 'my.ba3a.dev', ...image[1].split('/').filter(Boolean));
  assert.ok(existsSync(file));
  const { info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, CARD_WIDTH);
  const paper = parseHex(/** @type {{ card: Record<string, string> }} */ (parseYaml(read(join(themeDir, 'theme.yaml')))).card.background);
  const { data } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], paper, 'the card is on the theme\'s paper');
});

test('the theme asset and font files have sane sizes', () => {
  for (const file of listFiles(themeDir)) {
    const size = statSync(join(themeDir, ...file.split('/'))).size;
    assert.ok(size < 200 * 1024, `${relative(root, join(themeDir, file))} is ${size} bytes`);
  }
});

// --- the brand pictures ------------------------------------------------------

test('my.ba3a.dev: pages declare the favicons, and the files are in the output', () => {
  for (const file of ['index.html', '404.html', 'search/index.html']) {
    const html = output('my.ba3a.dev', file);
    const ico = html.indexOf('<link rel="icon" href="/assets/brand/favicon.ico" sizes="any">');
    const svg = html.indexOf('<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">');
    assert.ok(ico > 0, `${file} links the .ico`);
    assert.ok(svg > ico, `${file} links the SVG icon after the .ico, so browsers that read SVG pick it`);
    assert.ok(html.includes('<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">'), `${file} links the apple touch icon`);
  }
  for (const name of listFiles(join(themeDir, 'assets', 'brand'))) {
    const built = join(dist, 'my.ba3a.dev', 'assets', 'brand', name);
    assert.ok(existsSync(built), `assets/brand/${name} is in the output`);
    assert.deepEqual(readFileSync(built), readFileSync(join(themeDir, 'assets', 'brand', name)));
  }
});

test('the mark above the title is the light logo on light pages and the bare dark logo on dark pages', () => {
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

test('the logo colours contrast with the page: sky blue on the dark page, navy tile on the light page', () => {
  const { light, darkMedia } = readSchemes(stylesheet);
  assert.ok(contrastRatio('#38bdf8', darkMedia['--coffer-bg']) >= AA_UI, 'the sky-blue letter on the dark page');
  assert.ok(contrastRatio('#0c4a6e', light['--coffer-bg']) >= AA_UI, 'the navy tile on the light page');
  assert.ok(contrastRatio('#38bdf8', '#0c4a6e') >= AA_UI, 'the sky-blue letter on the navy tile');
});
