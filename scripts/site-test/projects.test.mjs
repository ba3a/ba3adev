// Assertions about the seed projects of ba3a.dev (content/ba3a.dev/projects):
// their declarations, the projects page, the home page showcase, the tool pages
// and the page of Faultory. `npm run test:sites` builds the sites into
// `.cache/test-dist` and runs `coffer check` on them before these tests start;
// they read the sources, the theme stylesheet and that output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { loadConfig } from 'coffer';
import { matchGlob } from '../../node_modules/coffer/src/docs/glob.js';

import { contrastRatio, readRules, readSchemes } from './lib/wcag.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, '.cache', 'test-dist', 'ba3a.dev');
const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
const site = /** @type {import('coffer').SiteConfig} */ (config.sites.find((candidate) => candidate.id === 'ba3a.dev'));
const projectsDir = join(root, 'content', 'ba3a.dev', 'projects');
const stylesheet = readFileSync(join(root, 'themes', 'ba3a', 'assets', 'ba3a.css'), 'utf8');

/** The order of the showcase, as agreed: the lower `order` comes first. */
const SHOWCASE = ['specloop', 'roto', 'faultory', 'coffer'];

/**
 * What the spec (section 14) says about each project, which the seed texts copy.
 *
 * @type {Record<string, { name: string, kind: string, pitch: string, points: string[], tag: string, license?: string, repo?: string }>}
 */
const SPEC = {
  specloop: {
    name: 'specloop',
    kind: 'tool',
    pitch: 'A spec-driven plan → implement → review loop for Claude Code, built only from hooks and slash commands.',
    points: [
      'You hand it a spec, and Claude is walked through phases; a phase only completes when its check passes.',
      'Runs in your normal Claude Code session, no API keys, no separate orchestrator.',
      'Guard rails restrict edits per phase and block pushes until the work is done.',
      'Single mode gives one reviewable diff; feature mode splits a big spec into steps, each reviewed and committed.',
    ],
    tag: 'specloop',
    license: '0BSD',
    repo: 'https://github.com/ba3a/specloop',
  },
  roto: {
    name: 'roto',
    kind: 'tool',
    pitch: 'Turn a phone video into pixel-art sprites you finish by hand.',
    points: [
      'Reference footage in, a layered `.ase` draft out for polishing in LibreSprite or Aseprite, then publishes the finished frames into your game.',
      'Every step is a deterministic algorithm or the artist\'s own hand: no machine learning, no generative models; the same inputs always give byte-identical output.',
      'Desktop app and CLI.',
      'Early development.',
    ],
    tag: 'roto',
    license: 'Apache-2.0',
    repo: 'https://github.com/ba3a/roto',
  },
  faultory: {
    name: 'Faultory',
    kind: 'game',
    pitch: 'Your factory makes the enemies. Then you have to stop them.',
    points: [
      'A factory game where defects, sabotage and quality control are the core.',
      'The player produces their own waves and builds the defence against them.',
      'Rotoscoped pixel-art workers, drawn from real footage.',
    ],
    tag: 'faultory',
  },
  coffer: {
    name: 'coffer',
    kind: 'tool',
    pitch: 'A static site engine for people who make things and write about them.',
    points: [
      'Project pages with docs pulled from their own repositories.',
      'A devlog that brands posts by project.',
      'Hierarchical tags and series.',
      'Photo-heavy posts with carousels, maps and GPX tracks.',
      'Per-tag location privacy and full-text feeds.',
      'Everything in git, publishing is a push.',
    ],
    tag: 'coffer',
    license: 'Apache-2.0',
    repo: 'https://github.com/ba3a/coffer',
  },
};

const AA_TEXT = 4.5;
const AA_UI = 3;

/** @param {string} path @returns {string} The text of a file, with LF line ends. */
function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
}

/** @param {string} file Path inside the built site, with forward slashes. */
function output(file) {
  const path = join(dist, ...file.split('/'));
  assert.ok(existsSync(path), `ba3a.dev/${file} exists in .cache/test-dist (run "npm run test:sites")`);
  return readText(path);
}

/** @param {string} slug @returns {Record<string, any>} */
function declaration(slug) {
  return parseYaml(readText(join(projectsDir, slug, 'project.yaml')));
}

