// Assertions about where the landing layout (themes/ba3a/templates/partials/landing.njk) gets
// its settings: the `layout` of the front matter of the landing file (`project.landing.layout`),
// with a default for every setting. The layout keeps no setting of its own per project: the slug
// of a project gives nothing.
//
// The test builds a small site with the theme of ba3a.dev from a folder source (no network): five
// projects whose landing files are in one folder: one with a full `layout`, one with a layout
// whose settings are partly unknown, two without a layout (one of them named like a project that
// used to have a table entry), and one with strings that are empty or not strings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites, loadConfig } from 'coffer';

const root = fileURLToPath(new URL('../..', import.meta.url));
const themeDir = join(root, 'themes', 'ba3a');

/** The text of every landing file of the fixture: the sections the layout reshapes. */
const BODY = [
  '<div class="section-marker" id="hero"></div>',
  '',
  '###### Eyebrow',
  '',
  '# Plan. Build. Ship.',
  '',
  '```console',
  '$ fixture build',
  '```',
  '',
  '<div class="section-marker" id="problem"></div>',
  '',
  '###### The problem',
  '',
  '## Why',
  '',
  '> **You:** keep going',
  '',
  '```bash',
  'npm install',
  '```',
  '',
  '<div class="section-marker" id="timeline"></div>',
  '',
  '###### Timeline',
  '',
  '- **9:00** · Write the spec',
  '- **9:05** · *you* · Walk away',
  '',
  '<div class="section-marker" id="dogfood"></div>',
  '',
  '###### Dogfood',
  '',
  '- **12 → 14** · steps',
  '',
  '```console',
  '$ fixture check',
  'all done, no failures',
  'abcdef1 feat: first',
  '```',
  '',
  '<div class="section-marker" id="quick-start"></div>',
  '',
  '###### Quick start',
  '',
  '```bash',
  '/sl-feature',
  '```',
  '',
].join('\n');

const FULL_LAYOUT = [
  'layout:',
  '  visual: { problem: pre }',
  '  dogfood: terminal',
  '  hero: terminal',
  '  when: span',
  '  brand: 2',
  '  strings:',
  '    terminal_title: "own title"',
  '    hero_terminal: "own hero words"',
  '    problem_terminal: "own problem words"',
  '    dogfood_terminal: "own dogfood words"',
].join('\n');

// A layout with values the layout does not know, and no strings.
const PARTIAL_LAYOUT = ['layout:', '  dogfood: nonsense', '  when: never', '  brand: -3', '  visual: { hero: table }'].join('\n');

// A layout whose strings are empty or not strings.
const STRINGS_LAYOUT = [
  'layout:',
  '  visual: { problem: blockquote }',
  '  dogfood: gitlog',
  '  hero: session',
  '  when: time',
  '  brand: 2',
  '  strings:',
  '    terminal_title: "front matter title"',
  '    chat: "front matter chat words"',
  '    hero_terminal: ""',
  '    dogfood_terminal: 5',
].join('\n');

