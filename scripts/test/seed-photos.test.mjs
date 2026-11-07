// Tests of the seed photos made by scripts/make-placeholders.mjs: they are byte for byte
// reproducible (so the lock file stays truthful and a clean checkout can regenerate them),
// carry a made-up GPS position and camera (so the strip policy is visibly exercised), live
// where the media configuration takes originals, are ignored by git and listed in the lock.
// They need no build, no store and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import exifr from 'exifr';
import sharp from 'sharp';

import { loadConfig } from '../../node_modules/coffer/src/config.js';
import { matchGlob } from '../../node_modules/coffer/src/docs/glob.js';
import { parseLock } from '../../node_modules/coffer/src/media/lock.js';
import {
  PHOTO_SIZE,
  SEED_PHOTOS,
  createSeedPhotos,
  renderSeedPhotos,
  restoreSeedPhotos,
} from '../make-placeholders.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const config = loadConfig({ configPath: join(root, 'coffer.yaml') });
const media = /** @type {NonNullable<typeof config.media>} */ (config.media);

/** @type {Map<string, Buffer>} */
const generated = await renderSeedPhotos();

/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {string} name
 * @returns {Buffer}
 */
function photo(name) {
  const bytes = generated.get(name);
  assert.ok(bytes, `${name} is generated`);
  return bytes;
}

/** @returns {Map<string, { sha256: string, size: number }>} The entries of the committed lock file, by path. */
function lockEntries() {
  const entries = parseLock(readFileSync(join(root, 'media.lock.json'), 'utf8'));
  return new Map(entries.map((entry) => [entry.path, entry]));
}