/** @param {string} html @returns {string} The content of <main>. */
function mainOf(html) {
  const match = /<main id="main">([\s\S]*?)<\/main>/.exec(html);
  assert.ok(match, 'the page has a main element');
  return match[1];
}

/**
 * @param {string} html
 * @returns {Array<{ slug: string, name: string, alt: string, pitch: string, kind: string }>} The project cards of a page, in order.
 */
function cardsOf(html) {
  return [...html.matchAll(/<article class="project-card">([\s\S]*?)<\/article>/g)].map(([, card]) => {
    const link = /<a href="\/made\/([^/"]+)\/">([^<]*)<\/a>/.exec(card);
    assert.ok(link, 'a card links to its project');
    return {
      slug: link[1],
      name: link[2],
      alt: /<img [^>]*alt="([^"]*)"/.exec(card)?.[1] ?? '',
      pitch: /<p class="project-pitch">([^<]*)<\/p>/.exec(card)?.[1] ?? '',
      kind: /<span class="project-kind">([^<]*)<\/span>/.exec(card)?.[1] ?? '',
    };
  });
}

/** @param {string} point A point as written in the Markdown source. @returns {string} The point as the build writes it in HTML. */
function pointHtml(point) {
  return escapeHtml(point).replace(/&quot;/g, '"').replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** @param {string} text @returns {string} The text as it is in HTML. */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- the configuration --------------------------------------------------------

test('ba3a.dev has projects, in the folder the declarations live in, at /made/', () => {
  assert.ok(site.projects, 'the site configures projects');
  assert.equal(site.projects.dir, projectsDir);
  assert.equal(site.urls.projects, 'made');
  assert.ok(projectsDir.startsWith(site.contentDir), 'the projects are inside the content directory');
});

// --- the declarations ---------------------------------------------------------

test('there are exactly four project folders, each with a declaration and a text', () => {
  const folders = readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(folders, [...SHOWCASE].sort());
  for (const slug of SHOWCASE) {
    assert.ok(existsSync(join(projectsDir, slug, 'project.yaml')), `${slug}/project.yaml`);
    assert.ok(existsSync(join(projectsDir, slug, 'index.md')), `${slug}/index.md`);
  }
});

test('the declarations carry the facts of the spec: name, pitch, kind, tag, repository and license', () => {
  for (const [slug, expected] of Object.entries(SPEC)) {
    const fields = declaration(slug);
    assert.equal(fields.name, expected.name, `${slug}: name`);
    assert.equal(fields.pitch, expected.pitch, `${slug}: pitch`);
    assert.equal(fields.kind, expected.kind, `${slug}: kind`);
    assert.equal(fields.tag, expected.tag, `${slug}: tag`);
    assert.equal(fields.license, expected.license, `${slug}: license`);
    assert.equal(fields.repo, expected.repo, `${slug}: repo`);
    assert.equal(fields.status, 'in-development', `${slug}: status`);
    assert.equal(fields.featured, true, `${slug}: featured`);
    assert.ok(typeof fields.cardAlt === 'string' && fields.cardAlt.length > 10, `${slug}: the card has alt text`);
    assert.match(fields.card, /\.png$/, `${slug}: the card is a picture the engine accepts`);
    assert.ok(existsSync(join(projectsDir, slug, fields.card)), `${slug}: the card file exists`);
  }
});

test('the featured order is specloop, roto, faultory, coffer, and every number is different', () => {
  const orders = SHOWCASE.map((slug) => declaration(slug).order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'the numbers rise in the showcase order');
  assert.equal(new Set(orders).size, orders.length);
});

test('every seed text is marked "TODO: rewrite" in its source', () => {
  for (const slug of SHOWCASE) {
    const page = readText(join(projectsDir, slug, 'index.md'));
    assert.ok(page.startsWith('<!-- TODO: rewrite -->'), `${slug}/index.md starts with the marker`);
    // The declaration of coffer is final: its pitch and status are settled.
    if (slug !== 'coffer') {
      assert.match(readText(join(projectsDir, slug, 'project.yaml')), /^# TODO: rewrite\b/m, `${slug}/project.yaml has the marker`);
    }
  }
  assert.ok(declaration('faultory').pressKit.longDescription.includes('<!-- TODO: rewrite -->'), 'the press kit description');
});

test('the seed points are the spec\'s text, in the Markdown source (the features of a game, in its declaration)', () => {
  for (const [slug, expected] of Object.entries(SPEC)) {
    const source =
      slug === 'faultory'
        ? /** @type {string[]} */ (declaration(slug).features).join('\n')
        : readText(join(projectsDir, slug, 'index.md'));
    for (const point of expected.points) assert.ok(source.includes(point), `${slug}: "${point}" is in the source`);
  }
});

// --- the projects page and the showcase --------------------------------------

test('/made/ lists exactly four projects in the declared order, with their pitch and alt text', () => {
  const cards = cardsOf(output('made/index.html'));
  assert.deepEqual(
    cards.map((card) => card.slug),
    SHOWCASE,
  );
  for (const card of cards) {
    const expected = SPEC[card.slug];
    assert.equal(card.name, escapeHtml(expected.name));
    assert.equal(card.pitch, escapeHtml(expected.pitch));
    assert.equal(card.kind, expected.kind === 'game' ? 'Game' : 'Tool');
    assert.equal(card.alt, declaration(card.slug).cardAlt);
  }
});

test('the home page showcase shows the same four projects in the same order', () => {
  const home = output('index.html');
  const showcase = /<section class="showcase">([\s\S]*?)<\/section>/.exec(home);
  assert.ok(showcase, 'the home page has the showcase');
  assert.deepEqual(
    cardsOf(showcase[1]).map((card) => card.slug),
    SHOWCASE,
  );
  assert.match(showcase[1], /<a href="\/made\/">All projects<\/a>/);
});

test('every card picture and project page exists in the output, and the nav links to the projects page', () => {
  for (const slug of SHOWCASE) {
    assert.ok(existsSync(join(dist, 'made', slug, 'index.html')), `/made/${slug}/ is built`);
    assert.ok(existsSync(join(dist, 'made', slug, 'feed.xml')), `the feed of ${slug} is built`);
  }
  for (const page of ['made/index.html', 'index.html']) {
    for (const [, src] of output(page).matchAll(/<img src="(\/img\/[^"]+)"/g)) {
      assert.ok(existsSync(join(dist, ...src.split('/').filter(Boolean))), `${src} exists`);
    }
  }
  assert.match(output('index.html'), /<nav aria-label="Main navigation">[\s\S]*<a href="\/made\/">Projects<\/a>/);
});

test('the sitemap lists the projects page and every project page; each project has an Atom feed', () => {
  const sitemap = output('sitemap.xml');
  assert.match(sitemap, /<loc>https:\/\/ba3a\.dev\/made\/<\/loc>/);
  for (const slug of SHOWCASE) {
    assert.match(sitemap, new RegExp(`<loc>https://ba3a\\.dev/made/${slug}/</loc>`));
    const feed = output(`made/${slug}/feed.xml`);
    assert.match(feed, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
    assert.ok(feed.includes(`https://ba3a.dev/made/${slug}/feed.xml`));
    assert.match(feed, new RegExp(`<title>${SPEC[slug].name}\\b`), `the feed of ${slug} is titled with the project name`);
    assert.match(output(`made/${slug}/index.html`), new RegExp(`<link rel="alternate" type="application/atom\\+xml" title="Feed of ${SPEC[slug].name}" href="/made/${slug}/feed\\.xml">`));
  }
});

test('the card of each project is its link preview image', () => {
  for (const slug of SHOWCASE) {
    const page = output(`made/${slug}/index.html`);
    assert.match(page, /<meta property="og:image" content="https:\/\/ba3a\.dev\/img\/[0-9a-f]+\/card-1200\.webp">/);
    assert.match(page, /<link rel="canonical" href="https:\/\/ba3a\.dev\/made\/[a-z]+\/">/);
  }
});

test('no seed marker reaches the published HTML, apart from the Faultory press kit placeholders', () => {
  const pages = ['index.html', 'made/index.html', ...SHOWCASE.map((slug) => `made/${slug}/index.html`)];
  for (const page of pages) {
    const html = output(page);
    assert.doesNotMatch(html, /<!--/, `${page} has no HTML comment`);
    assert.doesNotMatch(html, /TODO: rewrite/, `${page} has no rewrite marker`);
    // The only visible placeholder is the developer of the press kit.
    const placeholders = [...html.matchAll(/TODO[^<]*/g)].map((match) => match[0]);
    assert.deepEqual(placeholders, page === 'made/faultory/index.html' ? ['TODO: developer name'] : [], page);
  }
});

// --- the pages of the tools ---------------------------------------------------

for (const slug of SHOWCASE.filter((name) => SPEC[name].kind === 'tool')) {
  test(`${slug}: the tool page shows the repository, the license and the text, and no game parts`, () => {
    const expected = SPEC[slug];
    const html = output(`made/${slug}/index.html`);
    const page = mainOf(html);
    assert.match(page, new RegExp(`<h1>${expected.name}</h1>`));
    assert.ok(page.includes(`<p class="project-pitch">${escapeHtml(expected.pitch)}</p>`));
    assert.match(page, /<span class="project-kind">Tool<\/span>/);
    assert.ok(
      page.includes(`<dd><a href="${expected.repo}" rel="noopener">${expected.repo.replace('https://', '')}</a></dd>`),
      'the repository link',
    );
    assert.match(page, new RegExp(`<div class="project-fact project-fact-license">\\s*<dt>License</dt>\\s*<dd>${expected.license}</dd>`));
    for (const point of expected.points) assert.ok(page.includes(`<li>${pointHtml(point)}</li>`), `"${point}" is on the page`);
    assert.doesNotMatch(page, /game-page|game-button|Press kit|Follow the devlog/);

    // The documentation link is there exactly when the project declares documentation.
    const hasDocs = declaration(slug).docs !== undefined;
    assert.equal(page.includes(`href="/made/${slug}/docs/"`), hasDocs, 'the docs link follows the docs configuration');
    assert.equal(page.includes('project-fact-docs'), hasDocs);
  });
}

// --- the page of Faultory -----------------------------------------------------

test('Faultory: a game page with a call to follow the devlog, no store buttons and no repository link', () => {
  const html = output('made/faultory/index.html');
  const page = mainOf(html);
  assert.match(page, /<div class="game-page" style="/);
  assert.match(page, /<span class="project-kind">Game<\/span>/);

  assert.match(
    page,
    /<p><a class="game-button game-follow-link" href="\/made\/faultory\/feed\.xml">Follow the devlog<\/a><\/p>/,
    'the follow call to action links to the project feed',
  );
  assert.equal(page.match(/class="game-button/g)?.length, 1, 'one button, and it is the call to follow');
  assert.doesNotMatch(page, /Get it on itch\.io|Wishlist on Steam|itch\.io|store\.steampowered|steamcommunity/i, 'no store button');
  assert.doesNotMatch(page, /game-store|game-buy/);

  assert.doesNotMatch(page, /project-fact-repo|Source code/, 'no repository fact');
  assert.doesNotMatch(page, /github\.com/i, 'no link to any repository on the page');
  assert.doesNotMatch(page, /href="https?:\/\//, 'the page has no external link at all');

  const fields = declaration('faultory');
  assert.equal(fields.repo, undefined);
  assert.ok(Object.values(fields.stores ?? {}).every((value) => !value), 'no store link is set');
  assert.deepEqual(fields.platforms, ['Desktop']);
  assert.match(page, /<div class="project-fact project-fact-platforms">\s*<dt>Platforms<\/dt>\s*<dd>Desktop<\/dd>/);
  assert.match(page, /<dd>In development<\/dd>/);

  for (const point of SPEC.faultory.points) assert.ok(page.includes(`<li>${pointHtml(point)}</li>`), `the feature "${point}"`);
  assert.match(page, /<img src="\/img\/[0-9a-f]+\/key-art-1200\.webp" alt="Placeholder key art:/);
  assert.match(page, /<picture>[\s\S]*?<img src="\/img\/[0-9a-f]+\/logo-1200\.webp" alt=""/, 'the logo above the heading');
});

test('Faultory: the press kit has a factsheet with marked placeholders and downloadable logos', () => {
  const page = mainOf(output('made/faultory/index.html'));
  const kit = /<section class="press-kit" id="press-kit"[\s\S]*?<\/section>/.exec(page)?.[0];
  assert.ok(kit, 'the page has a press kit');
  assert.match(kit, /<dt>Developer<\/dt>\s*<dd>TODO: developer name<\/dd>/, 'the developer is a visible placeholder');
  assert.match(kit, /<dt>Release status<\/dt>\s*<dd>In development<\/dd>/);
  assert.match(kit, /<dt>Platforms<\/dt>\s*<dd>Desktop<\/dd>/);
  assert.doesNotMatch(kit, /<dt>Price<\/dt>/, 'a price that is not known is left out');
  assert.doesNotMatch(kit, /@|mailto:/, 'no contact address is invented');
  assert.ok(kit.includes(`<p>${declaration('faultory').pressKit.shortDescription}</p>`));
  assert.ok(
    kit.includes('A factory game where defects, sabotage and quality control are the core; the player produces their own waves and builds the defence against them. Rotoscoped pixel-art workers, drawn from real footage.'),
    'the long description is the spec text',
  );

  for (const [file, type] of /** @type {const} */ ([
    ['faultory-logo-01.png', 'PNG'],
    ['faultory-logo-02.svg', 'SVG'],
  ])) {
    assert.ok(kit.includes(`href="/made/faultory/press-kit/${file}" download="${file}"`), `${file} is offered for download`);
    assert.ok(kit.includes(`(${type}, 1920 × 640 px`), `${file} is listed at its original size`);
    assert.ok(existsSync(join(dist, 'made', 'faultory', 'press-kit', file)), `${file} is published`);
  }
  // An SVG logo is published exactly as written.
  assert.equal(
    readFileSync(join(dist, 'made', 'faultory', 'press-kit', 'faultory-logo-02.svg'), 'utf8'),
    readFileSync(join(projectsDir, 'faultory', 'logo.svg'), 'utf8'),
  );
  assert.equal(readFileSync(join(dist, 'made', 'faultory', 'press-kit', 'faultory-logo-01.png')).subarray(1, 4).toString(), 'PNG');
  assert.match(output('made/faultory/index.html'), /href="\/made\/faultory\/#press-kit"|id="press-kit"/);
});

// --- Handjet ------------------------------------------------------------------

test('Faultory: the headings and buttons are set in Handjet, self-hosted, declared with swap and a fallback', () => {
  const html = output('made/faultory/index.html');
  const fields = declaration('faultory');
  assert.equal(fields.displayFont, 'Handjet');
  assert.equal(fields.displayFontFile, 'handjet-latin-700.woff2');

  const face = /<style>\s*@font-face \{([^}]*)\}\s*<\/style>/.exec(html)?.[1];
  assert.ok(face, 'the page declares its font');
  assert.match(face, /font-family: "Handjet"/);
  assert.match(face, /src: url\("\/made\/faultory\/display-font-file\.woff2"\) format\("woff2"\)/);
  assert.match(face, /font-display: swap/);

  const style = /<div class="game-page" style="([^"]*)"/.exec(html)?.[1] ?? '';
  const stack = /--project-font:([^;]*)$/.exec(style.replace(/&quot;/g, '"'))?.[1];
  assert.equal(stack, '"Handjet", var(--coffer-font-heading)', 'Handjet first, the theme\'s heading font as the fallback');
  assert.match(readSchemes(stylesheet).light['--coffer-font-heading'], /sans-serif$/, 'the fallback ends in a generic family');

  // The page loads no font from another host and the font is not preloaded on other pages.
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/);
  assert.doesNotMatch(output('made/specloop/index.html'), /Handjet/);
  assert.doesNotMatch(output('index.html'), /Handjet/);
});

test('Faultory: the published font is the unmodified upstream woff2 with its license and a small size', () => {
  const source = join(projectsDir, 'faultory', 'handjet-latin-700.woff2');
  const bytes = readFileSync(source);
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', 'a woff2 file');
  assert.ok(bytes.length < 20 * 1024, `the font weighs ${bytes.length} bytes`);
  const built = readFileSync(join(dist, 'made', 'faultory', 'display-font-file.woff2'));
  assert.ok(built.equals(bytes), 'the output has the file as it is');

  // The license text is published with the theme (the engine publishes only the font file from a
  // project folder), exactly once: the project folder holds no second copy that could drift.
  assert.ok(!existsSync(join(projectsDir, 'faultory', 'OFL-Handjet.txt')), 'no second copy of the license in the project folder');
  const licensePath = join(root, 'themes', 'ba3a', 'assets', 'fonts', 'OFL-Handjet.txt');
  const license = readText(licensePath);
  assert.match(license, /^Copyright 2018 The Handjet Project Authors \(https:\/\/github\.com\/rosettatype\/Handjet\/\)/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  // The header of the license names no Reserved Font Name after the copyright line.
  assert.doesNotMatch(license.split('This Font Software')[0], /Reserved Font Name/i, 'no reserved font name is declared');

  // The font and its license are the unmodified files of the pinned npm package.
  const upstream = join(root, 'node_modules', '@fontsource', 'handjet');
  assert.ok(bytes.equals(readFileSync(join(upstream, 'files', 'handjet-latin-700-normal.woff2'))), 'the font is the upstream file');
  assert.ok(readFileSync(licensePath).equals(readFileSync(join(upstream, 'LICENSE'))), 'the license is the upstream LICENSE file');

  // The license text is shipped with the font software: it is in the output, byte for byte.
  const builtLicense = join(dist, 'assets', 'fonts', 'OFL-Handjet.txt');
  assert.ok(existsSync(builtLicense), 'the license is published at /assets/fonts/OFL-Handjet.txt');
  assert.ok(readFileSync(builtLicense).equals(readFileSync(join(upstream, 'LICENSE'))), 'the published license equals the upstream text');

  // The page credits the font where it is used and links to the published license, which resolves.
  const credit = /<p>The display font of this page is Handjet by The Handjet Project Authors, used under the <a href="([^"]+)">SIL Open Font License 1\.1<\/a>\.<\/p>/.exec(
    mainOf(output('made/faultory/index.html')),
  );
  assert.ok(credit, 'the credit names the font, its authors and links the license');
  assert.equal(credit[1], '/assets/fonts/OFL-Handjet.txt');
  assert.ok(existsSync(join(dist, ...credit[1].split('/').filter(Boolean))), 'the link target is in the output');

  // Where the file comes from is recorded next to the theme's other fonts.
  const readme = readText(join(root, 'themes', 'ba3a', 'README.md'));
  assert.ok(readme.includes(createHash('sha256').update(bytes).digest('hex')), 'the README records the sha256 of the font');
  assert.ok(readme.includes(createHash('sha256').update(readFileSync(licensePath)).digest('hex')), 'and of the license');
  assert.match(readme, /assets\/fonts\/OFL-Handjet\.txt/, 'the README names where the single license copy is');
  assert.match(readme, /@fontsource\/handjet/);
  assert.match(readme, /5\.3\.1/);
  assert.match(readme, /https:\/\/github\.com\/rosettatype\/Handjet/);
  assert.match(readme, /handjet-latin-700-normal\.woff2/);
});

test('the theme turns off synthetic bold on the game page, which has one font face', () => {
  const rule = readRules(stylesheet).find((candidate) => candidate.selector.includes('.game-page h1'));
  assert.ok(rule, 'the stylesheet has a rule for the game page headings');
  assert.equal(rule.declarations['font-synthesis-weight'], 'none');
  assert.ok(rule.selector.includes('.game-page .game-button'));
});

// --- the accent colour --------------------------------------------------------

for (const [scheme, key] of /** @type {const} */ ([
  ['light', 'light'],
  ['dark', 'darkMedia'],
])) {
  test(`Faultory: the accent colour is readable and visible on the page in the ${scheme} scheme`, () => {
    const accent = declaration('faultory').accent;
    assert.match(accent, /^#[0-9a-fA-F]{6}$/);
    const html = output('made/faultory/index.html');
    const style = /<div class="game-page" style="([^"]*)"/.exec(html)?.[1] ?? '';
    assert.ok(style.includes(`--project-accent:${accent.toLowerCase()}`), 'the page sets the accent');
    const onAccent = /--project-on-accent:(#[0-9a-f]{3,6})/.exec(style)?.[1];
    assert.ok(onAccent, 'the engine picks a text colour for the buttons');

    const background = readSchemes(stylesheet)[key]['--coffer-bg'];
    const label = contrastRatio(onAccent, accent);
    assert.ok(label >= AA_TEXT, `the label of a button is ${label.toFixed(2)}:1 on the accent, needs ${AA_TEXT}:1`);
    // The line under the heading, the bullets and the borders are non-text elements.
    const line = contrastRatio(accent, background);
    assert.ok(line >= AA_UI, `the accent is ${line.toFixed(2)}:1 on the page background ${background}, needs ${AA_UI}:1`);
  });
}

// --- the originals ------------------------------------------------------------

// The placeholder pictures under content/ba3a.dev/projects/ (the PNG card, logo and key art that the
// build needs, because the engine rejects SVG there, and their SVG sources), and the Handjet woff2,
// are design placeholders and fonts, not photos. They must stay regular git files: if the media
// patterns (`media.include` of coffer.yaml, which has no `exclude`) captured them, the build would depend on the
// media store for files that are generated by scripts/make-placeholders.mjs. A pattern such as
// `content/**/*.png` would capture them all, so the patterns are narrower: the devlog and the post
// folders of my.ba3a.dev only. PNG and SVG placeholders under `content/ba3a.dev/projects/` stay regular git files.

/** The file types that a media pattern must leave alone in a project folder (extension, lower case). */
const REGULAR_GIT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.svg', '.woff2'];

/** @returns {string[]} Every file of the project folders that must stay in git, as a path relative to the repository root. */
function placeholderArtwork() {
  const found = [];
  for (const slug of SHOWCASE) {
    for (const name of readdirSync(join(projectsDir, slug)).sort()) {
      if (REGULAR_GIT_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))) {
        found.push(`content/ba3a.dev/projects/${slug}/${name}`);
      }
    }
  }
  return found;
}

