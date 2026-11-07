// Assertions about the documentation of roto at /made/roto/docs/: the guides
// built from the roto repository, the Dokka API reference of roto-core built by
// Gradle with the init script of build-support/dokka/, and the links from
// guides to the reference.
//
// `npm run test:sites` builds the sites into `.cache/test-dist` and runs
// `coffer check` on them before these tests start. They read that output
// together with the checkout of the repository that the build fetched
// (`.cache/repos/roto`).
//
// NETWORK AND JDK. The docs source of roto is the public repository
// https://github.com/ba3a/roto.git (`ref: main`), cloned read-only over HTTPS
// by the build itself, and the reference is produced by running the Gradle
// wrapper of that checkout, which needs JDK 21 and, on the first run, the
// network (the Gradle distribution and the Dokka plugin). When any of that
// fails, `coffer build` fails with a message that names the project and the
// command, and these tests do not start; they never skip. The result is cached
// by commit and by the contents of the init script (see
// github.com/ba3a/coffer/blob/v0.1.0/docs/project-docs.md), so later runs do not run Gradle again.
//
// The Gradle build itself cannot be tested without Gradle, so the second half
// of this file builds a small site from a hand-written stand-in for the roto
// repository (scripts/site-test/fixtures/roto-mini), whose guide names
// roto-core types. The real guides of roto do not name any yet, so that
// fixture is how the links from guides to the reference are verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { buildSites, checkOutput, loadConfig } from 'coffer';
import { SymbolIndex, parseDokkaPages } from '../../node_modules/coffer/src/docs/symbols.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, '.cache', 'test-dist', 'ba3a.dev');
const checkout = join(root, '.cache', 'repos', 'roto');
const docsUrl = '/made/roto/docs/';
const referenceUrl = `${docsUrl}reference/`;
const initScript = join(root, 'build-support', 'dokka', 'dokka-init.gradle.kts');

/** @param {string} file Path relative to the output of the site. @returns {string} */
const page = (file) => readFileSync(join(dist, file), 'utf8');

/** @param {string} url A site address. @returns {string} The file of the page in the output. */
const fileOf = (url) => join(dist, ...url.split('/').filter(Boolean), 'index.html');

/** @param {string} html @returns {string[]} The values of the `href` attributes. */
const hrefs = (html) => [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1]);

const declaration = parseYaml(readFileSync(join(root, 'content', 'ba3a.dev', 'projects', 'roto', 'project.yaml'), 'utf8'));

// --- the configuration ----------------------------------------------------------------------

test('the docs of roto are configured to come from ba3a/roto on GitHub, with a Dokka reference of roto-core', () => {
  assert.equal(declaration.docs.source.git, 'https://github.com/ba3a/roto.git');
  assert.equal(declaration.docs.source.ref, 'main');
  assert.deepEqual(declaration.docs.guides, [{ dir: 'docs', order: ['pipeline.md', 'filming-guide.md'] }]);
  const reference = declaration.docs.reference;
  assert.equal(reference.format, 'html');
  assert.equal(reference.output, 'roto-core/build/dokka/html');
  assert.equal(reference.index, 'dokka', 'guides link to the reference through the Dokka symbol index');
  assert.match(reference.undocumented.pattern, /Undocumented/);
  // The same task on every system, with the init script of this repository; only the wrapper script differs.
  const posix = reference.command.default;
  const windows = reference.command.windows;
  assert.deepEqual(posix, ['./gradlew', '--no-daemon', '--init-script', '{site}/build-support/dokka/dokka-init.gradle.kts', ':roto-core:dokkaGeneratePublicationHtml']);
  assert.equal(windows, '.\\gradlew.bat --no-daemon --init-script {site}/build-support/dokka/dokka-init.gradle.kts :roto-core:dokkaGeneratePublicationHtml');
});

