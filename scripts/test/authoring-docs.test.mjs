// Tests for AUTHORING.md and README.md: the facts they state are checked against the repository, so the
// documents cannot drift from it. Every `npm run` script they mention exists, every relative link and
// anchor leads somewhere, every environment variable is in .env.local.example, the required topics have
// a heading, every front matter example is accepted by the engine, the documented new-post commands
// work in a throwaway copy of the configuration, and the statements about the media patterns,
// analytics and licenses match coffer.yaml, package.json and the license files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { loadConfig } from '../../node_modules/coffer/src/config.js';
import { discoverPosts, parsePostSource } from '../../node_modules/coffer/src/content/posts.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (/** @type {string} */ name) => readFileSync(join(root, name), 'utf8');

const authoring = read('AUTHORING.md');
const readme = read('README.md');
const packageJson = JSON.parse(read('package.json'));
const envExample = read('.env.local.example');
const documents = [
  { name: 'AUTHORING.md', text: authoring },
  { name: 'README.md', text: readme },
];

/**
 * @param {string} text
 * @returns {{ lang: string, body: string }[]} The fenced code blocks of a Markdown text.
 */
function fences(text) {
  /** @type {{ lang: string, body: string }[]} */
  const found = [];
  const re = /^( *)```([\w-]*)[^\n]*\n([\s\S]*?)^ *```[ \t]*$/gm;
  for (const match of text.matchAll(re)) {
    const indent = match[1].length;
    const body = match[3]
      .split('\n')
      .map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)))
      .join('\n');
    found.push({ lang: match[2], body });
  }
  return found;
}

/** @param {string} text @returns {string} The text without its fenced code blocks. */
function withoutFences(text) {
  return text.replace(/^ *```[\s\S]*?^ *```[ \t]*$/gm, '');
}

