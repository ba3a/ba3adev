// Assertions about the documentation of coffer at /made/coffer/docs/: the
// guides of the engine (docs/ in ba3a/coffer) and their links.
//
// `npm run test:sites` builds the sites into `.cache/test-dist` and runs
// `coffer check` on them before these tests start.
//
// The docs source of coffer is a git address, like the ones of roto and specloop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, '.cache', 'test-dist', 'ba3a.dev');
const engine = join(root, 'node_modules', 'coffer');
const docsUrl = '/made/coffer/docs/';
const github = 'https://github.com/ba3a/coffer';

/** @param {string} file Path relative to the output of the site. @returns {string} */
const page = (file) => readFileSync(join(dist, file), 'utf8');

/** @param {string} url A site address. @returns {string} The file of the page in the output. */
const fileOf = (url) => join(dist, ...url.split('/').filter(Boolean), 'index.html');

/** @param {string} html @returns {string[]} The values of the `href` attributes. */
const hrefs = (html) => [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1]);

const manifest = JSON.parse(page('.coffer-manifest.json'));
const project = manifest.projects.find((/** @type {{ slug: string }} */ candidate) => candidate.slug === 'coffer');
const declarationFile = join(root, 'content', 'ba3a.dev', 'projects', 'coffer', 'project.yaml');
const declarationText = readFileSync(declarationFile, 'utf8');
const declaration = parseYaml(declarationText);

