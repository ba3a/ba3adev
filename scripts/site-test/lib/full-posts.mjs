// Reusable assertions about blog list pages that show whole posts (`index: full`).
// They read a build output and the post sources, so they list no post by name: every post
// the manifest says a page lists is checked.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {{ blog: string, slug: string, url: string, file: string, source: string, title: string, index: string }} ManifestPost
 * @typedef {{ url: string, file: string, type: string }} ManifestPage
 * @typedef {{ posts: ManifestPost[], pages: ManifestPage[], tags: { url: string, posts: string[] }[], series: { url: string, posts: string[] }[] }} Manifest
 * @typedef {{ url: string, file: string, type: string, posts: ManifestPost[] }} ListPage
 */

/** @param {string} siteDir @returns {Manifest} */
export function readManifest(siteDir) {
  return JSON.parse(readFileSync(join(siteDir, '.coffer-manifest.json'), 'utf8'));
}

/**
 * @param {string} siteDir Output folder of one site.
 * @param {string} file Path inside it, with forward slashes.
 * @returns {string}
 */
export function readPage(siteDir, file) {
  const path = join(siteDir, ...file.split('/'));
  assert.ok(existsSync(path), `${file} exists in ${siteDir}`);
  return readFileSync(path, 'utf8');
}

/**
 * The pages that list whole posts and the posts each one lists: the index of every blog, every
 * tag page and every series page.
 *
 * @param {Manifest} manifest
 * @param {{ id: string, prefix: string }[]} blogs The blogs of the site.
 * @returns {ListPage[]}
 */
export function listPages(manifest, blogs) {
  /** @type {Map<string, ManifestPost>} */
  const byUrl = new Map(manifest.posts.map((post) => [post.url, post]));
  /** @param {string[]} urls */
  const postsOf = (urls) =>
    urls.map((url) => {
      const post = byUrl.get(url);
      assert.ok(post, `${url} is a post of the manifest`);
      return post;
    });
  /** @type {ListPage[]} */
  const found = [];
  for (const blog of blogs) {
    const url = blog.prefix === '' ? '/' : `/${blog.prefix}/`;
    const page = manifest.pages.find((candidate) => candidate.url === url && candidate.type === 'blog-index');
    assert.ok(page, `the index of blog ${blog.id} (${url}) is a page of the manifest`);
    found.push({ ...page, posts: manifest.posts.filter((post) => post.blog === blog.id) });
  }
  for (const entry of [...manifest.tags, ...manifest.series]) {
    const page = manifest.pages.find((candidate) => candidate.url === entry.url);
    assert.ok(page, `${entry.url} is a page of the manifest`);
    found.push({ ...page, posts: postsOf(entry.posts) });
  }
  return found;
}

/** @param {string} text @returns {string} */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} text @returns {string} The text with the entities the renderer writes decoded. */
function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Characters that start Markdown syntax or that the renderer writes differently; text between them is plain. */
const MARKUP = /[[\]()*_`<>&"'\\|^~]/;

/**
 * What a test needs to find a post in a rendered page.
 *
 * @param {string} markdown The post source, with front matter.
 * @returns {{ sentence: string, headings: { level: number, text: string }[] }} A distinctive piece of
 *   plain prose of the body and the plain headings of the body with their source level.
 */
export function readPostSource(markdown) {
  const body = markdown.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
  let fence = false;
  let sentence = '';
  /** @type {{ level: number, text: string }[]} */
  const headings = [];
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      if (!MARKUP.test(heading[2])) headings.push({ level: heading[1].length, text: heading[2] });
      continue;
    }
    if (/^\s*([-*+>|!:<]|\d+[.)]\s)/.test(line)) continue;
    for (const run of line.split(new RegExp(MARKUP.source))) {
      const text = run.trim();
      if (text.length > sentence.length) sentence = text;
    }
  }
  assert.ok(sentence.length >= 25, `the post has a plain sentence to look for (${sentence})`);
  if (sentence.length > 90) sentence = sentence.slice(0, 90).replace(/\s+\S*$/, '');
  return { sentence, headings };
}

/** @param {string} html @returns {string} The part of the page between <main> and </main>. */
export function mainOf(html) {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  assert.ok(start >= 0 && end > start, 'the page has a main element');
  return html.slice(start, end);
}

/** @param {string} html @returns {string[]} Every id attribute of the page. */
export function idsOf(html) {
  return [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]);
}

/**
 * Assert that a page shows the whole body of each of its posts, in the layout the engine gives
 * `index: full`.
 *
 * @param {string} label
 * @param {string} html The page.
 * @param {ListPage['posts']} posts The posts the page lists.
 * @param {(post: ManifestPost) => string} sourceOf The markdown of a post.
 */
export function assertFullPosts(label, html, posts, sourceOf) {
  assert.ok(posts.length > 0, `${label}: lists at least one post`);
  const main = mainOf(html);
  const start = main.indexOf('<ol class="post-list">');
  assert.ok(start >= 0, `${label}: has a post list`);
  // The part of the page that holds the posts; a tag page puts a list of subtags above it.
  const list = main.slice(start);

  assert.equal((main.match(/<h1[\s>]/g) ?? []).length, 1, `${label}: one h1`);
  assert.equal((list.match(/<h2[\s>]/g) ?? []).length, posts.length, `${label}: one h2 per post and no other`);
  assert.equal((list.match(/<div class="post-body"/g) ?? []).length, posts.length, `${label}: one body per post`);
  const titles = [...list.matchAll(/<h2><a href="([^"]+)">([^<]*)<\/a><\/h2>/g)].map((match) => [match[1], decodeEntities(match[2])]);
  assert.deepEqual(
    titles.sort(),
    posts.map((post) => [post.url, post.title]).sort(),
    `${label}: every title is an h2 link to its post page`,
  );

  for (const post of posts) {
    const { sentence, headings } = readPostSource(sourceOf(post));
    assert.ok(list.includes(sentence), `${label}: the body of ${post.slug} is there ("${sentence}")`);
    for (const { level, text } of headings) {
      if (level === 1) continue;
      const shifted = Math.min(level + 1, 6);
      assert.match(
        list,
        new RegExp(`<h${shifted}(?: [^>]*)?>${escapeRegExp(text)}</h${shifted}>`),
        `${label}: heading "${text}" of ${post.slug} is an h${shifted} (source h${level})`,
      );
    }
  }

  const ids = idsOf(html);
  const seen = new Set();
  /** @type {string[]} */
  const duplicates = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  assert.deepEqual(duplicates, [], `${label}: no id is used twice`);
  for (const match of main.matchAll(/\shref="#([^"]+)"/g)) {
    assert.ok(seen.has(decodeEntities(match[1])), `${label}: the link #${match[1]} has a target on the page`);
  }

  assert.doesNotMatch(main, /class="toc"/, `${label}: no table of contents of a post`);
  assert.doesNotMatch(html, /data-pagefind-body/, `${label}: the page is not indexed by the search`);
}
