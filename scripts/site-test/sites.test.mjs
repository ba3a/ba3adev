// Assertions about the two sites of this repository. `npm run test:sites` builds
// them into `.cache/test-dist` and runs `coffer check` on the result before it
// starts these tests, which only read the configuration, the content sources and
// that output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from 'coffer';
import sharp from 'sharp';

import { assertFullPosts, listPages, mainOf, readManifest, readPage, readPostSource } from './lib/full-posts.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, '.cache', 'test-dist');
const config = loadConfig({ configPath: join(root, 'coffer.yaml') });

/**
 * @param {string} id
 * @returns {import('coffer').SiteConfig}
 */
function siteConfig(id) {
  const site = config.sites.find((candidate) => candidate.id === id);
  assert.ok(site, `site ${id} is configured`);
  return site;
}

/**
 * @param {string} site
 * @param {string} file Path inside the site's output, with forward slashes.
 * @returns {string}
 */
function output(site, file) {
  const path = join(dist, site, ...file.split('/'));
  assert.ok(
    existsSync(path),
    `${site}/${file} exists in .cache/test-dist (run "npm run test:sites", which builds the sites first)`,
  );
  return readFileSync(path, 'utf8');
}

const ABOUT_START = 'I build performance-sensitive backend systems';

test('the repository configures exactly the two sites, in order', () => {
  assert.deepEqual(
    config.sites.map((site) => site.id),
    ['ba3a.dev', 'my.ba3a.dev'],
  );
});

test('ba3a.dev is an English site with a devlog and the agreed URL prefixes', () => {
  const site = siteConfig('ba3a.dev');
  assert.equal(site.baseUrl, 'https://ba3a.dev');
  assert.equal(site.lang, 'en');
  assert.equal(site.timezone, 'Europe/Samara');
  assert.equal(site.contentLicense, 'All rights reserved');
  assert.equal(site.contentDir, join(root, 'content', 'ba3a.dev'));
  assert.equal(site.theme, join(root, 'themes', 'ba3a'));
  assert.deepEqual(
    site.blogs.map((blog) => [blog.id, blog.prefix]),
    [['devlog', 'devlog']],
  );
  assert.deepEqual(
    { projects: site.urls.projects, docs: site.urls.docs, tags: site.urls.tags, series: site.urls.series },
    { projects: 'made', docs: 'docs', tags: 'tags', series: 'series' },
  );
  assert.equal(site.location.default, 'strip');
  assert.equal(site.location.camera, 'strip');
});

test('ba3a.dev links to GitHub and has no placeholder link that would be broken', () => {
  const site = siteConfig('ba3a.dev');
  assert.ok(site.links.some((link) => link.label === 'GitHub' && link.url === 'https://github.com/ba3a'));
  for (const link of site.links) {
    assert.doesNotMatch(link.url, /TODO|<|>/, `${link.label} is a real address`);
  }
});

test('my.ba3a.dev is a Russian site with one blog at the root', () => {
  const site = siteConfig('my.ba3a.dev');
  assert.equal(site.baseUrl, 'https://my.ba3a.dev');
  assert.equal(site.lang, 'ru');
  assert.equal(site.timezone, 'Europe/Samara');
  assert.equal(site.contentLicense, 'Все права защищены');
  assert.equal(site.contentDir, join(root, 'content', 'my.ba3a.dev'));
  assert.equal(site.theme, join(root, 'themes', 'my'));
  assert.equal(site.blogs.length, 1);
  assert.equal(site.blogs[0].prefix, '');
  assert.equal(site.location.default, 'strip');
  assert.equal(site.location.camera, 'strip');
});

test('every theme folder exists and is documented, so the build can fall back to the default theme', () => {
  for (const name of ['ba3a', 'my']) {
    assert.ok(existsSync(join(root, 'themes', name, 'README.md')), `themes/${name}/README.md exists`);
  }
});

test('the about text of the author is in the source, with no rewrite marker left', () => {
  const source = readFileSync(join(root, 'content', 'ba3a.dev', 'home.md'), 'utf8');
  assert.ok(!source.includes('TODO: rewrite'));
  assert.ok(source.includes(ABOUT_START));
});

test('the content folders and the blog folders exist, as a build needs them', () => {
  assert.ok(existsSync(join(root, 'content', 'my.ba3a.dev')));
  assert.ok(existsSync(join(root, 'content', 'ba3a.dev', 'devlog')));
});

test('ba3a.dev: the home page has the about text, the links and no author note', () => {
  const html = output('ba3a.dev', 'index.html');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/ba3a\.dev\/">/);
  assert.ok(html.includes(ABOUT_START));
  assert.doesNotMatch(html, /<!--\s*TODO/);
  assert.match(html, /href="https:\/\/github\.com\/ba3a"/);
  assert.match(html, /href="https:\/\/my\.ba3a\.dev"/);
  assert.match(html, /href="\/devlog\/feed\.xml"/);
  assert.match(html, /All rights reserved/);
});

