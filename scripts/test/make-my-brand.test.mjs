// Tests of scripts/make-my-brand.mjs: the brand pictures of my.ba3a.dev are
// deterministic, safe to publish, sky blue, and in step with the files committed
// in themes/my/assets/brand. They need no build and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { inspectSvg } from 'coffer';

import { NAVY, OUTPUT, SKY, build, main } from '../make-my-brand.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const committed = join(root, 'themes', 'my', 'assets', 'brand');

const files = await build();

const EXPECTED = [
  'apple-touch-icon.png',
  'favicon.ico',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'logo-dark.png',
  'logo-dark.svg',
  'logo.png',
  'logo.svg',
];

test('the script writes exactly the expected files, into the theme', () => {
  assert.deepEqual([...files.keys()].sort(), EXPECTED);
  assert.equal(OUTPUT, committed);
});

test('every SVG passes coffer\'s own SVG check and is self-contained', () => {
  for (const [name, content] of files) {
    if (!name.endsWith('.svg')) continue;
    assert.equal(typeof content, 'string');
    const svg = /** @type {string} */ (content);
    assert.deepEqual(inspectSvg(Buffer.from(svg, 'utf8')).problems, [], `${name} has no problem`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
    assert.doesNotMatch(svg, /<text\b|font-family|@font-face|@import|<script|<foreignObject|<image\b|<use\b/i, `${name} is made of shapes only`);
    assert.deepEqual([...svg.matchAll(/https?:\/\/[^"'\s)]+/g)].map((match) => match[0]), ['http://www.w3.org/2000/svg']);
    assert.match(svg, /<title>ba3a<\/title>/);
    assert.ok(Buffer.byteLength(svg) < 8 * 1024, `${name} is small`);
  }
});

test('the light logo is the letter on a navy tile, the dark one is the bare letter, both in sky blue', () => {
  const light = /** @type {string} */ (files.get('logo.svg'));
  const dark = /** @type {string} */ (files.get('logo-dark.svg'));
  assert.ok(light.includes(`<rect width="512" height="512" rx="112" fill="${NAVY}"/>`));
  assert.ok(light.includes(`fill="${SKY}"`));
  assert.ok(!dark.includes('<rect'), 'the dark logo has no tile');
  assert.ok(dark.includes(`fill="${SKY}"`));
  assert.ok(!dark.includes(NAVY));
});

test('the favicon shows the tile on light tabs and only the letter on dark tabs', () => {
  const svg = /** @type {string} */ (files.get('favicon.svg'));
  assert.match(svg, /\.tile\{fill:#0C4A6E\}@media \(prefers-color-scheme:dark\)\{\.tile\{fill:none\}\}/);
  assert.match(svg, /<rect class="tile"/);
});

test('every PNG has its declared size, and the ICO holds 16, 32 and 48 px images', async () => {
  const sizes = {
    'apple-touch-icon.png': 180,
    'icon-192.png': 192,
    'icon-512.png': 512,
    'logo.png': 512,
    'logo-dark.png': 512,
  };
  for (const [name, size] of Object.entries(sizes)) {
    const meta = await sharp(/** @type {Buffer} */ (files.get(name))).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', size, size], name);
  }
  const ico = /** @type {Buffer} */ (files.get('favicon.ico'));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 3]);
  for (const [index, size] of [16, 32, 48].entries()) {
    const at = 6 + 16 * index;
    assert.equal(ico[at], size);
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    const meta = await sharp(ico.subarray(offset, offset + length)).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', size, size], `ico image ${size}`);
  }
});

test('the dark logo is transparent around the letter, the others are opaque in the middle of the tile', async () => {
  const dark = await sharp(/** @type {Buffer} */ (files.get('logo-dark.png'))).raw().toBuffer({ resolveWithObject: true });
  assert.equal(dark.data[3], 0, 'the corner of the dark logo is transparent');
  const apple = await sharp(/** @type {Buffer} */ (files.get('apple-touch-icon.png'))).raw().toBuffer({ resolveWithObject: true });
  assert.equal(apple.data[3], 255, 'the apple touch icon is full bleed (iOS rounds the corners itself)');
  assert.deepEqual([...apple.data.subarray(0, 3)], [0x0c, 0x4a, 0x6e]);
});

test('running the script again writes nothing, and the committed files are the generated ones (SVG byte for byte)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'brand-'));
  try {
    assert.equal((await main(directory)).length, EXPECTED.length);
    assert.deepEqual(await main(directory), [], 'the second run changes nothing');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const name of EXPECTED.filter((file) => file.endsWith('.svg'))) {
    assert.equal(readFileSync(join(committed, name), 'utf8'), files.get(name), `${name} is up to date (run node scripts/make-my-brand.mjs)`);
  }
  for (const name of EXPECTED.filter((file) => !file.endsWith('.svg'))) {
    const meta = await sharp(readFileSync(join(committed, name))).metadata().catch(() => null);
    assert.ok(name.endsWith('.ico') || meta, `${name} is committed and readable`);
  }
});