/** The Markdown files named in the table of contents of the README of the guides, in order. */
function tableOfContents() {
  const readme = readFileSync(join(engine, 'docs', 'README.md'), 'utf8');
  return [...readme.matchAll(/^\s*[-*]\s+\[[^\]]+\]\(([A-Za-z0-9._-]+\.md)(?:#[^)]*)?\)/gm)].map((match) => match[1]);
}

test('the docs of coffer come from the git repository of the engine, with no reference', () => {
  assert.deepEqual(declaration.docs.source, { git: 'https://github.com/ba3a/coffer.git', ref: 'main' });
  assert.equal(declaration.docs.github, undefined);
  assert.equal(declaration.docs.guides.length, 1);
  assert.equal(declaration.docs.guides[0].dir, 'docs');
  assert.equal(declaration.docs.reference, undefined, 'there is no reference for now');
  assert.doesNotMatch(declarationText, /GO-LIVE/);
});

test('the guides are in the order of the table of contents of docs/README.md', () => {
  const toc = tableOfContents();
  assert.ok(toc.length >= 20, 'the README lists the guides');
  assert.deepEqual(
    declaration.docs.guides[0].order,
    toc,
    'the table of contents of github.com/ba3a/coffer/blob/v0.1.0/docs/README.md changed: update docs.guides[0].order in content/ba3a.dev/projects/coffer/project.yaml to match',
  );
});

test('ba3a.dev/made/coffer/docs/ renders every feature page of the engine', () => {
  assert.ok(project?.docs, 'the manifest has the docs of coffer');
  assert.equal(project.docs.source.type, 'git');
  assert.equal(project.docs.github, 'ba3a/coffer');
  assert.ok(existsSync(fileOf(docsUrl)), 'the docs index exists');
  const sources = readdirSync(join(engine, 'docs')).filter((name) => name.endsWith('.md'));
  assert.ok(sources.length >= 20, `the engine has feature pages (${sources.length})`);
  const published = project.docs.pages.map((/** @type {{ source: string }} */ entry) => entry.source).sort();
  assert.deepEqual(published, sources.map((name) => `docs/${name}`).sort(), 'every page of the docs folder is built, and nothing else');
  assert.equal(project.docs.pages[0].source, 'docs/README.md', 'the README is the docs index');
  assert.equal(project.docs.pages[0].url, docsUrl);
  assert.deepEqual(
    project.docs.pages.slice(1).map((/** @type {{ source: string }} */ entry) => entry.source.replace(/^docs\//, '')),
    tableOfContents(),
    'the pages follow the table of contents',
  );
  for (const entry of project.docs.pages) {
    assert.ok(existsSync(join(dist, entry.file)), `${entry.url} was written`);
    assert.match(page(entry.file), /<h1[^>]*>[^<]+<\/h1>/, `${entry.url} has a title`);
  }
  // There is no reference, and the sidebar lists exactly the pages.
  assert.equal(project.docs.reference ?? null, null);
  assert.ok(!existsSync(fileOf(`${docsUrl}reference/`)), 'no reference page is published');
  const sidebar = /<nav[^>]*documentation pages[\s\S]*?<\/nav>/.exec(page(project.docs.pages[0].file))?.[0] ?? '';
  assert.deepEqual(
    hrefs(sidebar).filter((href) => href.startsWith(docsUrl)),
    project.docs.pages.map((/** @type {{ url: string }} */ entry) => entry.url),
  );
  // The project page links to the docs.
  assert.ok(hrefs(page('made/coffer/index.html')).includes(docsUrl), 'the project page links the docs');
});

test('links between pages are site links to pages and anchors that exist', () => {
  const indexPage = page(project.docs.pages[0].file);
  const pagesByUrl = new Map(project.docs.pages.map((/** @type {{ url: string, file: string }} */ entry) => [entry.url, entry.file]));
  for (const name of tableOfContents()) {
    const url = `${docsUrl}${name.replace(/\.md$/, '')}/`;
    assert.ok(pagesByUrl.has(url), `${url} is a page`);
    assert.ok(hrefs(indexPage).includes(url), `the docs index links ${url}`);
  }
  let checked = 0;
  for (const entry of project.docs.pages) {
    for (const href of hrefs(page(entry.file))) {
      assert.ok(/^https?:/.test(href) || !/\.md(#|$)/.test(href), `${entry.url}: ${href} is still a Markdown link`);
      if (!href.startsWith(docsUrl)) continue;
      const [path, hash] = href.split('#');
      const file = pagesByUrl.get(path);
      assert.ok(file, `${entry.url}: ${href} leads to a page that exists`);
      if (hash) assert.ok(page(file).includes(`id="${hash}"`), `${entry.url}: ${href} leads to an anchor that exists`);
      checked += 1;
    }
  }
  assert.ok(checked >= 40, `the pages link each other (${checked} links checked)`);
});

test('links to files outside the guides (CHANGELOG, LICENSE, README, sources) point to github.com/ba3a/coffer', () => {
  const indexPage = page(project.docs.pages[0].file);
  assert.ok(hrefs(indexPage).includes(`${github}/blob/main/README.md`), 'the link to ../README.md leads to GitHub');
  for (const file of ['CHANGELOG.md', 'LICENSE']) assert.ok(existsSync(join(engine, file)), `the engine has ${file}`);
  let onGithub = 0;
  for (const entry of project.docs.pages) {
    const html = page(entry.file);
    for (const href of hrefs(html)) {
      if (/(^|\/)(CHANGELOG\.md|LICENSE|NOTICE|CONTRIBUTING\.md|README\.md)(#|$)/.test(href)) {
        assert.ok(href.startsWith(`${github}/blob/main/`), `${entry.url}: ${href} points to the file on GitHub`);
      }
      if (href.startsWith(github)) {
        assert.match(href, /^https:\/\/github\.com\/ba3a\/coffer\/(blob|tree)\/main(\/|$)/, `${entry.url}: ${href} is a file or folder address`);
        onGithub += 1;
      }
    }
  }
  assert.ok(onGithub >= 1, 'at least one page links to a file on GitHub');
});

test('the page of coffer links to its docs', () => {
  const tool = page('made/coffer/index.html');
  assert.ok(hrefs(tool).includes(docsUrl));
  assert.ok(tool.includes('project-fact-docs'));
  assert.ok(existsSync(fileOf(docsUrl)));
});
