// Assertions about the landing page of specloop (/made/specloop/) and the layout
// that renders it: themes/ba3a/templates/partials/landing.njk and
// themes/ba3a/assets/landing.css. `npm run test:sites` builds the sites into
// `.cache/test-dist` first; these tests read the theme sources and that output.
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

const SECTIONS = ['hero', 'problem', 'how-it-works', 'timeline', 'spec-example', 'features', 'dogfood', 'quick-start', 'faq', 'final-cta'];

const page = output('made/specloop/index.html');
const css = readFileSync(join(themeDir, 'assets', 'landing.css'), 'utf8');
// The text of the page is the file of the specloop repository, in the checkout the docs are built from.
const sourcePath = join(root, '.cache', 'repos', 'specloop', 'site', 'landing.md');
assert.ok(existsSync(sourcePath), '.cache/repos/specloop/site/landing.md exists (run "npm run test:sites")');
const source = readFileSync(sourcePath, 'utf8');

// --- the page ------------------------------------------------------------------

test('the page has the ten sections, in order, each with its name as id, and no marker is left', () => {
  assert.deepEqual([...page.matchAll(/<section id="([a-z-]+)" class="lp-section/g)].map((match) => match[1]), SECTIONS);
  assert.doesNotMatch(page, /section-marker/);
  // The names in the source are the ones the layout renders.
  assert.deepEqual([...source.matchAll(/<div class="section-marker" id="([a-z-]+)"><\/div>/g)].map((match) => match[1]), SECTIONS);
});

test('the section names the top bar and the buttons link to exist as ids on the page', () => {
  const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const targets = [...page.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length >= 4);
  for (const target of targets) assert.ok(ids.has(target), `#${target} exists`);
  for (const name of ['how-it-works', 'dogfood', 'quick-start']) assert.match(page, new RegExp(`class="lp-link" href="#${name}"`));
  // No id is used twice (the eyebrow's own id is dropped when it becomes a paragraph).
  const all = [...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(all).size, all.length, 'every id is unique');
});

test('the eyebrows are paragraphs, the headline is the only h1, and the questions are closed <details>', () => {
  assert.doesNotMatch(page, /<h6/);
  assert.equal(page.match(/<p class="lp-eyebrow">/g)?.length, 9, 'nine eyebrows: every section but the last');
  assert.equal(page.match(/<h1[ >]/g)?.length, 1);
  assert.match(page, /<h1 [^>]*><span class="lp-line">Write the spec\.<\/span> <span class="lp-line lp-accent">Go make tea\.<\/span> <span class="lp-line">Come back to reviewed commits\.<\/span><\/h1>/);
  const faq = /<section id="faq"[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';
  assert.equal(faq.match(/<details>/g)?.length, 6);
  assert.doesNotMatch(faq, /<details open/);
  assert.equal(faq.match(/<summary>/g)?.length, 6);
});

test('each part of the Markdown is rendered as the style guide says', () => {
  const part = (/** @type {string} */ name) => /** @type {RegExpExecArray} */ (new RegExp(`<section id="${name}"[\\s\\S]*?</section>`).exec(page))[0];
  assert.equal(part('how-it-works').match(/<li class="lp-card">/g)?.length, 3, 'the table is three cards');
  assert.match(part('how-it-works'), /<p class="lp-gate"><b>Gate:<\/b> /, 'the gate label comes from the table head');
  assert.equal(part('problem').match(/<p class="lp-you">/g)?.length, 4);
  assert.equal(part('problem').match(/<p class="lp-ai">/g)?.length, 4);
  assert.match(part('problem'), /<div class="lp-chat" role="group" aria-label="[^"]+">/);
  assert.equal(part('timeline').match(/<li class="lp-you">/g)?.length, 3, 'three steps are the person\'s');
  assert.equal(part('timeline').match(/<li>/g)?.length, 3);
  assert.equal(part('features').match(/<li class="lp-card">/g)?.length, 8);
  assert.match(part('features'), /<span class="lp-ico" aria-hidden="true">🚧<\/span><h3>Hard gates<\/h3>/);
  assert.equal(part('dogfood').match(/<li class="lp-stat">/g)?.length, 4);
  assert.match(part('dogfood'), /<li class="lp-stat"><b>12 → 14<\/b><span>/);
  assert.match(part('dogfood'), /<blockquote>/, 'the callout stays a quote');
  assert.match(part('hero'), /<div class="lp-term" role="group" aria-label="[^"]+">/);
  assert.match(part('hero'), /<span class="lp-cursor" aria-hidden="true"><\/span>/);
  assert.match(part('dogfood'), /<div class="lp-term lp-term-plain" role="group" aria-label="[^"]+">/);
  assert.match(part('dogfood'), /<span class="lp-t-w">888ab25<\/span>/, 'commit hashes are warning-coloured');
  assert.match(part('quick-start'), /<span class="lp-t-p">\/sl-feature<\/span>/);
  assert.match(part('spec-example'), /<span class="line lp-t-p">## Goal<\/span>/);
});

test('the page keeps what every project page has: the facts, the feed link and the way back', () => {
  assert.match(page, /<dd><a href="https:\/\/github\.com\/ba3a\/specloop" rel="noopener">github\.com\/ba3a\/specloop<\/a><\/dd>/);
  assert.match(page, /<dd>0BSD<\/dd>/);
  assert.match(page, /href="\/made\/specloop\/docs\/"/);
  assert.match(page, /<a rel="alternate" type="application\/atom\+xml" href="\/made\/specloop\/feed\.xml">/);
  assert.match(page, /<p class="all-projects"><a href="\/made\/">/);
});

test('the head has the title, the description, the preview image, the stylesheet and the favicons of the brand', () => {
  assert.match(page, /<title>specloop \| ba3a\.dev<\/title>/);
  assert.match(page, /<meta name="description" content="A spec-driven plan → implement → review loop for Claude Code\. Hand it a spec/);
  assert.match(page, /<meta property="og:image" content="https:\/\/ba3a\.dev\/img\/[0-9a-f]+\/card-1200\.webp">/);
  assert.match(page, /<link rel="stylesheet" href="\/assets\/landing\.css">/);
  assert.match(page, /<link rel="icon" href="\/assets\/specloop\/favicon\.ico" sizes="any">/);
  assert.match(page, /<link rel="icon" href="\/assets\/specloop\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(page, /<link rel="apple-touch-icon" href="\/assets\/specloop\/apple-touch-icon\.png">/);
  for (const file of ['logo.svg', 'logo-dark.svg', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
    assert.ok(existsSync(join(dist, 'assets', 'specloop', file)), `assets/specloop/${file} is published`);
  }
  for (const file of ['inter-latin-wght-normal.woff2', 'jetbrains-mono-latin-wght-normal.woff2', 'OFL-Inter.txt', 'OFL-JetBrains-Mono.txt']) {
    assert.ok(existsSync(join(dist, 'assets', 'fonts', file)), `assets/fonts/${file} is published`);
  }
});

test('no other page loads the landing stylesheet, the landing markup or its fonts', () => {
  for (const file of ['made/roto/index.html', 'made/faultory/index.html', 'made/index.html', 'index.html']) {
    const html = output(file);
    assert.doesNotMatch(html, /landing\.css|class="landing"|lp-section|inter-latin/, file);
  }
});

test('the words of the page are in landing.md, not in the layout', () => {
  const layout = [
    readFileSync(join(themeDir, 'templates', 'partials', 'landing.njk'), 'utf8').replace(/\{#[\s\S]*?#\}/g, ''),
    readFileSync(join(themeDir, 'templates', 'project-tool.njk'), 'utf8').replace(/\{#[\s\S]*?#\}/g, ''),
    css.replace(/\/\*[\s\S]*?\*\//g, ''),
  ].join('\n');
  for (const phrase of ['Go make tea', 'Right now, you are the loop', 'Questions people ask', 'Stop typing', 'Does it cost extra', 'How it works', 'Quick start']) {
    assert.ok(source.includes(phrase), `landing.md has "${phrase}"`);
    assert.ok(!layout.includes(phrase), `the layout does not repeat "${phrase}"`);
  }
});

test('project-tool.njk extends the engine\'s own and only overrides the head and the page body', () => {
  const template = readFileSync(join(themeDir, 'templates', 'project-tool.njk'), 'utf8').replace(/\{#[\s\S]*?#\}/g, '');
  assert.match(template.trimStart(), /^\{%-?\s*extends\s+"coffer:project-tool\.njk"\s*-?%\}/);
  const blocks = [...template.matchAll(/\{%-?\s*block\s+([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(blocks, ['head', 'project_header', 'project_body']);
  // Without markers the engine's own page is written: every override is behind the landing flag.
  assert.match(template, /\{% set landing = 'class="section-marker"' in /);
  assert.match(template, /\{% block project_header %\}\{% if not landing %\}\{\{ super\(\) \}\}\{% endif %\}\{% endblock %\}/);
});

test('the stylesheet loads nothing from another host and the page uses no script of its own', () => {
  assert.doesNotMatch(css, /https?:\/\//);
  assert.doesNotMatch(css, /@import/);
  const body = /<section id="hero"[\s\S]*<\/section>/.exec(page)?.[0] ?? '';
  assert.doesNotMatch(body, /<script/);
});

// --- the widths ----------------------------------------------------------------
//
// Every rule inside a section sits in the column of .lp-wrap, which is also the frame
// of the header and footer (ba3a-theme.test.mjs). Only the dividers between sections
// are full-bleed.

test('the final call to action has no <hr>, and its closing line stays as written', () => {
  const section = /<section id="final-cta"[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';
  assert.ok(section.length > 0);
  assert.doesNotMatch(section, /<hr/);
  assert.doesNotMatch(page, /<hr/, 'no stray rule on the page: the dividers are borders of the sections');
  assert.match(section, /<p>specloop · 0BSD · do anything with it\./, 'the Markdown text is the one in landing.md');
  assert.match(source, /\n---\n\nspecloop · 0BSD/, 'landing.md still has its --- line');
});

test('the FAQ column has the standard width, and only the answer text is capped at a reading width', () => {
  const rules = readRules(css);
  const wrapWidth = Number.parseFloat(/** @type {{ declarations: Record<string, string> }} */ (rules.find((rule) => rule.media === null && rule.selector === '.lp-wrap')).declarations['max-width']);
  // No section narrows its .lp-wrap below the standard width (the cards, the visuals and the answers are capped by their own rules).
  for (const rule of rules.filter((candidate) => selectorParts(candidate.selector).some((part) => /\.lp-wrap$/.test(part) && part !== '.lp-wrap'))) {
    if (!('max-width' in rule.declarations)) continue;
    assert.ok(Number.parseFloat(rule.declarations['max-width']) >= wrapWidth, `${rule.selector} is not narrower than .lp-wrap (${wrapWidth}px)`);
  }
  assert.deepEqual(rules.filter((rule) => rule.selector === '.lp-s-faq .lp-wrap'), []);
  const answer = rules.find((rule) => rule.media === null && rule.selector === '.lp-answer p');
  assert.ok(answer, 'the answers have a rule');
  assert.equal(answer.declarations['max-width'], '780px');
  assert.ok(Number.parseFloat(answer.declarations['max-width']) <= 780);
  // The question rows fill the column: the details are not capped.
  assert.ok(rules.every((rule) => !/^\.lp-s-faq details\b/.test(rule.selector) || !('max-width' in rule.declarations)));
});

test('the closing line of the final call to action is styled without the <hr>', () => {
  const rules = readRules(css);
  assert.deepEqual(rules.filter((rule) => /hr\b/.test(rule.selector)), [], 'no rule styles an <hr> any more');
  const closing = rules.find((rule) => rule.media === null && rule.selector === '.lp-s-final-cta .lp-wrap > p:last-child');
  assert.ok(closing, 'the closing paragraph is the last child of the section');
  assert.equal(closing.declarations.margin, '56px 0 0');
});

/** @param {string} selectors @returns {string[]} */
function selectorParts(selectors) {
  return selectors.split(',').map((part) => part.trim());
}

// --- contrast ------------------------------------------------------------------

const rules = readRules(css);
/** @param {string | null} media @param {string} selector @returns {Record<string, string>} */
function tokens(media, selector) {
  // The tokens are in the rule of the selector that declares --bg; the selector may have another rule for the frame.
  const found = rules.filter((rule) => rule.media === media && rule.selector === selector && '--bg' in rule.declarations);
  assert.equal(found.length, 1, `one token rule "${selector}"${media ? ` in @media ${media}` : ''}`);
  return found[0].declarations;
}

const light = tokens(null, '.landing');
const darkOverrides = tokens('(prefers-color-scheme: dark)', ':root:not([data-theme="light"]) .landing');
const darkChoiceOverrides = tokens(null, ':root[data-theme="dark"] .landing');
const dark = { ...light, ...darkChoiceOverrides };

test('the dark scheme is the same under the system preference and under the switch', () => {
  assert.deepEqual(darkOverrides, darkChoiceOverrides);
});

test('the tokens are those of the style guide, plus --accent-text and --on-accent', () => {
  assert.deepEqual(
    Object.fromEntries(['--bg', '--bg-alt', '--fg', '--muted', '--line', '--accent', '--accent-soft', '--ok', '--term-bg', '--term-fg', '--term-muted', '--term-ok', '--term-warn', '--term-accent', '--radius'].map((name) => [name, light[name]])),
    {
      '--bg': '#fbfaf7', '--bg-alt': '#f2efe8', '--fg': '#1d1b18', '--muted': '#6b665d', '--line': '#e2ddd2', '--accent': '#c2521c',
      '--accent-soft': '#f6e3d6', '--ok': '#2f7d4f', '--term-bg': '#17161a', '--term-fg': '#e9e6df', '--term-muted': '#8a857b',
      '--term-ok': '#7fd19b', '--term-warn': '#f2b45c', '--term-accent': '#f08a50', '--radius': '14px',
    },
  );
  assert.deepEqual(
    Object.fromEntries(['--bg', '--bg-alt', '--fg', '--muted', '--line', '--accent', '--accent-soft', '--ok', '--term-bg'].map((name) => [name, dark[name]])),
    {
      '--bg': '#121114', '--bg-alt': '#1a191d', '--fg': '#ece9e2', '--muted': '#a19c92', '--line': '#2c2a30', '--accent': '#f08a50',
      '--accent-soft': '#2e1f17', '--ok': '#7fd19b', '--term-bg': '#0b0a0d',
    },
  );
});

for (const [scheme, t] of /** @type {const} */ ([['light', light], ['dark', dark]])) {
  test(`${scheme}: every text colour has AA contrast on the surfaces it is used on`, () => {
    /** @type {Array<[string, string, string, number]>} text, background, what, minimum */
    const pairs = [
      [t['--fg'], t['--bg'], 'body text', 4.5],
      [t['--fg'], t['--bg-alt'], 'body text on the alternating background', 4.5],
      [t['--fg'], t['--accent-soft'], 'text in the callout and the You bubbles', 4.5],
      [t['--muted'], t['--bg'], 'secondary text', 4.5],
      [t['--muted'], t['--bg-alt'], 'secondary text on the alternating background', 4.5],
      [t['--accent-text'], t['--bg'], 'accent text (links, eyebrows)', 4.5],
      [t['--accent-text'], t['--bg-alt'], 'accent text on the alternating background', 4.5],
      [t['--on-accent'], t['--accent'], 'text on the primary button', 4.5],
      [t['--accent'], t['--bg'], 'large accent text (the headline, the numbers)', 3],
      [t['--accent'], t['--bg-alt'], 'large accent text on the alternating background', 3],
      [t['--term-fg'], t['--term-bg'], 'terminal text', 4.5],
      [t['--term-muted'], t['--term-bg'], 'terminal comments', 4.5],
      [t['--term-ok'], t['--term-bg'], 'terminal success', 4.5],
      [t['--term-warn'], t['--term-bg'], 'terminal hashes', 4.5],
      [t['--term-accent'], t['--term-bg'], 'terminal prompts and commands', 4.5],
    ];
    for (const [text, background, what, minimum] of pairs) {
      assert.ok(contrastRatio(text, background) >= minimum, `${scheme}: ${what}: ${text} on ${background} is ${contrastRatio(text, background).toFixed(2)}:1, wanted ${minimum}`);
    }
  });
}
