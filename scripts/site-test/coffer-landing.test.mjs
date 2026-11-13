// Assertions about the landing page of coffer (/made/coffer/) and what it adds to
// the layout of specloop's: the per-project settings in
// themes/ba3a/templates/partials/landing.njk, the gold palette in
// themes/ba3a/assets/landing.css and the brand pictures. `npm run test:sites`
// builds the sites into `.cache/test-dist` first; these tests read the theme
// sources and that output. The layout in general is tested by
// specloop-landing.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { contrastRatio, readRules } from './lib/wcag.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, '.cache', 'test-dist', 'ba3a.dev');
const themeDir = join(root, 'themes', 'ba3a');

/** @param {string} file Path inside the output of ba3a.dev. @returns {string} */
function output(file) {
  const path = join(dist, ...file.split('/'));
  assert.ok(existsSync(path), `${file} exists in .cache/test-dist (run "npm run test:sites")`);
  return readFileSync(path, 'utf8');
}

const SECTIONS = ['hero', 'problem', 'audience', 'how-it-works', 'timeline', 'spec-example', 'features', 'compare', 'dogfood', 'quick-start', 'faq', 'final-cta'];

const page = output('made/coffer/index.html');
const css = readFileSync(join(themeDir, 'assets', 'landing.css'), 'utf8');
// The text of the page is the file of the coffer repository, in the checkout the docs are built from.
const sourcePath = join(root, '.cache', 'repos', 'coffer', 'site', 'landing.md');
assert.ok(existsSync(sourcePath), '.cache/repos/coffer/site/landing.md exists (run "npm run test:sites")');
const source = readFileSync(sourcePath, 'utf8');

/** @param {string} name @returns {string} The HTML of one section of the page. */
function part(name) {
  return /** @type {RegExpExecArray} */ (new RegExp(`<section id="${name}"[\\s\\S]*?</section>`).exec(page))[0];
}

// --- the page ------------------------------------------------------------------