test('the init script puts a pinned Dokka 2 plugin on the build, for roto-core only, and does not touch the sources of roto', () => {
  const script = readFileSync(initScript, 'utf8');
  assert.match(script, /classpath\("org\.jetbrains\.dokka:dokka-gradle-plugin:2\.\d+\.\d+"\)/, 'the plugin version is pinned');
  assert.match(script, /val referencedProject = ":roto-core"/);
  assert.match(script, /if \(path != referencedProject\) return@allprojects/, 'every other project is left alone');
  assert.match(script, /"getReportUndocumented", true/);
  assert.match(script, /"getSuppressInheritedMembers", true/);
  assert.doesNotMatch(script, /writeText|File\(|copy|delete/, 'it changes no file');
  // The Dokka version matches the one roto uses, which is built with Kotlin 2.3.
  const catalog = join(checkout, 'gradle', 'libs.versions.toml');
  assert.ok(existsSync(catalog), 'the build left the checkout in .cache/repos/roto');
  const catalogText = readFileSync(catalog, 'utf8');
  const kotlin = /^kotlin = "(\d+\.\d+)/m.exec(catalogText)?.[1];
  assert.ok(kotlin && Number(kotlin.split('.')[0]) === 2 && Number(kotlin.split('.')[1]) >= 2, `roto uses Kotlin ${kotlin}, which Dokka 2.1 supports`);
});

// --- the real build -------------------------------------------------------------------------

const manifest = JSON.parse(page('.coffer-manifest.json'));
const project = manifest.projects.find((/** @type {{ slug: string }} */ candidate) => candidate.slug === 'roto');

test('ba3a.dev/made/roto/docs/ renders the guides of ba3a/roto', () => {
  assert.ok(project?.docs, 'the manifest has the docs of roto');
  assert.equal(project.docs.source.git, 'https://github.com/ba3a/roto.git');
  assert.equal(project.docs.github, 'ba3a/roto');
  assert.match(project.docs.source.sha, /^[0-9a-f]{40}$/);
  assert.ok(existsSync(fileOf(docsUrl)), 'the docs index exists');
  const sources = readdirSync(join(checkout, 'docs')).filter((name) => name.endsWith('.md'));
  const published = project.docs.pages.map((/** @type {{ source: string | null }} */ entry) => entry.source).filter(Boolean).sort();
  assert.deepEqual(published, sources.map((name) => `docs/${name}`).sort(), 'every guide of the repository is a page');
  // pipeline comes before filming-guide, as configured.
  const guides = project.docs.pages.filter((/** @type {{ source: string | null }} */ entry) => entry.source).map((/** @type {{ source: string }} */ entry) => entry.source);
  assert.deepEqual(guides.slice(0, 2), ['docs/pipeline.md', 'docs/filming-guide.md']);
  for (const entry of project.docs.pages) {
    assert.ok(existsSync(join(dist, entry.file)), `${entry.url} was written`);
    assert.match(page(entry.file), /<h1[^>]*>[^<]+<\/h1>/, `${entry.url} has a title`);
  }
  const pipeline = page(project.docs.pages.find((/** @type {{ source: string | null }} */ entry) => entry.source === 'docs/pipeline.md').file);
  assert.ok(hrefs(pipeline).includes(`${docsUrl}filming-guide/`), 'the link between the guides is a site link');
  // The project page links to the docs.
  assert.ok(hrefs(page('made/roto/index.html')).includes(docsUrl));
});

/** All public top-level types of roto-core, from the sources of the checkout: `{ qualified, file }`. */
function publicTypes() {
  const base = join(checkout, 'roto-core', 'src', 'main', 'kotlin');
  /** @type {{ qualified: string, file: string }[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.kt')) {
        const text = readFileSync(path, 'utf8');
        const pkg = /^package\s+([\w.]+)/m.exec(text)?.[1] ?? '';
        for (const line of text.split(/\r?\n/)) {
          const match = /^((?:@\w+(?:\([^)]*\))?\s+)*)((?:(?:public|private|internal|protected|data|sealed|enum|abstract|open|value|fun|inner|annotation|inline|const|expect|actual)\s+)*)(class|interface|object|typealias)\s+(\w+)/.exec(line);
          if (!match) continue;
          const modifiers = match[2].split(/\s+/);
          if (modifiers.includes('private') || modifiers.includes('internal')) continue;
          found.push({ qualified: `${pkg}.${match[4]}`, file: relative(base, path).replaceAll('\\', '/') });
        }
      }
    }
  };
  walk(base);
  return found;
}

test('/made/roto/docs/reference/ is the Dokka reference of roto-core, with a link back to the site, and has every public type', () => {
  const index = fileOf(referenceUrl);
  assert.ok(existsSync(index), 'the reference has an index page');
  assert.equal(project.docs.reference.url, referenceUrl);
  assert.equal(project.docs.reference.format, 'html');
  const html = readFileSync(index, 'utf8');
  assert.match(html, /<title>roto-core<\/title>/, 'it is the Dokka page of roto-core');
  assert.match(html, /<body[^>]*>\s*<div class="coffer-reference-bar"[^>]*><a href="\/made\/roto\/"[^>]*>&#8592; back to roto on ba3a\.dev<\/a><\/div>/, 'a link back to the site');
  // The reference is Dokka's own look, not the theme of the site.
  assert.doesNotMatch(html, /\/assets\/ba3a/);

  const records = JSON.parse(readFileSync(join(dist, 'made', 'roto', 'docs', 'reference', 'scripts', 'pages.json'), 'utf8'));
  /** @type {Map<string, string>} */
  const locations = new Map(records.map((/** @type {{ description: string, location: string }} */ record) => [record.description, record.location]));
  const types = publicTypes();
  assert.ok(types.length >= 50, `roto-core has public types (${types.length} found in the sources)`);
  const missing = types.filter((type) => !locations.has(type.qualified)).map((type) => `${type.qualified} (${type.file})`);
  assert.deepEqual(missing, [], 'every public type of roto-core is in the reference');
  for (const type of types) {
    const location = /** @type {string} */ (locations.get(type.qualified));
    assert.ok(existsSync(join(dist, 'made', 'roto', 'docs', 'reference', ...location.split('#')[0].split('/'))), `${type.qualified} has a page`);
  }
  // The symbol index the guides link through finds each of these types, by its simple and by its qualified name, without ambiguity.
  const symbols = new SymbolIndex(parseDokkaPages(JSON.stringify(records), referenceUrl));
  for (const type of types) {
    assert.ok('url' in (symbols.lookup(type.qualified) ?? {}), `${type.qualified} is found by its qualified name`);
    const simple = type.qualified.split('.').pop() ?? '';
    const found = symbols.lookup(simple);
    assert.ok(found === null || 'url' in found || found.ambiguous.length > 0);
  }
  const unique = types.filter((type) => 'url' in (symbols.lookup(type.qualified.split('.').pop() ?? '') ?? {}));
  assert.ok(unique.length >= types.length * 0.9, `most types are found by their simple name (${unique.length} of ${types.length})`);
  // The pages carry the bar too, not only the first one.
  const sample = readFileSync(join(dist, 'made', 'roto', 'docs', 'reference', ...String(locations.get(types[0].qualified)).split('/')), 'utf8');
  assert.match(sample, /coffer-reference-bar/);
});

