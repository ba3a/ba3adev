// Tests for the media store configuration of this repository: the R2 store in coffer.yaml, the patterns
// that move raster images and videos out of git, the .gitignore that matches them, the example of the
// local settings and the empty lock file. Nothing here reads credentials or contacts a store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../coffer/src/config.js';
import { matchGlob } from '../../coffer/src/docs/glob.js';
import { parseEnvFile } from '../../coffer/src/media/credentials.js';
import { parseLock, renderLock } from '../../coffer/src/media/lock.js';
import { gitignoreText, mediaContext } from '../../coffer/src/media/sync.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
const media = /** @type {NonNullable<typeof config.media>} */ (config.media);
const read = (/** @type {string} */ name) => readFileSync(join(root, name), 'utf8');

/** @param {string} path @returns {boolean} Whether the engine would take the file for an original. */
function isOriginal(path) {
  return media.include.some((glob) => matchGlob(glob, path));
}

/** @param {string} dir @returns {string[]} Every file below the folder, as a path relative to the repository root, with `/`. */
function filesBelow(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(path));
    else found.push(relative(root, path).split('\\').join('/'));
  }
  return found;
}

/** @param {string[]} paths @returns {{ ignored: string[], kept: string[] }} What git would ignore among the paths. */
function gitIgnoreStatus(paths) {
  const ignored = [];
  const kept = [];
  for (const path of paths) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const result = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd: root, env, encoding: 'utf8' });
    assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed for ${path}: ${result.stderr}`);
    (result.status === 0 ? ignored : kept).push(path);
  }
  return { ignored, kept };
}

test('the media store is the private R2 bucket, with credentials named by variable and never written', () => {
  assert.deepEqual(media.store, {
    type: 's3',
    endpoint: 'https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com',
    bucket: 'ba3a-media',
    region: 'auto',
    prefix: '',
    accessKeyIdEnv: 'R2_ACCESS_KEY_ID',
    secretAccessKeyEnv: 'R2_SECRET_ACCESS_KEY',
  });
  assert.equal(media.lock, 'media.lock.json');
  assert.equal(media.includeIsDefault, false);
});

test('the patterns take raster images and videos of the devlog and of my.ba3a.dev, in any letter case', () => {
  for (const base of ['content/ba3a.dev/devlog/first', 'content/ba3a.dev/devlog/first/nested', 'content/my.ba3a.dev/pervyj', 'content/my.ba3a.dev']) {
    for (const extension of ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'mp4', 'webm']) {
      assert.ok(isOriginal(`${base}/photo.${extension}`), `${base}/photo.${extension}`);
      assert.ok(isOriginal(`${base}/PHOTO.${extension.toUpperCase()}`), `${base}/PHOTO.${extension.toUpperCase()}`);
    }
  }
});

test('the patterns leave SVG, fonts, text and other formats in git', () => {
  for (const extension of ['svg', 'woff2', 'md', 'yaml', 'gpx', 'gif', 'avif', 'mov', 'json']) {
    assert.ok(!isOriginal(`content/ba3a.dev/devlog/first/file.${extension}`), `devlog .${extension}`);
    assert.ok(!isOriginal(`content/my.ba3a.dev/pervyj/file.${extension}`), `my .${extension}`);
  }
});

test('no file of the project folders is an original: the PNG and SVG placeholders under content/ba3a.dev/projects/ stay regular git files', () => {
  const files = filesBelow(join(root, 'content', 'ba3a.dev', 'projects'));
  assert.ok(files.some((path) => path.endsWith('.png')), 'there are placeholder PNGs');
  assert.ok(files.some((path) => path.endsWith('.svg')), 'there are placeholder SVGs');
  for (const path of files) assert.ok(!isOriginal(path), `${path} must stay a regular git file`);
  // Even a raster picture added to a project folder later is not moved out of git by accident.
  assert.ok(!isOriginal('content/ba3a.dev/projects/roto/screenshot.jpg'));
  assert.ok(!isOriginal('content/ba3a.dev/projects/faultory/trailer.mp4'));
});

test('no pattern could match the lock file or the configuration', () => {
  assert.ok(!isOriginal('media.lock.json'));
  assert.ok(!isOriginal('coffer.yaml'));
});

test('the root .gitignore holds exactly the patterns "coffer media gitignore" prints', () => {
  const printed = gitignoreText(mediaContext(config));
  assert.ok(read('.gitignore').replace(/\r\n/g, '\n').includes(printed), '.gitignore must contain the output of "coffer media gitignore" as one block');
  assert.match(printed, /^\.env\.local$/m);
});

test('git ignores image originals and the local settings, and keeps the lock file, the example and the project art', () => {
  const { ignored, kept } = gitIgnoreStatus([
    'content/ba3a.dev/devlog/first/photo.jpg',
    'content/ba3a.dev/devlog/first/PHOTO.JPG',
    'content/my.ba3a.dev/pervyj/photo.heic',
    'content/my.ba3a.dev/pervyj/clip.mp4',
    '.env.local',
    '.coffer/media-cache.json',
    '.coffer-hooks/pre-commit',
  ]);
  assert.equal(ignored.length, 7, `kept: ${kept.join(', ')}`);
  const stay = gitIgnoreStatus([
    'media.lock.json',
    '.env.local.example',
    'content/ba3a.dev/projects/roto/card.png',
    'content/ba3a.dev/projects/faultory/logo.svg',
    'content/ba3a.dev/devlog/first/index.md',
  ]);
  assert.deepEqual(stay.ignored, []);
});

test('.env.local.example lists the variables the store reads, with no value', () => {
  const values = parseEnvFile(read('.env.local.example'));
  assert.deepEqual([...values.keys()].sort(), ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
  for (const [name, value] of values) assert.equal(value, '', `${name} must have no value`);
});

test('media.lock.json is a lock the engine could have written, every entry is an original, and .gitattributes keeps its line ends', () => {
  const text = read('media.lock.json');
  const entries = parseLock(text);
  // The file is exactly what the engine renders: sorted, one line per entry, LF, final newline.
  assert.equal(text, renderLock(entries));
  assert.ok(entries.length > 0, 'the seed photos are listed (see scripts/make-placeholders.mjs)');
  for (const entry of entries) {
    assert.ok(isOriginal(entry.path), `${entry.path} matches media.include`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }
  assert.match(read('.gitattributes'), /^media\.lock\.json text eol=lf$/m);
});
