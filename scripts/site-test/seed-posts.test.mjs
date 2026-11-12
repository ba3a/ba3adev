// Assertions about the seed posts of both blogs and their location policies.
//
// The posts are drafts, so the production build must leave them out (checked against the
// output of `npm run test:sites`, `.cache/test-dist`) and a preview build (`--drafts`) must show
// them. This file builds that preview into `.cache/test-dist-drafts`, restoring the seed photos
// from the lock file first when a clean checkout lacks them, and checks the pages, the series,
// the tags and, above all, that no published image carries a position or a camera.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import exifr from 'exifr';
import { createPolicyResolver, loadConfig, loadTagMeta } from 'coffer';

import { SEED_PHOTOS, restoreSeedPhotos } from '../make-placeholders.mjs';
import { assertFullPosts, listPages, mainOf, readPostSource } from './lib/full-posts.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const production = join(root, '.cache', 'test-dist');
const preview = join(root, '.cache', 'test-dist-drafts');
const config = loadConfig({ configPath: join(root, 'coffer.yaml') });

const devlog = join(root, 'content', 'ba3a.dev', 'devlog');
const blog = join(root, 'content', 'my.ba3a.dev');

/**
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
function source(dir, name) {
  return readFileSync(join(dir, ...name.split('/')), 'utf8');
}

/**
 * @param {string} text
 * @returns {{ data: Record<string, unknown>, body: string }} The front matter, read loosely, and the text below it.
 */
function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, 'the post starts with front matter');
  /** @type {Record<string, unknown>} */
  const data = {};
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (pair) data[pair[1]] = pair[2].replace(/^"(.*)"$/, '$1');
  }
  return { data, body: match[2] };
}

/** @param {string} dir @returns {string[]} Every file below the folder, as a path relative to it, with `/`. */
function filesBelow(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(path).map((file) => `${entry.name}/${file}`));
    else found.push(entry.name);
  }
  return found;
}

const POSTS = [
  { dir: devlog, slug: 'first', lang: 'en' },
  { dir: devlog, slug: 'second', lang: 'en' },
  { dir: blog, slug: 'pervyj', lang: 'ru' },
  { dir: blog, slug: 'vtoroj', lang: 'ru' },
];