test('every undocumented public declaration is in the build report, and the build passed', () => {
  const report = JSON.parse(readFileSync(join(root, '.coffer', 'report.json'), 'utf8'));
  assert.deepEqual(report.errors, [], 'the build has no errors');
  const warnings = report.warnings
    .map((/** @type {{ message: string }} */ warning) => warning.message)
    .filter((/** @type {string} */ message) => message.includes('projects/roto/project.yaml'));
  const names = project.docs.reference.undocumented;
  assert.equal(warnings.length, names.length, 'the report lists exactly the elements of the manifest');
  for (const name of names) {
    assert.ok(
      warnings.some((/** @type {string} */ message) => message.endsWith(`docs.reference: "${name}" has no documentation`)),
      `the build report lists ${name}`,
    );
  }
});

test('inline code in the real guides that names a roto-core type is linked, and every link into the reference leads to a page', () => {
  const records = JSON.parse(readFileSync(join(dist, 'made', 'roto', 'docs', 'reference', 'scripts', 'pages.json'), 'utf8'));
  /** @type {Map<string, Set<string>>} simple name -> locations */
  const bySimpleName = new Map();
  for (const record of records) {
    const simple = String(record.description).split('.').pop() ?? '';
    const set = bySimpleName.get(simple) ?? new Set();
    set.add(record.location);
    bySimpleName.set(simple, set);
  }
  for (const entry of project.docs.pages) {
    const html = page(entry.file);
    for (const href of hrefs(html).filter((value) => value.startsWith(referenceUrl))) {
      assert.ok(existsSync(join(dist, ...href.split('#')[0].split('/').filter(Boolean))), `${entry.url}: ${href} leads to a page of the reference`);
    }
    const body = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? html;
    for (const code of body.matchAll(/(<a [^>]*>)?<code>([^<]+)<\/code>/g)) {
      const locations = bySimpleName.get(code[2]);
      if (locations?.size === 1 && !/^[a-z]/.test(code[2])) {
        assert.ok(code[1]?.includes(`href="${referenceUrl}`), `${entry.url}: the type ${code[2]} is linked to the reference`);
      }
    }
  }
});