/** @param {string[]} include @param {string} path @returns {boolean} Whether the matcher of the engine would take the file as an original. */
function isOriginal(include, path) {
  return include.some((glob) => matchGlob(glob, path));
}

test('the placeholder art is found: every card, the Faultory pictures and the Handjet font, as PNG, SVG and woff2', () => {
  const artwork = placeholderArtwork();
  for (const slug of SHOWCASE) {
    for (const extension of ['png', 'svg']) {
      assert.ok(artwork.includes(`content/ba3a.dev/projects/${slug}/card.${extension}`), `${slug}/card.${extension}`);
    }
  }
  for (const file of ['logo.png', 'logo.svg', 'key-art.png', 'key-art.svg', 'handjet-latin-700.woff2']) {
    assert.ok(artwork.includes(`content/ba3a.dev/projects/faultory/${file}`), `faultory/${file}`);
  }
});

test('the guard uses the engine glob matcher: a wide raster pattern would capture the pictures, a narrow one would not', () => {
  const artwork = placeholderArtwork();
  const png = artwork.filter((path) => path.endsWith('.png'));
  assert.ok(png.length >= 6);
  // What step 52 must not write: any of these takes the project pictures out of git.
  for (const wide of ['content/**/*.png', '**/*.png', 'content/ba3a.dev/**/*.png', 'content/ba3a.dev/projects/**/*.png']) {
    assert.ok(png.every((path) => isOriginal([wide], path)), `${wide} would capture the project pictures`);
  }
  // What it may write instead.
  for (const narrow of ['content/ba3a.dev/devlog/**/*.png', 'content/ba3a.dev/devlog/**/*.jpg', 'content/my.ba3a.dev/**/*.jpg', 'content/my.ba3a.dev/**/*.heic']) {
    assert.ok(!artwork.some((path) => isOriginal([narrow], path)), `${narrow} leaves the project pictures alone`);
  }
});

test('the placeholder art stays in regular git: no media pattern matches a raster picture, SVG or font of a project folder', () => {
  const include = /** @type {string[] | undefined} */ (config.media?.include);
  assert.ok(include && include.length > 0, 'coffer.yaml configures the media store and its include patterns');
  for (const path of placeholderArtwork()) {
    assert.ok(!isOriginal(include, path), `${path} must stay a regular git file, but media.include matches it`);
  }
});