/** @param {string} heading @returns {string} The anchor GitHub makes from a heading. */
function slugify(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** @param {string} text @returns {string[]} The anchors of the headings of a Markdown text. */
function anchorsOf(text) {
  /** @type {string[]} */
  const anchors = [];
  const counts = new Map();
  for (const match of withoutFences(text).matchAll(/^#{1,6} +(.+?) *#*$/gm)) {
    const base = slugify(match[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.push(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

test('every npm script the documents mention exists in package.json', () => {
  const mentioned = [];
  for (const { name, text } of documents) {
    for (const match of text.matchAll(/\bnpm run ([\w:-]+)/g)) mentioned.push({ name, script: match[1] });
  }
  assert.ok(mentioned.length >= 6, 'the documents are expected to mention several scripts');
  for (const { name, script } of mentioned) {
    assert.ok(script in packageJson.scripts, `${name} mentions "npm run ${script}", which package.json does not define`);
  }
  assert.ok(mentioned.some((entry) => entry.script === 'new'));
  assert.ok(mentioned.some((entry) => entry.script === 'dev'));
});

test('every relative link of the documents leads to a file and, for Markdown, to a heading', () => {
  let checked = 0;
  for (const { name, text } of documents) {
    for (const match of withoutFences(text).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [path, anchor] = target.split('#');
      const file = path === '' ? join(root, name) : resolve(root, dirname(name), path);
      assert.ok(existsSync(file), `${name}: the link "${target}" leads to ${relative(root, file)}, which does not exist`);
      if (anchor !== undefined && statSync(file).isFile() && file.endsWith('.md')) {
        assert.ok(
          anchorsOf(readFileSync(file, 'utf8')).includes(anchor),
          `${name}: the link "${target}" leads to a heading that ${relative(root, file)} does not have`,
        );
      }
      checked += 1;
    }
  }
  assert.ok(checked >= 5, `only ${checked} links were checked`);
});

test('every repository path the documents name in code exists', () => {
  const roots = /^(scripts|deploy|content|themes|generators|build-support)\//;
  const rootFiles = ['coffer.yaml', 'media.lock.json', '.env.local.example', '.nvmrc', 'package.json', 'AUTHORING.md'];
  let checked = 0;
  for (const { name, text } of documents) {
    for (const match of text.matchAll(/`([^`\s]+)`/g)) {
      const token = match[1].replace(/\/$/, '');
      if (token.includes('{') || token.includes('*') || token.includes('<')) continue;
      if (roots.test(token) || rootFiles.includes(token)) {
        assert.ok(existsSync(join(root, token)), `${name} names \`${token}\`, which does not exist`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 15, `only ${checked} paths were checked`);
});

test('every credential variable the documents name is in .env.local.example, and the three setup values are named', () => {
  for (const { name, text } of documents) {
    for (const variable of new Set(text.match(/\b(?:CLOUDFLARE|R2)_[A-Z0-9_]+\b/g) ?? [])) {
      assert.match(envExample, new RegExp(`^${variable}=`, 'm'), `${name} names ${variable}, which .env.local.example lacks`);
    }
  }
  for (const variable of ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    assert.ok(authoring.includes(variable), `AUTHORING.md must name ${variable}`);
  }
  const config = read('coffer.yaml');
  for (const variable of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) assert.ok(config.includes(variable));
});

test('AUTHORING.md states the real Node version, the one setup step and the prerequisites of npm test', () => {
  const nvmrc = read('.nvmrc').trim();
  assert.match(authoring, new RegExp(`Node ${nvmrc}\\b`));
  assert.match(packageJson.engines.node, new RegExp(`>=${nvmrc}`));
  assert.match(authoring, /one setup step/);
  assert.match(authoring, /npm install/);
  assert.match(authoring, /\.env\.local\.example/);
  assert.match(authoring, /scripts\/prepare\.mjs/);
  assert.match(authoring, /JDK 21/);
  assert.match(authoring, /network/);
  assert.match(authoring, /\bCI\b/);
  assert.match(read('.github/workflows/deploy.yml'), /java-version: "21"/);
});

const REQUIRED_HEADINGS = [
  /^Set up a new computer$/,
  /^Preview$/,
  /^A new post$/,
  /^Front matter$/,
  /^Images$/,
  /^Carousels$/,
  /^Maps and GPX$/,
  /^Location policy$/,
  /^Tags$/,
  /^Series$/,
  /^Project tags and project blocks$/,
  /^Drafts and scheduling$/,
  /^Old slugs$/,
  /^Writing on the phone$/,
  /^What fails the build$/,
  /^Adding a new tool project$/,
  /^If the scheduled workflow stops$/,
  /^Analytics$/,
];

test('AUTHORING.md has a heading for every required topic and stays short', () => {
  const headings = [...withoutFences(authoring).matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  for (const required of REQUIRED_HEADINGS) {
    assert.ok(headings.some((heading) => required.test(heading)), `AUTHORING.md lacks a heading matching ${required}`);
  }
  assert.ok(authoring.split('\n').length <= 400, 'AUTHORING.md is meant to be short (400 lines at most)');
});

test('README.md says what the repository is and links to AUTHORING.md', () => {
  assert.match(readme, /\(AUTHORING\.md[^)]*\)/);
  assert.match(readme, /ba3a\.dev/);
  assert.match(readme, /my\.ba3a\.dev/);
  for (const entry of ['content/', 'themes/', 'generators/', 'build-support/', 'scripts/', 'deploy/', '.github/workflows/', 'coffer.yaml', 'media.lock.json']) {
    assert.ok(readme.includes(`\`${entry}`), `README.md does not describe ${entry}`);
    assert.ok(existsSync(join(root, entry)), `${entry} does not exist`);
  }
});

test('the license statements match the license files', () => {
  const engine = JSON.parse(read('node_modules/coffer/package.json'));
  assert.equal(engine.license, 'Apache-2.0');
  assert.match(read('node_modules/coffer/LICENSE'), /Apache License\s+Version 2\.0/);
  assert.match(readme, /Apache License 2\.0/);
  assert.match(readme, /all rights reserved/i);
  const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
  for (const site of config.sites) assert.match(String(site.contentLicense), /rights reserved|Все права защищены/i);
  // The README says the repository has no license file of its own; if one is added, the README must change.
  const licenseFiles = readdirSync(root).filter((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  assert.deepEqual(licenseFiles, [], 'README.md says there is no license file in the root; update it');
  assert.match(readme, /no license file/);
});

test('the statements about media originals match coffer.yaml', () => {
  const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
  const include = /** @type {string[]} */ (config.media?.include ?? []);
  assert.ok(include.length > 0);
  for (const pattern of include) {
    assert.ok(
      pattern.startsWith('content/ba3a.dev/devlog/') || pattern.startsWith('content/my.ba3a.dev/'),
      `media.include has ${pattern}, but AUTHORING.md says only the devlog and my.ba3a.dev are covered`,
    );
  }
  assert.ok(!include.some((pattern) => pattern.includes('projects')));
  for (const extension of ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'mp4', 'webm']) {
    assert.ok(authoring.includes(`\`${extension}\``), `AUTHORING.md does not list the original type ${extension}`);
    const caseless = extension.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
    for (const base of ['content/ba3a.dev/devlog/**/*.', 'content/my.ba3a.dev/**/*.']) {
      assert.ok(include.includes(base + caseless), `media.include lacks ${base}${caseless}`);
    }
  }
  assert.match(authoring, /content\/ba3a\.dev\/devlog\//);
  assert.match(authoring, /content\/my\.ba3a\.dev\//);
  assert.match(authoring, /content\/ba3a\.dev\/projects\//);
});

test('analytics are described as not configured, which is what coffer.yaml says', () => {
  const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
  for (const site of config.sites) {
    assert.ok(site.analytics === null || site.analytics === undefined || site.analytics.provider === 'none', `${site.id} has analytics; update AUTHORING.md`);
  }
  assert.match(authoring, /Analytics are not configured/);
  assert.match(read('deploy/_headers'), /static\.cloudflareinsights\.com/);
});

test('the documents do not repeat claims the engine and the workflows contradict', () => {
  // A draft with broken front matter fails the whole build, so drafts are never called safe to commit.
  const draftFails = () => {
    const temp = mkdtempSync(join(tmpdir(), 'authoring-draft-'));
    try {
      mkdirSync(join(temp, 'broken'), { recursive: true });
      writeFileSync(join(temp, 'broken', 'index.md'), '---\ntitle: Broken\ndate: nonsense\ndraft: true\n---\n\nText.\n');
      discoverPosts(temp, { timezone: 'Europe/Samara' });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  };
  assert.throws(draftFails, 'a draft with an invalid date is expected to fail the build');
  for (const { name, text } of documents) {
    assert.doesNotMatch(text, /cannot break the deployment/i, `${name} calls drafts harmless`);
    assert.doesNotMatch(text, /draft is safe to commit/i, `${name} calls drafts safe to commit`);
  }
  const phone = authoring.slice(authoring.indexOf('## Writing on the phone'), authoring.indexOf('## What fails the build'));
  assert.match(phone, /front matter/);
  assert.match(phone, /fails the whole build/);

  // GitHub does not re-enable a workflow because of a commit; the documents say it is enabled by hand.
  const stopped = authoring.slice(authoring.indexOf('## If the scheduled workflow stops'), authoring.indexOf('## Analytics'));
  assert.match(stopped, /Enable workflow/);
  for (const { name, text } of documents) {
    assert.doesNotMatch(text, /or push any commit/i, `${name} says that a commit re-enables a disabled workflow`);
  }
  assert.match(read('scripts/keepalive.mjs'), /Enable workflow/);
});

/** @returns {string[]} The keys of the table of front matter keys in the engine's documentation. */
function documentedFrontMatterKeys() {
  const text = read('node_modules/coffer/docs/posts.md');
  const keys = [...text.matchAll(/^\| `(\w+)` +\|/gm)].map((match) => match[1]);
  assert.ok(keys.includes('title') && keys.includes('aliases'), 'the table of front matter keys in github.com/ba3a/coffer/blob/v0.1.0/docs/posts.md was not found');
  return keys;
}

test('every front matter example parses with the engine and uses only documented keys', () => {
  const known = documentedFrontMatterKeys();
  let examples = 0;
  for (const block of fences(authoring)) {
    if (!block.body.startsWith('---\n')) continue;
    const end = block.body.indexOf('\n---', 4);
    assert.ok(end > 0, `an example does not close its front matter:\n${block.body}`);
    const data = YAML.parse(block.body.slice(4, end));
    for (const key of Object.keys(data)) assert.ok(known.includes(key), `the front matter key "${key}" is not a documented key`);
    // The same reader as the build, with the time zone of the sites.
    const post = parsePostSource({ file: 'example/index.md', text: `${block.body}\n\nText.\n`, slug: 'example', kind: 'folder', dir: 'example' }, { timezone: 'Europe/Samara' });
    assert.ok(post.title.length > 0);
    examples += 1;
  }
  assert.ok(examples >= 6, `only ${examples} front matter examples were checked`);
});

test('AUTHORING.md documents the per-post index override, as the engine and coffer.yaml behave', () => {
  const section = authoring.slice(authoring.indexOf('### Whole posts or summaries'), authoring.indexOf('## Images'));
  assert.ok(section.length > 0, 'AUTHORING.md lacks the section on whole posts and summaries, under "Front matter"');
  // What the section says about the blogs and the home page.
  const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
  const blogs = config.sites.flatMap((site) => site.blogs ?? []);
  assert.equal(blogs.length, 2);
  for (const blog of blogs) assert.equal(JSON.stringify(blog.index).includes('full'), true, `blog ${blog.id} is expected to set index: full`);
  assert.match(section, /Both blogs/);
  assert.match(section, /blog index, the tag pages and the series pages/);
  assert.match(section, /`index: full`[^\n]*`coffer\.yaml`/);
  assert.match(section, /ba3a\.dev home page[^\n]*compact/);
  assert.match(section, /post's value wins/);
  assert.match(section, /Without `summary:`[^\n]*title and meta line only/);
  assert.match(section, /`summary:`[^\n]*link preview[^\n]*page description/);
  assert.match(section, /fails the build/);
  assert.match(section, /path of the post file/);

  // The example is accepted and sets the override; a post without it follows the blog.
  const example = fences(section).find((block) => block.body.startsWith('---\n'));
  assert.ok(example, 'the section needs an example front matter');
  assert.match(example.body, /^index: summary$/m);
  const parse = (/** @type {string} */ front) =>
    parsePostSource({ file: 'example/index.md', text: `${front}\n\nText.\n`, slug: 'example', kind: 'folder', dir: 'example' }, { timezone: 'Europe/Samara' });
  assert.equal(parse(example.body).index, 'summary');
  assert.equal(parse('---\ntitle: T\ndate: 2026-12-01\nindex: full\n---').index, 'full');
  assert.equal(parse('---\ntitle: T\ndate: 2026-12-01\nsummary: S\n---').index, null);

  // An invalid value fails, and the error names the post file and the message the document quotes.
  assert.throws(
    () => parse('---\ntitle: T\ndate: 2026-12-01\nindex: short\n---'),
    (error) => /** @type {Error} */ (error).message.includes('example/index.md') && /\bindex: must be "summary" or "full"/.test(/** @type {Error} */ (error).message),
  );
  assert.ok(section.includes('index: must be "summary" or "full"'));
});

test('every YAML example parses, and project declarations use the keys of the real ones', () => {
  const seedKeys = new Set();
  const projectsDir = join(root, 'content', 'ba3a.dev', 'projects');
  for (const name of readdirSync(projectsDir)) {
    const file = join(projectsDir, name, 'project.yaml');
    if (existsSync(file)) for (const key of Object.keys(YAML.parse(readFileSync(file, 'utf8')))) seedKeys.add(key);
  }
  let projects = 0;
  let yamlBlocks = 0;
  for (const block of fences(authoring)) {
    if (block.lang !== 'yaml') continue;
    const data = YAML.parse(block.body);
    assert.ok(data !== null && typeof data === 'object', `a YAML example is empty:\n${block.body}`);
    yamlBlocks += 1;
    if (block.body.includes('project.yaml')) {
      projects += 1;
      for (const key of Object.keys(data)) assert.ok(seedKeys.has(key), `project.yaml example key "${key}" is not used by any real project`);
      assert.equal(data.kind, 'tool');
      for (const key of ['name', 'pitch', 'kind', 'status', 'card', 'repo']) assert.ok(key in data, `the project example lacks ${key}`);
      assert.ok(data.docs.source.git && data.docs.source.ref, 'the project example must declare a git source with a ref');
    }
  }
  assert.ok(yamlBlocks >= 5);
  assert.equal(projects, 1);
});

test('the documented new-post commands work in a throwaway copy of the configuration', () => {
  const commands = [...authoring.matchAll(/^npm run new -- (\S+) "([^"]+)"$/gm)].map((match) => ({ blog: match[1], title: match[2] }));
  assert.deepEqual(commands.map((command) => command.blog), ['devlog', 'blog']);
  const temp = mkdtempSync(join(tmpdir(), 'authoring-docs-'));
  try {
    writeSkeleton(temp);
    for (const { blog, title } of commands) {
      const result = spawnSync(process.execPath, [join(root, 'node_modules', 'coffer', 'bin', 'coffer.js'), 'new', blog, title, '--config', join(temp, 'coffer.yaml')], { encoding: 'utf8' });
      assert.equal(result.status, 0, `coffer new ${blog} "${title}" failed: ${result.stderr}`);
    }
    const devlog = discoverPosts(join(temp, 'content', 'ba3a.dev', 'devlog'), { timezone: 'Europe/Samara' });
    assert.deepEqual(devlog.map((post) => [post.slug, post.draft]), [['why-i-put-a-loop-around-claude-code', true]]);
    const mine = discoverPosts(join(temp, 'content', 'my.ba3a.dev'), { timezone: 'Europe/Samara' });
    assert.deepEqual(mine.map((post) => [post.slug, post.draft]), [['shkatulka-iz-sosny', true]]);
    // The site name is not a blog id, which is why the document says "blog".
    const wrong = spawnSync(process.execPath, [join(root, 'node_modules', 'coffer', 'bin', 'coffer.js'), 'new', 'my', 'x', '--config', join(temp, 'coffer.yaml')], { encoding: 'utf8' });
    assert.equal(wrong.status, 1);
    // The documented extra form works too.
    const qualified = spawnSync(process.execPath, [join(root, 'node_modules', 'coffer', 'bin', 'coffer.js'), 'new', 'my.ba3a.dev/blog', 'Ещё', '--config', join(temp, 'coffer.yaml')], { encoding: 'utf8' });
    assert.equal(qualified.status, 0, qualified.stderr);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

/**
 * Writes the configuration of this repository and the empty folders it names into a folder.
 *
 * @param {string} dir
 */
function writeSkeleton(dir) {
  for (const sub of ['content/ba3a.dev/devlog', 'content/my.ba3a.dev', 'content/ba3a.dev/projects', 'themes/ba3a', 'themes/my']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  copyFileSync(join(root, 'coffer.yaml'), join(dir, 'coffer.yaml'));
}