// --- guides that name roto-core types: a local docs fixture ---------------------------------------

const fixture = join(root, 'scripts', 'site-test', 'fixtures', 'roto-mini');

const FIXTURE_CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    description: A demo site.',
  '    projects: { dir: content/projects }',
  '',
].join('\n');

/**
 * Builds a small site whose project `roto` takes its docs from the fixture
 * (a folder source), with the command of the real project replaced by a program
 * that prints what Gradle prints for undocumented declarations.
 *
 * @template T
 * @param {(dir: string, results: Awaited<ReturnType<typeof buildSites>>) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inFixtureSite(body) {
  const dir = mkdtempSync(join(tmpdir(), 'roto-docs-fixture-'));
  try {
    cpSync(join(fixture, 'repo'), join(dir, 'repo'), { recursive: true });
    mkdirSync(join(dir, 'content', 'projects', 'roto'), { recursive: true });
    writeFileSync(join(dir, 'coffer.yaml'), FIXTURE_CONFIG);
    writeFileSync(join(dir, 'content', 'home.md'), '---\ntitle: Demo\n---\n\nAbout.\n');
    // The card of the real project is a valid PNG.
    cpSync(join(root, 'content', 'ba3a.dev', 'projects', 'roto', 'card.png'), join(dir, 'content', 'projects', 'roto', 'card.png'));
    writeFileSync(join(dir, 'content', 'projects', 'roto', 'index.md'), 'Text.\n');
    const real = declaration;
    const docs = {
      source: { path: '../../../repo' },
      github: 'ba3a/roto',
      guides: [{ dir: 'docs', order: ['overview.md', 'pipeline.md'] }],
      reference: {
        command: ['node', 'fake-gradle.mjs'],
        format: 'html',
        output: 'roto-core/build/dokka/html',
        title: real.docs.reference.title,
        undocumented: real.docs.reference.undocumented,
        index: real.docs.reference.index,
      },
    };
    writeFileSync(
      join(dir, 'content', 'projects', 'roto', 'project.yaml'),
      `name: roto\npitch: Pixel art from video.\nkind: tool\nstatus: in-development\ncard: card.png\ncardAlt: Card.\nrepo: https://github.com/ba3a/roto\ndocs: ${JSON.stringify(docs)}\n`,
    );
    const config = loadConfig({ configPath: join(dir, 'coffer.yaml') });
    const results = await buildSites(config, { out: join(dir, 'out'), now: new Date('2026-06-01T12:00:00Z') });
    return await body(dir, results);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('a guide that mentions a roto-core type in inline code links to its reference page', async () => {
  await inFixtureSite(async (dir) => {
    const overview = readFileSync(join(dir, 'out', 'demo', 'made', 'roto', 'docs', 'overview', 'index.html'), 'utf8');
    const base = '/made/roto/docs/reference/roto-core/com.roto.core.palette';
    // Inline code with a simple name and with a qualified name.
    assert.match(overview, new RegExp(`<a href="${base}/-project-palette/index\\.html"><code>ProjectPalette</code></a>`));
    assert.match(overview, new RegExp(`<a href="${base}/-ramp-set/index\\.html"><code>RampSet</code></a>`));
    assert.match(overview, new RegExp(`<a href="${base}/-ramp-set/index\\.html"><code>com\\.roto\\.core\\.palette\\.RampSet</code></a>`));
    // Explicit links.
    assert.match(overview, new RegExp(`<a href="${base}/-ramp-set/index\\.html">the ramp set</a>`));
    assert.match(overview, new RegExp(`<a href="${base}/-project-palette/-companion/load\\.html">the palette loader</a>`));
    // A name the reference does not have, and a code block, stay as they are.
    assert.match(overview, /<code>Nothing<\/code>/);
    assert.doesNotMatch(overview, /<a [^>]*><code>Nothing<\/code>/);
    assert.doesNotMatch(overview, /<a [^>]*>[^<]*ProjectPalette\.load/);
    // The links lead to pages of the published reference.
    for (const href of hrefs(overview).filter((value) => value.startsWith('/made/roto/docs/reference/'))) {
      assert.ok(existsSync(join(dir, 'out', 'demo', ...href.split('#')[0].split('/').filter(Boolean))), `${href} exists`);
    }
    // Links between the guides are site links.
    assert.ok(hrefs(overview).includes('/made/roto/docs/pipeline/'));
  });
});

test('the reference of the fixture is published with a link back, and the output passes the checks', async () => {
  await inFixtureSite(async (dir) => {
    const index = readFileSync(join(dir, 'out', 'demo', 'made', 'roto', 'docs', 'reference', 'index.html'), 'utf8');
    assert.match(index, /<div class="coffer-reference-bar"[^>]*><a href="\/made\/roto\/"[^>]*>&#8592; back to roto on Demo<\/a><\/div>/);
    const config = loadConfig({ configPath: join(dir, 'coffer.yaml') });
    const checked = await checkOutput(config, { out: join(dir, 'out') });
    assert.deepEqual(checked.failures, []);
  });
});

test('public declarations without KDoc appear in the report and the build still passes', async () => {
  await inFixtureSite(async (dir, results) => {
    const report = JSON.parse(readFileSync(join(dir, '.coffer', 'report.json'), 'utf8'));
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      report.warnings.map((/** @type {{ message: string }} */ warning) => warning.message),
      [
        'content/projects/roto/project.yaml: docs.reference: "com.roto.core/topLevelFun/#/" has no documentation',
        'content/projects/roto/project.yaml: docs.reference: "com.roto.core/Undoc/" has no documentation',
        'content/projects/roto/project.yaml: docs.reference: "com.roto.core/Undoc/foo/#kotlin.Int/" has no documentation',
      ],
    );
    const entry = results[0].manifest.projects.find((/** @type {{ slug: string }} */ candidate) => candidate.slug === 'roto');
    assert.deepEqual(entry?.docs?.reference?.undocumented, ['com.roto.core/topLevelFun/#/', 'com.roto.core/Undoc/', 'com.roto.core/Undoc/foo/#kotlin.Int/']);
  });
});