test('every blog has two seed posts with a carousel of three photos and one captioned photo', () => {
  const folders = new Map();
  for (const seed of SEED_PHOTOS) {
    const folder = dirname(seed.path);
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  assert.deepEqual(
    [...folders.keys()].sort(),
    [
      'content/ba3a.dev/devlog/first',
      'content/ba3a.dev/devlog/second',
      'content/my.ba3a.dev/pervyj',
      'content/my.ba3a.dev/vtoroj',
    ],
  );
  for (const [folder, count] of folders) assert.equal(count, 4, `${folder} has four photos`);
  assert.deepEqual([...generated.keys()].sort(), SEED_PHOTOS.map((seed) => seed.path).sort());
});

test('the photos are where the media configuration takes originals, so they stay out of git', () => {
  for (const seed of SEED_PHOTOS) {
    assert.ok(media.include.some((glob) => matchGlob(glob, seed.path)), `${seed.path} matches media.include`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', seed.path], { cwd: root, env });
    assert.equal(ignored.status, 0, `git ignores ${seed.path}`);
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', seed.path], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(tracked.status, 0, `git does not track ${seed.path}`);
  }
});

test('generating twice gives byte-identical files', async () => {
  const again = await renderSeedPhotos();
  assert.deepEqual([...again.keys()], [...generated.keys()]);
  for (const [name, bytes] of generated) assert.ok(bytes.equals(/** @type {Buffer} */ (again.get(name))), `${name} is identical`);
});

test('the photos are landscape JPEGs of a sensible size, each different from the others', async () => {
  const hashes = new Set();
  for (const [name, bytes] of generated) {
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.format, 'jpeg', name);
    assert.deepEqual({ width: meta.width, height: meta.height }, PHOTO_SIZE, name);
    assert.ok(bytes.length > 5_000 && bytes.length < 250_000, `${name} is ${bytes.length} bytes`);
    hashes.add(sha256(bytes));
  }
  assert.equal(hashes.size, generated.size);
});

test('every photo carries a made-up camera and a GPS position at a clearly synthetic place', async () => {
  for (const [name, bytes] of generated) {
    const tags = await exifr.parse(bytes, { gps: true, tiff: true, ifd0: true, exif: true });
    assert.equal(tags.Make, 'Placeholder Camera Co.', `${name}: make`);
    assert.equal(tags.Model, 'Made-up 1', `${name}: model`);
    assert.equal(typeof tags.latitude, 'number', `${name}: latitude`);
    assert.equal(typeof tags.longitude, 'number', `${name}: longitude`);
    const gps = await exifr.gps(bytes);
    if (name.includes('/ba3a.dev/')) {
      // Point Nemo, the point of the ocean farthest from any land.
      assert.ok(Math.abs(gps.latitude - -48.8767) < 0.05 && Math.abs(gps.longitude - -123.3933) < 0.05, `${name}: ${gps.latitude}`);
    } else {
      // The middle of the North Atlantic, far from any coast.
      assert.ok(Math.abs(gps.latitude - 30) < 0.05 && Math.abs(gps.longitude - -40) < 0.05, `${name}: ${gps.latitude}`);
    }
  }
});

test('the committed lock file lists every seed photo with the hash and size of the generated bytes', () => {
  const entries = lockEntries();
  for (const [name, bytes] of generated) {
    const entry = entries.get(name);
    assert.ok(entry, `${name} is in media.lock.json (run "node scripts/make-placeholders.mjs --photos" and "coffer media lock")`);
    assert.equal(entry.size, bytes.length, `${name}: size`);
    assert.equal(entry.sha256, sha256(bytes), `${name}: sha256`);
  }
});

test('createSeedPhotos writes missing photos and never touches one that exists', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ba3a-seed-photos-'));
  try {
    const first = await createSeedPhotos({ root: directory });
    assert.equal(first.written.length, SEED_PHOTOS.length);
    const sample = SEED_PHOTOS[0].path;
    assert.ok(readFileSync(join(directory, sample)).equals(photo(sample)));

    // A real photograph replaced the placeholder: it is left alone.
    writeFileSync(join(directory, sample), 'a real photograph');
    const second = await createSeedPhotos({ root: directory });
    assert.deepEqual(second.written, []);
    assert.equal(second.present.length, SEED_PHOTOS.length);
    assert.equal(readFileSync(join(directory, sample), 'utf8'), 'a real photograph');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreSeedPhotos regenerates what a clean checkout lacks, from the lock file, and only that', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ba3a-seed-restore-'));
  try {
    const lock = readFileSync(join(root, 'media.lock.json'), 'utf8');
    writeFileSync(join(directory, 'media.lock.json'), lock);
    const restored = await restoreSeedPhotos({ root: directory });
    assert.equal(restored.written.length, SEED_PHOTOS.length);
    for (const seed of SEED_PHOTOS) assert.ok(readFileSync(join(directory, seed.path)).equals(photo(seed.path)));
    // A second run finds everything in place.
    assert.deepEqual((await restoreSeedPhotos({ root: directory })).written, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restoreSeedPhotos skips photos the lock does not list (they were deleted on purpose) and refuses a lock it cannot reproduce', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ba3a-seed-skip-'));
  try {
    writeFileSync(join(directory, 'media.lock.json'), '{"version":1,"files":[\n]}\n');
    const none = await restoreSeedPhotos({ root: directory });
    assert.deepEqual(none.written, []);
    assert.equal(none.skipped.length, SEED_PHOTOS.length);
    assert.equal(existsSync(join(directory, SEED_PHOTOS[0].path)), false);

    const seed = SEED_PHOTOS[0];
    mkdirSync(dirname(join(directory, seed.path)), { recursive: true });
    const wrong = `{"version":1,"files":[\n{"path":"${seed.path}","sha256":"${'0'.repeat(64)}","size":1}\n]}\n`;
    writeFileSync(join(directory, 'media.lock.json'), wrong);
    await assert.rejects(restoreSeedPhotos({ root: directory }), /does not match the lock/);
    assert.equal(existsSync(join(directory, seed.path)), false, 'nothing is written for a mismatch');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