test('the page has the twelve sections, in order, each with its name as id, and no marker is left', () => {
  assert.deepEqual([...page.matchAll(/<section id="([a-z-]+)" class="lp-section/g)].map((match) => match[1]), SECTIONS);
  assert.doesNotMatch(page, /section-marker/);
  assert.deepEqual([...source.matchAll(/<div class="section-marker" id="([a-z-]+)"><\/div>/g)].map((match) => match[1]), SECTIONS);
});

test('the wrapper carries the slug, and the top bar has the name of the project, the logos and the links to its sections', () => {
  assert.match(page, /<div class="landing landing-coffer">/);
  assert.match(page, /<a class="lp-brand" href="#hero">[\s\S]*?<span>coffer<\/span>/, 'the name, without an accented end');
  assert.doesNotMatch(/<a class="lp-brand"[\s\S]*?<\/a>/.exec(page)?.[0] ?? '', /lp-accent/);
  assert.match(page, /<img class="lp-logo lp-logo-light" src="\/assets\/coffer\/logo\.svg"/);
  assert.match(page, /<img class="lp-logo lp-logo-dark" src="\/assets\/coffer\/logo-dark\.svg"/);
  for (const name of ['how-it-works', 'compare', 'dogfood', 'quick-start']) assert.match(page, new RegExp(`class="lp-link" href="#${name}"`));
  assert.match(page, /class="lp-link" href="#compare">Why not Hugo</);
  const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const [, target] of page.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `#${target} exists`);
  const all = [...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(all).size, all.length, 'every id is unique');
});

test('the words of the layout are those of coffer, not of specloop', () => {
  assert.match(part('hero'), /aria-label="A terminal session that builds and checks the example site of coffer\."/);
  assert.match(part('hero'), /<b>coffer — example site<\/b>/);
  assert.match(part('problem'), /aria-label="A shell script of the tools a photo journal usually needs/);
  assert.match(part('dogfood'), /aria-label="The build-info\.json that ba3a\.dev serves/);
  assert.doesNotMatch(page, /claude — my-project|lp-chat|Claude Code/);
});

test('the eyebrows are paragraphs, the headline is the only h1 in three lines, and the questions are closed <details>', () => {
  assert.doesNotMatch(page, /<h6/);
  assert.equal(page.match(/<p class="lp-eyebrow">/g)?.length, 11, 'eleven eyebrows: every section but the last');
  assert.equal(page.match(/<h1[ >]/g)?.length, 1);
  assert.match(page, /<h1 [^>]*><span class="lp-line">Write the post\.<\/span> <span class="lp-line lp-accent">Drop in the photos\.<\/span> <span class="lp-line">Push\.<\/span><\/h1>/);
  const faq = part('faq');
  assert.equal(faq.match(/<details>/g)?.length, 6);
  assert.doesNotMatch(faq, /<details open/);
});

test('each part of the Markdown is rendered as the style guide says', () => {
  assert.equal(part('how-it-works').match(/<li class="lp-card">/g)?.length, 3, 'the table is three cards');
  assert.match(part('how-it-works'), /<p class="lp-gate"><b>Gate:<\/b> /);
  assert.equal(part('audience').match(/<li class="lp-card">/g)?.length, 4, 'four kinds of reader');
  assert.match(part('audience'), /<span class="lp-ico" aria-hidden="true">🔨<\/span><h3>Makers with a journal<\/h3>/);
  assert.match(part('audience'), /<\/ul>\s*<p><strong>Not for you<\/strong>/, 'the page says who it is not for');
  assert.equal(part('features').match(/<li class="lp-card">/g)?.length, 8);
  assert.equal(part('timeline').match(/<li class="lp-you">/g)?.length, 3, 'three steps are the person\'s');
  assert.equal(part('timeline').match(/<li>/g)?.length, 3);
  assert.match(part('timeline'), /<span class="lp-when">Write<\/span>/);
  assert.doesNotMatch(part('timeline'), /<time/, 'the labels are words, not times');
  assert.equal(part('dogfood').match(/<li class="lp-stat">/g)?.length, 4);
  assert.match(part('dogfood'), /<li class="lp-stat"><b>15 min<\/b><span>/);
  assert.match(part('dogfood'), /<blockquote>/, 'the callout stays a quote');
  assert.match(part('dogfood'), /<div class="lp-term lp-term-plain" role="group" aria-label="[^"]+">/);
  assert.match(part('dogfood'), /"engineVersion": "0\.1\.0"/);
  assert.match(part('hero'), /<span class="lp-cursor" aria-hidden="true"><\/span>/);
  assert.match(part('hero'), /<span class="line"><span class="lp-t-p">\$<\/span> npx coffer build/);
  assert.match(part('hero'), /<span class="lp-t-ok">no failures<\/span>/);
  assert.match(part('hero'), /<span class="line lp-t-w">Posts publishing exact locations \(2\)<\/span>/);
  assert.match(part('problem'), /<div class="lp-term lp-term-plain"/, 'the problem is a script, not a chat');
  assert.match(part('problem'), /<span class="lp-t-m"># strip the GPS data/);
  assert.match(part('spec-example'), /<span class="line">title: A day in the valley<\/span>/, 'the front matter of a post is the visual');
  assert.match(part('quick-start'), /npm run example/);
});

test('the comparison is a table with the engine\'s column, the other column, and what you give up', () => {
  const section = part('compare');
  assert.equal(section.match(/<tr>/g)?.length, 7, 'a head row and six rows');
  assert.match(section, /<th>coffer<\/th>\s*<th>With Hugo, typically<\/th>/);
  assert.match(section, /<h3[^>]*>What you give up<\/h3>/);
  assert.match(section, /version 0\.1\.0 with one maintainer/);
});

test('the page keeps what every project page has: the facts, the feed link and the way back', () => {
  assert.match(page, /<dd><a href="https:\/\/github\.com\/ba3a\/coffer" rel="noopener">github\.com\/ba3a\/coffer<\/a><\/dd>/);
  assert.match(page, /<dd>Apache-2\.0<\/dd>/);
  assert.match(page, /href="\/made\/coffer\/docs\/"/);
  assert.match(page, /<a rel="alternate" type="application\/atom\+xml" href="\/made\/coffer\/feed\.xml">/);
  assert.match(page, /<p class="all-projects"><a href="\/made\/">/);
});

test('the head has the title, the description, the preview image, the stylesheet and the favicons of the brand', () => {
  assert.match(page, /<title>coffer \| ba3a\.dev<\/title>/);
  assert.match(page, /<meta name="description" content="A static site engine for people who make things and write about them\.">/);
  assert.match(page, /<meta property="og:image" content="https:\/\/ba3a\.dev\/img\/[0-9a-f]+\/card-1200\.webp">/);
  assert.match(page, /<link rel="stylesheet" href="\/assets\/landing\.css">/);
  assert.match(page, /<link rel="icon" href="\/assets\/coffer\/favicon\.ico" sizes="any">/);
  assert.match(page, /<link rel="icon" href="\/assets\/coffer\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(page, /<link rel="apple-touch-icon" href="\/assets\/coffer\/apple-touch-icon\.png">/);
  for (const file of ['logo.svg', 'logo-dark.svg', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
    assert.ok(existsSync(join(dist, 'assets', 'coffer', file)), `assets/coffer/${file} is published`);
  }
});

test('the page of specloop keeps its own words and its accented name', () => {
  const other = output('made/specloop/index.html');
  assert.match(other, /<div class="landing landing-specloop">/);
  assert.match(other, /<span>spec<span class="lp-accent">loop<\/span><\/span>/);
  assert.match(other, /aria-label="A terminal session in Claude Code/);
  assert.doesNotMatch(other, /landing-coffer/);
});

test('the words of the page are in landing.md, not in the layout', () => {
  const layout = [
    readFileSync(join(themeDir, 'templates', 'partials', 'landing.njk'), 'utf8').replace(/\{#[\s\S]*?#\}/g, ''),
    css.replace(/\/\*[\s\S]*?\*\//g, ''),
  ].join('\n');
  for (const phrase of ['Write the post', 'A photo journal grows a build script', 'Why not Hugo', 'Publishing is a push', 'Does it need a server']) {
    assert.ok(source.includes(phrase), `landing.md has "${phrase}"`);
    assert.ok(!layout.includes(phrase), `the layout does not repeat "${phrase}"`);
  }
});

test('the page uses no script of its own and loads nothing from another host', () => {
  const body = /<section id="hero"[\s\S]*<\/section>/.exec(page)?.[0] ?? '';
  assert.doesNotMatch(body, /<script/);
  assert.doesNotMatch(body, /<(?:img|link|source)\b[^>]*(?:src|href)="https?:/);
});

// --- the widths ----------------------------------------------------------------

test('the final call to action has no <hr>, and its closing line stays as written', () => {
  const section = part('final-cta');
  assert.doesNotMatch(section, /<hr/);
  assert.doesNotMatch(page, /<hr/, 'no stray rule on the page: the dividers are borders of the sections');
  assert.match(section, /<p>coffer · Apache-2\.0 · /, 'the Markdown text is the one in landing.md');
  assert.match(source, /\n---\n\ncoffer · Apache-2\.0 · /, 'landing.md still has its --- line');
});

test('the FAQ column is as wide as the other sections', () => {
  const rules = readRules(css);
  assert.deepEqual(rules.filter((rule) => rule.selector === '.lp-s-faq .lp-wrap'), []);
  const answer = rules.find((rule) => rule.media === null && rule.selector === '.lp-answer p');
  assert.ok(answer);
  assert.ok(Number.parseFloat(answer.declarations['max-width']) <= 780, 'the answers keep a reading width');
});

// --- the gold palette ----------------------------------------------------------

const rules = readRules(css);
/** @param {string | null} media @param {string} selector @returns {Record<string, string>} */
function declarations(media, selector) {
  // A selector may have another rule for the frame; the palette is the one that declares custom properties.
  const found = rules.filter((rule) => rule.media === media && rule.selector === selector && Object.keys(rule.declarations).some((name) => name.startsWith('--')));
  assert.equal(found.length, 1, `one palette rule "${selector}"${media ? ` in @media ${media}` : ''}`);
  return found[0].declarations;
}

const base = declarations(null, '.landing');
const darkBase = { ...base, ...declarations(null, ':root[data-theme="dark"] .landing') };
const lightGold = declarations(null, '.landing-coffer');
const darkGold = declarations(null, ':root[data-theme="dark"] .landing-coffer');
const light = { ...base, ...lightGold };
const dark = { ...darkBase, ...darkGold };

test('the gold is the one of the logo, and the dark scheme is the same under the system preference and under the switch', () => {
  assert.deepEqual(declarations('(prefers-color-scheme: dark)', ':root:not([data-theme="light"]) .landing-coffer'), darkGold);
  const logoLight = readFileSync(join(dist, 'assets', 'coffer', 'logo.svg'), 'utf8').toLowerCase();
  const logoDark = readFileSync(join(dist, 'assets', 'coffer', 'logo-dark.svg'), 'utf8').toLowerCase();
  assert.equal(light['--accent'], '#9a6b1f');
  assert.ok(logoLight.includes(light['--accent']), 'the accent of the light scheme is the gold of the light logo');
  assert.equal(dark['--accent'], '#d9a84e');
  assert.ok(logoDark.includes(dark['--accent']), 'the accent of the dark scheme is the gold of the dark logo');
  // Only the accent and what is tinted with it differ from the palette of the other landing page.
  assert.deepEqual(Object.keys(lightGold).sort(), ['--accent', '--accent-soft', '--accent-text', '--term-accent']);
  assert.deepEqual(Object.keys(darkGold).sort(), ['--accent', '--accent-soft', '--accent-text']);
});

for (const [scheme, t] of /** @type {const} */ ([['light', light], ['dark', dark]])) {
  test(`${scheme}: every text colour of the gold palette has AA contrast on the surfaces it is used on`, () => {
    /** @type {Array<[string, string, string, number]>} text, background, what, minimum */
    const pairs = [
      [t['--fg'], t['--accent-soft'], 'text in the callout', 4.5],
      [t['--accent-text'], t['--bg'], 'accent text (links, eyebrows)', 4.5],
      [t['--accent-text'], t['--bg-alt'], 'accent text on the alternating background', 4.5],
      [t['--on-accent'], t['--accent'], 'text on the primary button', 4.5],
      [t['--accent'], t['--bg'], 'large accent text (the headline, the numbers)', 3],
      [t['--accent'], t['--bg-alt'], 'large accent text on the alternating background', 3],
      [t['--term-accent'], t['--term-bg'], 'terminal prompts', 4.5],
    ];
    for (const [text, background, what, minimum] of pairs) {
      assert.ok(contrastRatio(text, background) >= minimum, `${scheme}: ${what}: ${text} on ${background} is ${contrastRatio(text, background).toFixed(2)}:1, wanted ${minimum}`);
    }
  });
}
