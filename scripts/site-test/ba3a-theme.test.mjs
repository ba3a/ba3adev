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

test('the theme directory holds only styles, fonts, templates, UI strings, the card, the brand pictures of specloop and documentation', () => {
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
    /^assets\/specloop\/[a-z-]+\.(svg|ico|png)$/, // the brand pictures of the specloop page, copied from its brand kit
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
      blocks.filter((block) => !['head', 'nav'].includes(block)),
      [],
      `${name} overrides no block besides head and nav`,
    );
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