/** @type {string} */
let dir;
/** @type {Record<string, string>} */
const pages = {};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'landing-layout-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'site'), { recursive: true });
  const files = { alpha: FULL_LAYOUT, beta: PARTIAL_LAYOUT, gamma: null, coffer: null, delta: STRINGS_LAYOUT };
  for (const [slug, layout] of Object.entries(files)) {
    const front = layout === null ? '' : `---\n${layout}\n---\n\n`;
    writeFileSync(join(repo, 'site', `${slug}.md`), front + BODY);
  }
  writeFileSync(
    join(dir, 'coffer.yaml'),
    [
      'sites:',
      '  - id: demo',
      '    baseUrl: https://demo.example',
      '    lang: en',
      '    title: Demo',
      '    description: A demo site.',
      `    theme: ${JSON.stringify(themeDir.replaceAll('\\', '/'))}`,
      '    projects: { dir: content/projects }',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'content'), { recursive: true });
  writeFileSync(join(dir, 'content', 'home.md'), '---\ntitle: Demo\n---\n\nAbout.\n');
  for (const slug of Object.keys(files)) {
    const folder = join(dir, 'content', 'projects', slug);
    mkdirSync(folder, { recursive: true });
    cpSync(join(root, 'content', 'ba3a.dev', 'projects', 'roto', 'card.png'), join(folder, 'card.png'));
    writeFileSync(
      join(folder, 'project.yaml'),
      [
        `name: ${slug}tool`,
        'pitch: A fixture.',
        'kind: tool',
        'status: released',
        'card: card.png',
        'cardAlt: Card.',
        `repo: https://github.com/example/${slug}`,
        `landing: { file: site/${slug}.md }`,
        `docs: { source: { path: ../../../repo } }`,
        '',
      ].join('\n'),
    );
  }
  const config = loadConfig({ configPath: join(dir, 'coffer.yaml') });
  await buildSites(config, { out: join(dir, 'out'), now: new Date('2026-06-01T12:00:00Z') });
  for (const slug of Object.keys(files)) pages[slug] = readFileSync(join(dir, 'out', 'demo', 'made', slug, 'index.html'), 'utf8');
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** @param {string} page @param {string} name @returns {string} */
function section(page, name) {
  const found = new RegExp(`<section id="${name}"[\\s\\S]*?</section>`).exec(page);
  assert.ok(found, `the page has the section ${name}`);
  return found[0];
}

test('a layout in the front matter sets the visuals, the terminal kinds, the label element and the accent', () => {
  const page = pages.alpha;
  // visual.problem: pre (the default is the first blockquote, a chat).
  assert.match(section(page, 'problem'), /<div class="lp-term lp-term-plain" role="group" aria-label="own problem words">/);
  assert.doesNotMatch(section(page, 'problem'), /lp-chat/);
  // hero: terminal (the default is a session): the `$` prompt is the accented one.
  assert.match(section(page, 'hero'), /<span class="lp-t-p">\$<\/span> fixture build/);
  // dogfood: terminal (the default is a git log): "no failures" is the success colour.
  assert.match(section(page, 'dogfood'), /<span class="lp-t-p">\$<\/span> fixture check/);
  assert.match(section(page, 'dogfood'), /<span class="lp-t-ok">no failures<\/span>/);
  assert.doesNotMatch(section(page, 'dogfood'), /<span class="lp-t-w">abcdef1<\/span>/, 'no git log colouring');
  // when: span (the default is <time>).
  assert.match(section(page, 'timeline'), /<li><span class="lp-when">9:00<\/span> Write the spec<\/li>/);
  assert.match(section(page, 'timeline'), /<li class="lp-you"><span class="lp-when">9:05<\/span><em class="lp-sr">you<\/em> Walk away<\/li>/);
  assert.doesNotMatch(section(page, 'timeline'), /<time>/);
  // brand: 2 letters before the accent.
  assert.match(page, /<span>al<span class="lp-accent">phatool<\/span><\/span>/);
});

test('the strings of the front matter are the words the layout adds', () => {
  const page = pages.alpha;
  assert.match(section(page, 'hero'), /aria-label="own hero words"/);
  assert.match(section(page, 'hero'), /<b>own title<\/b>/);
  assert.match(section(page, 'dogfood'), /aria-label="own dogfood words"/);
  assert.doesNotMatch(page, /A terminal session in Claude Code/, 'no default string where the front matter has one');
  assert.doesNotMatch(page, /my-project/);
});