test('ba3a.dev: the devlog index, its feed, the 404 page and the sitemap are written', () => {
  const index = output('ba3a.dev', 'devlog/index.html');
  assert.match(index, /<html lang="en">/);
  assert.match(index, /<link rel="canonical" href="https:\/\/ba3a\.dev\/devlog\/">/);
  assert.match(index, /<a href="\/devlog\/finally-built-me-a-site\/">Finally built me a site<\/a>/);

  const feed = output('ba3a.dev', 'devlog/feed.xml');
  assert.match(feed, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  assert.ok(feed.includes('https://ba3a.dev/devlog/feed.xml'));

  assert.match(output('ba3a.dev', '404.html'), /<html lang="en">/);

  const sitemap = output('ba3a.dev', 'sitemap.xml');
  assert.match(sitemap, /<loc>https:\/\/ba3a\.dev\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/ba3a\.dev\/devlog\/<\/loc>/);
  assert.match(output('ba3a.dev', 'robots.txt'), /https:\/\/ba3a\.dev\/sitemap\.xml/);
});

test('my.ba3a.dev: the blog index is the home page, in Russian, with its feed and 404 page', () => {
  const index = output('my.ba3a.dev', 'index.html');
  assert.match(index, /<html lang="ru">/);
  assert.match(index, /<link rel="canonical" href="https:\/\/my\.ba3a\.dev\/">/);
  assert.match(index, /Все права защищены/);
  assert.match(index, /href="\/feed\.xml"/);

  const feed = output('my.ba3a.dev', 'feed.xml');
  assert.match(feed, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  assert.ok(feed.includes('https://my.ba3a.dev/feed.xml'));

  assert.match(output('my.ba3a.dev', '404.html'), /<html lang="ru">/);

  const sitemap = output('my.ba3a.dev', 'sitemap.xml');
  assert.match(sitemap, /<loc>https:\/\/my\.ba3a\.dev\/<\/loc>/);
  assert.match(output('my.ba3a.dev', 'robots.txt'), /https:\/\/my\.ba3a\.dev\/sitemap\.xml/);
});

test('the two sites do not share output', () => {
  assert.ok(!output('my.ba3a.dev', 'index.html').includes(ABOUT_START));
  assert.ok(!existsSync(join(dist, 'my.ba3a.dev', 'devlog')));
});

/**
 * @param {string} dir Absolute directory.
 * @returns {string[]} Paths of every feed.xml below it, relative to it, with forward slashes.
 */
function feedFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === 'feed.xml')
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

for (const [id, base] of [
  ['ba3a.dev', 'https://ba3a.dev'],
  ['my.ba3a.dev', 'https://my.ba3a.dev'],
]) {
  test(`${id}: the site sets the icon, the favicon and the touch icon, and no logo`, () => {
    const site = siteConfig(id);
    assert.equal(site.icon, 'assets/brand/icon-192.png');
    assert.equal(site.favicon, 'assets/brand/favicon.ico');
    assert.equal(site.appleTouchIcon, 'assets/brand/apple-touch-icon.png');
    assert.ok(!site.logo, 'no logo is set');
  });

  test(`${id}: every feed has the absolute URL of the site icon and no logo`, async () => {
    const feeds = feedFiles(join(dist, id));
    assert.ok(feeds.length > 0, 'the site has feeds');
    if (id === 'ba3a.dev') {
      for (const feed of ['devlog/feed.xml', 'made/coffer/feed.xml', 'made/specloop/feed.xml', 'made/roto/feed.xml']) {
        assert.ok(feeds.includes(feed), `${feed} is among the feeds`);
      }
    } else {
      assert.ok(feeds.includes('feed.xml'), 'feed.xml is among the feeds');
    }
    const icon = `${base}/assets/brand/icon-192.png`;
    for (const feed of feeds) {
      const xml = output(id, feed);
      assert.equal(
        [...xml.matchAll(/<icon>([^<]*)<\/icon>/g)].map((match) => match[1]).join(),
        icon,
        `${id}/${feed} has one <icon>, the site icon`,
      );
      assert.doesNotMatch(xml, /<logo[ >]/, `${id}/${feed} has no <logo>`);
    }

    const file = join(dist, id, 'assets', 'brand', 'icon-192.png');
    assert.ok(existsSync(file), `${id}/assets/brand/icon-192.png is in the output`);
    const meta = await sharp(file).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, meta.height, 'the icon is square');
    assert.ok(meta.width >= 128, `the icon is at least 128 px (${meta.width})`);
  });

  test(`${id}: /favicon.ico and /apple-touch-icon.png are the brand files of the theme`, () => {
    const theme = siteConfig(id).theme;
    for (const [name, brand] of [
      ['favicon.ico', 'favicon.ico'],
      ['apple-touch-icon.png', 'apple-touch-icon.png'],
    ]) {
      const served = join(dist, id, name);
      assert.ok(existsSync(served), `${id}/${name} is at the root of the output`);
      assert.ok(
        readFileSync(served).equals(readFileSync(join(theme, 'assets', 'brand', brand))),
        `${id}/${name} is byte-identical to the theme's assets/brand/${brand}`,
      );
    }
  });
}

/**
 * @param {string} dir Absolute directory.
 * @returns {string[]} Every Markdown file below it, absolute.
 */
function markdownFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** @param {{ source: string }} post @returns {string} */
const sourceOf = (post) => readFileSync(join(root, post.source), 'utf8');

for (const id of ['ba3a.dev', 'my.ba3a.dev']) {
  const siteDir = join(dist, id);

  test(`${id}: the blog sets index: full and no post sets its own index`, () => {
    const site = siteConfig(id);
    for (const blog of site.blogs) assert.deepEqual(blog.index, { type: 'full', pageSize: null }, `blog ${blog.id}`);
    for (const blog of site.blogs) {
      for (const file of markdownFiles(blog.dir)) {
        const front = /^---\r?\n([^]*?)\r?\n---/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
        assert.doesNotMatch(front, /^index\s*:/m, `${relative(root, file)} sets no index`);
      }
    }
    const manifest = readManifest(siteDir);
    assert.ok(manifest.posts.length > 0, 'the site has published posts');
    for (const post of manifest.posts) assert.equal(post.index, 'full', `${post.url} is shown in full`);
  });

  test(`${id}: the blog index, every tag page and every series page show the whole body of every post they list`, () => {
    const manifest = readManifest(siteDir);
    const pages = listPages(manifest, siteConfig(id).blogs);
    assert.ok(pages.some((page) => page.type === 'blog-index'), 'the blog index is checked');
    assert.ok(pages.some((page) => page.type === 'tag'), 'tag pages are checked');
    for (const page of pages) assertFullPosts(page.url, readPage(siteDir, page.file), page.posts, sourceOf);
  });

  test(`${id}: the search index keeps one hit per post: the post pages are indexed, the list pages are not`, () => {
    const manifest = readManifest(siteDir);
    for (const post of manifest.posts) {
      const html = readPage(siteDir, post.file);
      assert.equal((html.match(/data-pagefind-body/g) ?? []).length, 1, `${post.url} is indexed once`);
    }
    for (const page of manifest.pages.filter((candidate) => ['blog-index', 'tag', 'series', 'tag-index', 'search', 'not-found'].includes(candidate.type))) {
      assert.doesNotMatch(readPage(siteDir, page.file), /data-pagefind-body/, `${page.url} is not indexed`);
    }
  });

  test(`${id}: the post pages keep their own table of contents, and their heading ids reach the list page behind the slug`, () => {
    const manifest = readManifest(siteDir);
    const list = readPage(siteDir, listPages(manifest, siteConfig(id).blogs)[0].file);
    for (const post of manifest.posts) {
      const html = readPage(siteDir, post.file);
      const { headings } = readPostSource(sourceOf(post));
      if (headings.filter((heading) => heading.level === 2).length >= 3) {
        assert.match(html, /class="toc"/, `${post.url} has a table of contents`);
      }
      // A heading of the body keeps its id on the list page, behind the slug of its post.
      for (const match of html.matchAll(/<h[2-6] id="([^"]+)">/g)) {
        assert.ok(list.includes(`id="${post.slug}-${match[1]}"`), `${post.url}: #${match[1]} is #${post.slug}-${match[1]} on the list page`);
      }
    }
  });

  test(`${id}: the 404, search and tag-tree pages show no post`, () => {
    const manifest = readManifest(siteDir);
    for (const page of manifest.pages.filter((candidate) => ['tag-index', 'search', 'not-found'].includes(candidate.type))) {
      const main = mainOf(readPage(siteDir, page.file));
      assert.doesNotMatch(main, /post-body|post-list|post-item/, `${page.url} lists no post`);
      for (const post of manifest.posts) assert.ok(!main.includes(readPostSource(sourceOf(post)).sentence), `${page.url} has no text of ${post.slug}`);
    }
  });
}

test('ba3a.dev: the home page keeps the compact list of the latest posts, titles and dates only', () => {
  const siteDir = join(dist, 'ba3a.dev');
  const manifest = readManifest(siteDir);
  const html = readPage(siteDir, 'index.html');
  const section = /<section class="latest-posts">([\s\S]*?)<\/section>/.exec(html)?.[1];
  assert.ok(section, 'the home page has a latest posts section');
  const items = section.match(/<li class="post-item">/g) ?? [];
  const links = [...section.matchAll(/<h3><a href="([^"]+)">[^<]+<\/a><\/h3>/g)].map((match) => match[1]);
  assert.ok(items.length >= 1 && items.length <= manifest.posts.length, 'the newest posts are listed');
  assert.equal(links.length, items.length, 'every item has a title that links to a post');
  for (const url of links) assert.ok(manifest.posts.some((post) => post.url === url), `${url} is a post`);
  assert.equal((section.match(/<time datetime="[^"]+">[^<]+<\/time>/g) ?? []).length, items.length, 'every item has its date');
  for (const post of manifest.posts) assert.ok(!html.includes(readPostSource(sourceOf(post)).sentence), `${post.url}: no text of the body`);
  assert.doesNotMatch(html, /class="post-body"/);
  assert.doesNotMatch(section, /post-tags|post-summary|reading-time/, 'no tags, summary or reading time');
});