describe('the seed posts as sources', () => {
  for (const { dir, slug } of POSTS) {
    test(`${slug}: a draft, marked to be rewritten, with a series, a carousel, a captioned image and a hierarchical or project tag`, () => {
      const { data, body } = frontMatter(source(dir, `${slug}/index.md`));
      assert.equal(data.draft, 'true');
      assert.ok(body.includes('<!-- TODO: rewrite -->'), 'carries the visible TODO marker');
      assert.ok(typeof data.series === 'string' && data.series.length > 0, 'belongs to a series');
      assert.match(body, /^## .+$/m, 'has a heading');
      assert.match(body, /^:::carousel\[.+\]$/m, 'has a named carousel');
      const carousel = /^:::carousel[\s\S]*?^:::$/m.exec(body)?.[0] ?? '';
      assert.equal((carousel.match(/^!\[.+\]\(.+\.jpg "[^"]+"\)$/gm) ?? []).length, 3, 'the carousel has three captioned slides');
      const outside = body.replace(carousel, '');
      assert.match(outside, /^!\[.+\]\([^)\s]+\.jpg "[^"]+"\)$/m, 'has a captioned image outside the carousel');
    });
  }

  test('each blog has one series of exactly two parts, named in series.yaml', () => {
    for (const [dir, slugs, series] of /** @type {const} */ ([
      [devlog, ['first', 'second'], 'devlog-start'],
      [blog, ['pervyj', 'vtoroj'], 'pervye-shkatulki'],
    ])) {
      for (const slug of slugs) assert.equal(frontMatter(source(dir, `${slug}/index.md`)).data.series, series);
      assert.match(source(dir, 'series.yaml'), new RegExp(`^${series}:\\n  name: .+$`, 'm'));
    }
  });

  test('the devlog parts carry a hierarchical tag, the project tag of specloop and a highlighted Kotlin block', () => {
    const project = readFileSync(join(root, 'content', 'ba3a.dev', 'projects', 'specloop', 'project.yaml'), 'utf8');
    assert.match(project, /^tag: specloop$/m);
    for (const slug of ['first', 'second']) {
      const { data, body } = frontMatter(source(devlog, `${slug}/index.md`));
      assert.equal(data.tags, '[tools/claude-code, specloop]');
      assert.match(body, /^```kotlin$/m, `${slug} has a Kotlin block`);
    }
  });

  test('the woodworking posts carry the hierarchical tag woodworking/boxes and a Russian title', () => {
    for (const slug of ['pervyj', 'vtoroj']) {
      const { data } = frontMatter(source(blog, `${slug}/index.md`));
      assert.equal(data.tags, '[woodworking/boxes]');
      assert.match(String(data.title), /[А-Яа-я]/);
    }
    assert.match(String(frontMatter(source(blog, 'pervyj/index.md')).data.title), /^Первый/);
    assert.match(String(frontMatter(source(blog, 'vtoroj/index.md')).data.title), /^Второй/);
  });

  test('the sources are UTF-8 without a byte order mark and use LF line ends', () => {
    for (const { dir, slug } of POSTS) {
      const bytes = readFileSync(join(dir, slug, 'index.md'));
      assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${slug}: no BOM`);
      assert.ok(!bytes.includes(13), `${slug}: no carriage return`);
    }
  });

  test('every image a seed post names is a seed photo of its folder, and every seed photo is used', () => {
    const named = new Set();
    for (const { dir, slug } of POSTS) {
      const { body } = frontMatter(source(dir, `${slug}/index.md`));
      for (const match of body.matchAll(/\]\(([^)\s]+\.jpg)[ )]/g)) named.add(relative(root, join(dir, slug, match[1])).split('\\').join('/'));
    }
    assert.deepEqual([...named].sort(), SEED_PHOTOS.map((photo) => photo.path).sort());
  });
});

describe('the tag policies of my.ba3a.dev', () => {
  const { meta, file } = loadTagMeta(blog);
  const site = config.sites.find((candidate) => candidate.id === 'my.ba3a.dev');
  assert.ok(site);
  const resolve = createPolicyResolver({ site: site.location, tags: meta, tagsFile: 'tags.yaml' });
  /** @param {string[]} tags */
  const policyOf = (tags) => resolve({ file: 'x.md', tags, location: null, camera: null, images: new Map() });

  test('tags.yaml sets hiking to keep for its subtree, with Russian display names', () => {
    assert.ok(file, 'tags.yaml exists');
    assert.equal(meta.get('hiking')?.location, 'keep');
    assert.equal(meta.get('hiking')?.camera, null);
    for (const tag of ['woodworking', 'woodworking/boxes', 'hiking']) {
      assert.match(meta.get(tag)?.name ?? '', /[А-Яа-я]/, `${tag} has a Russian name`);
    }
  });

  test('hiking and everything below it keeps the location; woodworking and the site default strip it', () => {
    assert.equal(policyOf(['hiking']).location.value, 'keep');
    assert.equal(policyOf(['hiking/alps/day-2']).location.value, 'keep');
    assert.equal(policyOf(['hiking']).camera.value, 'strip');
    assert.equal(policyOf(['woodworking/boxes']).location.value, 'strip');
    assert.equal(policyOf(['woodworking/boxes']).location.source.level, 'site');
  });

  test('ba3a.dev has no tag policy and keeps the site default strip', () => {
    assert.equal(existsSync(join(devlog, 'tags.yaml')), false);
    const ba3a = config.sites.find((candidate) => candidate.id === 'ba3a.dev');
    assert.ok(ba3a);
    assert.deepEqual({ location: ba3a.location.default, camera: ba3a.location.camera }, { location: 'strip', camera: 'strip' });
  });
});

describe('the production build', () => {
  test('leaves the drafts out: no page, no feed entry, no sitemap entry, and the blogs are empty', () => {
    // The blogs also hold the author's published posts; only the seed drafts must be absent.
    for (const [site, prefix, slugs, series] of /** @type {const} */ ([
      ['ba3a.dev', 'devlog/', ['first', 'second'], 'devlog-start'],
      ['my.ba3a.dev', '', ['pervyj', 'vtoroj'], 'pervye-shkatulki'],
    ])) {
      const manifest = JSON.parse(readFileSync(join(production, site, '.coffer-manifest.json'), 'utf8'));
      assert.deepEqual(
        manifest.posts.filter((/** @type {any} */ post) => slugs.includes(post.slug)),
        [],
        `${site}: no seed posts`,
      );
      assert.deepEqual(
        manifest.series.filter((/** @type {any} */ entry) => entry.slug === series),
        [],
        `${site}: no seed series`,
      );
      const sitemap = readFileSync(join(production, site, 'sitemap.xml'), 'utf8');
      for (const slug of slugs) {
        assert.equal(existsSync(join(production, site, ...prefix.split('/'), slug, 'index.html')), false, `${site}: ${slug} has no page`);
        assert.ok(!sitemap.includes(`/${prefix}${slug}/`), `${site}: ${slug} is not in the sitemap`);
      }
      const feed = readFileSync(join(production, site, prefix === '' ? 'feed.xml' : `${prefix}feed.xml`), 'utf8');
      for (const slug of slugs) assert.ok(!feed.includes(`/${prefix}${slug}/`), `${site}: ${slug} is not in the feed`);
      assert.equal(manifest.drafts, false);
    }
  });

  test('publishes no seed photo, and its text carries no TODO comment', () => {
    for (const site of ['ba3a.dev', 'my.ba3a.dev']) {
      const manifest = JSON.parse(readFileSync(join(production, site, '.coffer-manifest.json'), 'utf8'));
      for (const image of manifest.images) assert.doesNotMatch(image.source, /devlog\/(first|second)\/|pervyj|vtoroj/, `${site}: ${image.source}`);
    }
  });
});

describe('the preview build (--drafts)', () => {
  before(async () => {
    rmSync(preview, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    // A clean checkout has the lock file but not the originals, which live in the media store.
    // The photos are deterministic placeholders, so they are made again, as the lock says.
    await restoreSeedPhotos({ root });
    const run = spawnSync(
      process.execPath,
      [join(root, 'node_modules', 'coffer', 'bin', 'coffer.js'), 'build', '--drafts', '--config', join(root, 'coffer.yaml'), '--out', preview],
      { cwd: root, encoding: 'utf8', timeout: 540_000 },
    );
    assert.equal(run.status, 0, `coffer build --drafts failed:\n${run.stdout}\n${run.stderr}`);
  });

  after(() => rmSync(preview, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  /** @param {string} site @param {string} file */
  const page = (site, file) => readFileSync(join(preview, site, ...file.split('/')), 'utf8');

  /** @param {string} site @returns {any} */
  const manifestOf = (site) => JSON.parse(page(site, '.coffer-manifest.json'));

  test('both blogs list their two drafts, as unpublished, in a series of two', () => {
    for (const [site, slugs] of /** @type {const} */ ([
      ['ba3a.dev', ['first', 'second']],
      ['my.ba3a.dev', ['pervyj', 'vtoroj']],
    ])) {
      const manifest = manifestOf(site);
      assert.equal(manifest.drafts, true);
      const seeds = manifest.posts.filter((/** @type {any} */ post) => slugs.includes(post.slug));
      assert.deepEqual(seeds.map((/** @type {any} */ post) => post.slug).sort(), [...slugs].sort());
      for (const post of seeds) {
        assert.equal(post.draft, true);
        assert.equal(post.published, false);
        assert.equal(post.series.count, 2);
      }
      assert.deepEqual(seeds.map((/** @type {any} */ post) => post.series.number).sort(), [1, 2]);
      assert.equal(manifest.series.filter((/** @type {any} */ entry) => entry.slug === seeds[0].series.slug).length, 1);
    }
  });

  test('every seed post page has the draft banner, a carousel of three slides, captions, a series block and no TODO comment', () => {
    for (const { slug, lang } of POSTS) {
      const site = lang === 'en' ? 'ba3a.dev' : 'my.ba3a.dev';
      const html = page(site, `${lang === 'en' ? 'devlog/' : ''}${slug}/index.html`);
      assert.match(html, new RegExp(`<html lang="${lang}">`));
      assert.match(html, /class="preview-note preview-banner preview-banner-draft"/, `${slug}: draft banner`);
      assert.equal((html.match(/<li class="carousel-slide">/g) ?? []).length, 3, `${slug}: three slides`);
      assert.equal((html.match(/<figcaption>/g) ?? []).length, 4, `${slug}: four captions (three slides and one image)`);
      assert.equal((html.match(/class="series-nav series-nav-(top|bottom)"/g) ?? []).length, 2, `${slug}: series block at the top and the end`);
      assert.match(html, lang === 'en' ? /Part [12] of 2/ : /Часть [12] из 2/, `${slug}: part n of m`);
      assert.doesNotMatch(html, /TODO/, `${slug}: the TODO comment is not published`);
      assert.match(html, /<h2 id="[^"]+">/, `${slug}: headings with ids`);
      // Every image has alt text and a size, so nothing jumps while it loads.
      for (const tag of html.match(/<img\b[^>]*>/g) ?? []) {
        assert.match(tag, /\balt="[^"]+"/, `${slug}: ${tag}`);
        assert.match(tag, /\bwidth="\d+"/);
        assert.match(tag, /\bheight="\d+"/);
      }
    }
  });

  test('the devlog parts show highlighted Kotlin code in both colour themes and the table of contents', () => {
    for (const slug of ['first', 'second']) {
      const html = page('ba3a.dev', `devlog/${slug}/index.html`);
      assert.match(html, /<pre class="shiki shiki-themes github-light github-dark"/);
      assert.match(html, /--shiki-light:#[0-9A-Fa-f]{6};--shiki-dark:#[0-9A-Fa-f]{6}/);
      assert.match(html, /fun<\/span>/, `${slug}: Kotlin keywords are highlighted`);
    }
    assert.match(page('ba3a.dev', 'devlog/first/index.html'), /class="toc"/, 'the first part is long enough for a table of contents');
  });

  test('the devlog parts show the specloop project block and a hierarchical tag with its own pages', () => {
    for (const slug of ['first', 'second']) {
      const html = page('ba3a.dev', `devlog/${slug}/index.html`);
      assert.match(html, /class="project-block"/, `${slug}: project block`);
      assert.match(html, /class="project-block-title"><a href="\/made\/specloop\/">specloop/);
      assert.match(html, /class="project-badge"/, `${slug}: badge near the title`);
      assert.match(html, /href="\/devlog\/tags\/tools\/claude-code\/"/);
    }
    for (const path of ['tools', 'tools/claude-code', 'specloop']) {
      const tag = page('ba3a.dev', `devlog/tags/${path}/index.html`);
      assert.match(tag, /href="\/devlog\/first\/"/, `tag ${path} lists the first part`);
      assert.match(tag, /href="\/devlog\/second\/"/, `tag ${path} lists the second part`);
    }
  });

  test('the woodworking posts use the Russian display names of their tags, in the tag tree and on the subtree pages', () => {
    const first = page('my.ba3a.dev', 'pervyj/index.html');
    assert.match(first, /href="\/tags\/woodworking\/boxes\/"[^>]*>[^<]*Шкатулки/);
    for (const path of ['woodworking', 'woodworking/boxes']) {
      const tag = page('my.ba3a.dev', `tags/${path}/index.html`);
      assert.match(tag, /href="\/pervyj\/"/);
      assert.match(tag, /href="\/vtoroj\/"/);
    }
    const tree = page('my.ba3a.dev', 'tags/index.html');
    assert.match(tree, /Столярное дело/);
    assert.doesNotMatch(tree, /Походы/, 'a tag without a post is not in the tree');
    assert.match(page('my.ba3a.dev', 'series/pervye-shkatulki/index.html'), /Первые шкатулки/);
  });

  test('the blog index, every tag page and every series page show the whole body of every post, seed drafts included', () => {
    for (const site of config.sites) {
      const manifest = manifestOf(site.id);
      const pages = listPages(manifest, site.blogs);
      const types = new Set(pages.map((candidate) => candidate.type));
      assert.deepEqual([...types].sort(), ['blog-index', 'series', 'tag'], `${site.id}: index, tag and series pages are checked`);
      const slugs = (site.id === 'ba3a.dev' ? ['first', 'second'] : ['pervyj', 'vtoroj']).sort();
      const index = pages.find((candidate) => candidate.type === 'blog-index');
      assert.ok(index);
      assert.deepEqual(index.posts.map((post) => post.slug).filter((slug) => slugs.includes(slug)).sort(), slugs, `${site.id}: the index lists the seed posts`);
      for (const candidate of pages) {
        assertFullPosts(`${site.id}${candidate.url}`, page(site.id, candidate.file), candidate.posts, (post) => readFileSync(join(root, post.source), 'utf8'));
      }
    }
  });

  test('on a list page the seed carousels, captions and code blocks of each post stay whole, with no table of contents', () => {
    for (const { site, file, slugs } of [
      { site: 'ba3a.dev', file: 'devlog/series/devlog-start/index.html', slugs: ['first', 'second'] },
      { site: 'my.ba3a.dev', file: 'series/pervye-shkatulki/index.html', slugs: ['pervyj', 'vtoroj'] },
    ]) {
      const html = page(site, file);
      assert.equal((html.match(/<li class="carousel-slide">/g) ?? []).length, 3 * slugs.length, `${file}: three slides per post`);
      assert.equal((html.match(/<figcaption>/g) ?? []).length, 4 * slugs.length, `${file}: four captions per post`);
      if (site === 'ba3a.dev') assert.equal((html.match(/<pre class="shiki /g) ?? []).length, slugs.length, `${file}: a code block per post`);
      for (const slug of slugs) {
        assert.ok(html.includes(`<a href="${site === 'ba3a.dev' ? '/devlog' : ''}/${slug}/">`), `${file}: links to ${slug}`);
      }
      assert.doesNotMatch(mainOf(html), /class="toc"/, `${file}: the table of contents stays on the post page`);
    }
  });

  test('no published image carries a position or a camera: the strip policy is exercised on every seed photo', async () => {
    let checked = 0;
    for (const site of ['ba3a.dev', 'my.ba3a.dev']) {
      const manifest = manifestOf(site);
      const seeded = manifest.images.filter((/** @type {any} */ image) => SEED_PHOTOS.some((photo) => photo.path === image.source));
      assert.equal(seeded.length, 8, `${site}: eight seed photos are published`);
      for (const image of seeded) {
        assert.equal(image.policy.location.value, 'strip');
        assert.equal(image.policy.camera.value, 'strip');
        assert.equal(image.gps, null);
        assert.equal(image.camera, null);
      }
    }
    // Read every published picture of the posts back, whatever the manifest says.
    for (const [site, folder] of [
      ['ba3a.dev', 'img'],
      ['my.ba3a.dev', 'img'],
    ]) {
      const base = join(preview, site, folder);
      for (const file of filesBelow(base)) {
        if (!/\.(jpe?g|webp)$/i.test(file)) continue;
        const bytes = readFileSync(join(base, ...file.split('/')));
        assert.ok(statSync(join(base, ...file.split('/'))).size > 0);
        const tags = await exifr.parse(bytes, { gps: true, tiff: true, ifd0: true, exif: true, xmp: true, iptc: true }).catch(() => undefined);
        assert.equal(tags?.latitude, undefined, `${site}/${folder}/${file} has no latitude`);
        assert.equal(tags?.longitude, undefined, `${site}/${folder}/${file} has no longitude`);
        assert.equal(tags?.Make, undefined, `${site}/${folder}/${file} has no camera make`);
        assert.equal(tags?.Model, undefined, `${site}/${folder}/${file} has no camera model`);
        checked += 1;
      }
    }
    assert.ok(checked >= 16 * 2, `${checked} published pictures were read back`);
    // The originals do carry a position, so the test above means something.
    const original = join(root, ...SEED_PHOTOS[0].path.split('/'));
    assert.equal(typeof (await exifr.gps(readFileSync(original))).latitude, 'number');
  });

  test('the preview build passes coffer check, and the build report lists no post publishing an exact location', () => {
    const run = spawnSync(process.execPath, [join(root, 'node_modules', 'coffer', 'bin', 'coffer.js'), 'check', '--config', join(root, 'coffer.yaml'), '--out', preview], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `coffer check failed:\n${run.stdout}\n${run.stderr}`);
    for (const site of ['ba3a.dev', 'my.ba3a.dev']) assert.deepEqual(manifestOf(site).images.filter((/** @type {any} */ image) => image.gps !== null), []);
  });

  // Lighthouse is not installed here (see the notes of the step), so these are the checks of its
  // accessibility and performance audits that a static look at the output can answer. They do not
  // replace a measured score. Colour contrast of the themes is checked by the theme tests.
  describe('static accessibility and weight checks on the seed posts', () => {
    const pages = [
      { site: 'ba3a.dev', file: 'devlog/first/index.html' },
      { site: 'ba3a.dev', file: 'devlog/second/index.html' },
      { site: 'my.ba3a.dev', file: 'pervyj/index.html' },
      { site: 'my.ba3a.dev', file: 'vtoroj/index.html' },
    ];

    test('one h1, no skipped heading level, one main landmark that the skip link reaches, and a button or link name everywhere', () => {
      for (const { site, file } of pages) {
        const html = page(site, file);
        const levels = [...html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
        assert.equal(levels.filter((level) => level === 1).length, 1, `${file}: one h1`);
        levels.forEach((level, index) => {
          if (index > 0) assert.ok(level <= levels[index - 1] + 1, `${file}: h${level} follows h${levels[index - 1]}`);
        });
        assert.equal((html.match(/<main\b/g) ?? []).length, 1, `${file}: one main`);
        assert.match(html, /<a class="skip-link" href="#main">/);
        assert.match(html, /<main id="main"/);
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
        assert.match(html, /<title>[^<]+<\/title>/);
        assert.deepEqual(html.match(/<a\b[^>]*>\s*<\/a>/g) ?? [], [], `${file}: no empty link`);
        assert.deepEqual(html.match(/<button\b[^>]*>\s*<\/button>/g) ?? [], [], `${file}: no empty button`);
        for (const nav of html.match(/<nav\b[^>]*>/g) ?? []) assert.match(nav, /aria-label="[^"]+"/, `${file}: every nav is named`);
      }
    });

    test('only the first image loads at once, and the rest are lazy, so the largest paint is one small picture', () => {
      for (const { site, file } of pages) {
        const html = page(site, file);
        const images = html.match(/<img\b[^>]*>/g) ?? [];
        assert.equal(images.length, 4, `${file}: four images`);
        assert.doesNotMatch(images[0], /loading=/, `${file}: the first image is eager`);
        for (const image of images.slice(1)) assert.match(image, /loading="lazy"/, `${file}: later images are lazy`);
        const first = /<img src="([^"]+)"/.exec(images[0])?.[1] ?? '';
        const bytes = statSync(join(preview, site, ...first.split('/').filter(Boolean))).size;
        assert.ok(bytes < 60 * 1024, `${file}: the first image is ${bytes} bytes`);
      }
    });

    test('no script blocks rendering except the few lines that set the theme, and the whole page stays light', () => {
      for (const { site, file } of pages) {
        const html = page(site, file);
        const head = html.slice(0, html.indexOf('</head>'));
        const scripts = head.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
        for (const script of scripts) {
          const open = /<script\b[^>]*>/.exec(script)?.[0] ?? '';
          if (/\bsrc=/.test(open)) assert.match(open, /\bdefer\b/, `${file}: external scripts are deferred`);
          else assert.ok(script.length < 2000, `${file}: the inline script in the head is short`);
        }
        for (const script of html.match(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g) ?? []) assert.match(script, /\b(defer|async)\b/, `${file}: ${script}`);
        assert.ok(Buffer.byteLength(html) < 40 * 1024, `${file}: the page is ${Buffer.byteLength(html)} bytes`);
        const styles = (html.match(/<link rel="stylesheet" href="([^"]+)"/g) ?? []).map((tag) => /href="([^"]+)"/.exec(tag)?.[1] ?? '');
        const weight = styles.reduce((sum, href) => sum + statSync(join(preview, site, ...href.split('/').filter(Boolean))).size, 0);
        assert.ok(weight < 64 * 1024, `${file}: the style sheets weigh ${weight} bytes`);
      }
    });

    test('the language and the viewer, carousel and share scripts are in place', () => {
      for (const { site, file } of pages) {
        const html = page(site, file);
        assert.match(html, /<script src="\/assets\/carousel\.js" defer>/);
        assert.match(html, /<script src="\/assets\/viewer\.js" defer>/);
      }
    });
  });
});