test('a setting that is missing or unknown gives the default layout, with the default strings', () => {
  const page = pages.beta;
  // visual: the problem is the chat; the hero (an unknown element) is a pre.
  assert.match(section(page, 'problem'), /<div class="lp-chat" role="group" aria-label="A typical chat without specloop, in which the person keeps asking Claude to continue\.">/);
  assert.match(section(page, 'hero'), /<div class="lp-term" role="group" aria-label="A terminal session in Claude Code, running a feature from a spec to reviewed commits\.">/);
  // hero: a session.
  assert.match(section(page, 'hero'), /<b>claude — my-project<\/b>/);
  // dogfood: a git log, the hash is warning-coloured.
  assert.match(section(page, 'dogfood'), /aria-label="The git log of a feature that specloop built, one commit per step\.">/);
  assert.match(section(page, 'dogfood'), /<span class="lp-t-w">abcdef1<\/span>/);
  assert.doesNotMatch(section(page, 'dogfood'), /lp-t-ok">no failures/);
  // when: <time>.
  assert.match(section(page, 'timeline'), /<li><time>9:00<\/time> Write the spec<\/li>/);
  // brand: four letters.
  assert.match(page, /<span>beta<span class="lp-accent">tool<\/span><\/span>/);
});

test('a page without a layout in its front matter is laid out with the defaults', () => {
  for (const slug of ['gamma', 'coffer']) {
    const page = pages[slug];
    assert.match(section(page, 'problem'), /lp-chat/, slug);
    assert.match(section(page, 'timeline'), /<li><time>9:00<\/time> Write the spec<\/li>/, slug);
    assert.match(section(page, 'dogfood'), /<span class="lp-t-w">abcdef1<\/span>/, slug);
    assert.match(section(page, 'hero'), /aria-label="A terminal session in Claude Code/, slug);
    assert.match(section(page, 'hero'), /<b>claude — my-project<\/b>/, slug);
  }
  assert.match(pages.gamma, /<span>gamm<span class="lp-accent">atool<\/span><\/span>/);
});

test('the slug of a project gives no setting: coffer without a layout is laid out like any other page', () => {
  const page = pages.coffer;
  // The table of the layout used to give coffer: problem pre, hero terminal, dogfood plain, when span, brand 0.
  assert.doesNotMatch(section(page, 'problem'), /lp-term/);
  assert.doesNotMatch(section(page, 'hero'), /<span class="lp-t-p">\$<\/span>/, 'a session, not a terminal');
  assert.doesNotMatch(section(page, 'timeline'), /lp-when/);
  assert.match(page, /<span>coff<span class="lp-accent">ertool<\/span><\/span>/);
  assert.doesNotMatch(page, /coffer — example site|builds and checks the example site|build-info\.json/, 'none of the words that were under landing.coffer');
});

test('the layout of the front matter sets the settings it names, and the rest are defaults', () => {
  const page = pages.delta;
  assert.match(section(page, 'problem'), /<div class="lp-chat" role="group" aria-label="front matter chat words">/);
  assert.match(section(page, 'hero'), /<b>front matter title<\/b>/);
  assert.match(section(page, 'timeline'), /<li><time>9:00<\/time> Write the spec<\/li>/);
  assert.match(page, /<span>de<span class="lp-accent">ltatool<\/span><\/span>/);
});

test('an empty or non-string string of the front matter gives the default string', () => {
  const page = pages.delta;
  assert.match(section(page, 'hero'), /aria-label="A terminal session in Claude Code, running a feature from a spec to reviewed commits\."/);
  assert.match(section(page, 'dogfood'), /aria-label="The git log of a feature that specloop built, one commit per step\."/);
});

test('the layout keeps no setting of its own per project: no table, no fallback, no strings under a slug', () => {
  const layout = readFileSync(join(themeDir, 'templates', 'partials', 'landing.njk'), 'utf8').replace(/\r\n/g, '\n');
  const code = layout.replace(/\{#[\s\S]*?#\}/g, '');
  assert.match(code, /project\.landing\.layout/);
  assert.doesNotMatch(code, /layouts|legacy/, 'the layout has no table and no fallback');
  assert.doesNotMatch(layout, /REMOVE when the last project has moved/);
  assert.doesNotMatch(layout, /index\.md|landing\.(coffer|specloop)/, 'the comments name no index.md and no strings of a project');
  const strings = readFileSync(join(themeDir, 'i18n', 'en.yaml'), 'utf8');
  assert.match(strings, /^ {2}default:\n( {4}\w+:.*\n)+/m, 'i18n/en.yaml has landing.default');
  assert.deepEqual(
    [...strings.matchAll(/^ {2}([a-z_]+):/gm)].map((match) => match[1]),
    ['nav', 'github', 'default'],
    'landing.nav, landing.github and landing.default are the only entries: none per slug',
  );
});
