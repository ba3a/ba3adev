// Tests of scripts/make-placeholders.mjs: the pictures it writes are
// deterministic, self-contained, safe to publish and in step with the files
// committed in content/ba3a.dev/projects. They need no build and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';
import { inspectSvg } from 'coffer';

import { contrastRatio } from '../site-test/lib/wcag.mjs';
import {
  CARD_SIZE,
  KEY_ART_SIZE,
  LOGO_SIZE,
  TOOL_CARDS,
  renderPlaceholders,
  writePlaceholders,
} from '../make-placeholders.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const projectsDir = join(root, 'content', 'ba3a.dev', 'projects');

const EXPECTED_FILES = [
  'roto/card',
  'faultory/card',
  'faultory/logo',
  'faultory/key-art',
].flatMap((name) => [`${name}.svg`, `${name}.png`]);

/** @type {Map<string, Buffer | string>} */
const generated = await renderPlaceholders();

/** @param {string} file */
function text(file) {
  const content = generated.get(file);
  assert.equal(typeof content, 'string', `${file} is text`);
  return /** @type {string} */ (content);
}

test('it makes a card for each tool that has no real one and a card, a wordmark and a key art for Faultory, as SVG and PNG', () => {
  assert.deepEqual([...generated.keys()].sort(), [...EXPECTED_FILES].sort());
  assert.deepEqual(
    TOOL_CARDS.map((tool) => tool.slug),
    ['roto'],
  );
});

test('running it twice gives byte-identical files', async () => {
  const again = await renderPlaceholders();
  assert.deepEqual([...again.keys()], [...generated.keys()]);
  for (const [file, content] of generated) {
    const other = again.get(file);
    assert.ok(Buffer.from(content).equals(Buffer.from(/** @type {Buffer | string} */ (other))), `${file} is identical`);
  }
});

test('writing is idempotent: the second run changes no file and leaves its modification time alone', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ba3a-placeholders-'));
  try {
    const first = await writePlaceholders({ projectsDir: directory });
    assert.equal(first.written.length, EXPECTED_FILES.length);
    assert.equal(first.unchanged.length, 0);

    const past = new Date('2020-01-01T00:00:00Z');
    for (const file of EXPECTED_FILES) utimesSync(join(directory, ...file.split('/')), past, past);
    const second = await writePlaceholders({ projectsDir: directory });
    assert.deepEqual(second.written, []);
    assert.equal(second.unchanged.length, EXPECTED_FILES.length);
    for (const file of EXPECTED_FILES) {
      assert.equal(statSync(join(directory, ...file.split('/'))).mtimeMs, past.getTime(), `${file} was not rewritten`);
      const bytes = generated.get(file);
      assert.ok(readFileSync(join(directory, ...file.split('/'))).equals(Buffer.from(/** @type {Buffer | string} */ (bytes))));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every SVG passes coffer\'s own SVG check and is self-contained', () => {
  for (const [file, content] of generated) {
    if (!file.endsWith('.svg')) continue;
    const svg = text(file);
    const report = inspectSvg(Buffer.from(svg, 'utf8'));
    assert.deepEqual(report.problems, [], `${file} has no problem`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
    // Text is outlined: an SVG shown as an image cannot load a web font.
    assert.doesNotMatch(svg, /<text\b|font-family|@font-face|@import|<style|<script|<foreignObject|<image\b|<use\b/i, `${file} is made of shapes only`);
    // The only address in the file is the XML namespace.
    assert.deepEqual([...svg.matchAll(/https?:\/\/[^"'\s)]+/g)].map((match) => match[0]), ['http://www.w3.org/2000/svg']);
    assert.match(svg, /<title>[^<]+<\/title>/, `${file} has a title`);
    assert.ok(typeof content === 'string' && Buffer.byteLength(content) < 20 * 1024, `${file} is small`);
  }
});

test('each PNG is the picture of its SVG, at the declared size', async () => {
  /** @type {Record<string, { width: number, height: number }>} */
  const sizes = {
    'card.png': CARD_SIZE,
    'logo.png': LOGO_SIZE,
    'key-art.png': KEY_ART_SIZE,
  };
  for (const [file, content] of generated) {
    if (!file.endsWith('.png')) continue;
    const expected = sizes[file.split('/')[1]];
    const meta = await sharp(/** @type {Buffer} */ (content)).metadata();
    assert.equal(meta.format, 'png');
    assert.deepEqual({ width: meta.width, height: meta.height }, expected, file);
    assert.equal(meta.hasAlpha, true, `${file} is RGBA`);
  }
  // The wordmark is transparent around the sticker; the cards and the key art are opaque.
  const { data, info } = await sharp(/** @type {Buffer} */ (generated.get('faultory/logo.png'))).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0, 'the corner of the wordmark is transparent');
  const centre = (Math.floor(info.height / 2) * info.width + 200) * info.channels;
  assert.equal(data[centre + 3], 255, 'the sticker is opaque');
  const card = await sharp(/** @type {Buffer} */ (generated.get('roto/card.png'))).raw().toBuffer({ resolveWithObject: true });
  assert.equal(card.data[3], 255, 'a card is opaque');
});

test('the name on a tool card is readable on its background', () => {
  for (const tool of TOOL_CARDS) {
    assert.ok(contrastRatio(tool.text, tool.background) >= 4.5, `${tool.slug}: text on background`);
    const svg = text(`${tool.slug}/card.svg`);
    assert.ok(svg.includes(`fill="${tool.background}"`));
    assert.ok(svg.includes(`fill="${tool.text}"`));
  }
});

test('the Faultory pictures use the accent colour of its declaration', () => {
  const declaration = readFileSync(join(projectsDir, 'faultory', 'project.yaml'), 'utf8');
  const accent = /^accent:\s*"?(#[0-9a-fA-F]{6})"?/m.exec(declaration)?.[1];
  assert.ok(accent, 'project.yaml sets an accent');
  for (const file of ['faultory/card.svg', 'faultory/logo.svg', 'faultory/key-art.svg']) {
    assert.ok(text(file).includes(`fill="${accent.toLowerCase()}"`), `${file} uses the accent`);
  }
});

test('the committed files are what the script writes (SVG byte for byte, PNG by size and picture)', async () => {
  for (const file of EXPECTED_FILES) {
    const path = join(projectsDir, ...file.split('/'));
    assert.ok(existsSync(path), `${file} is committed; run "node scripts/make-placeholders.mjs"`);
    const committed = readFileSync(path);
    if (file.endsWith('.svg')) {
      assert.equal(committed.toString('utf8'), text(file), `${file} is up to date; run "node scripts/make-placeholders.mjs"`);
    } else {
      // Rendering can differ in the last bit between platforms, so compare what a reader sees.
      const [left, right] = await Promise.all(
        [committed, /** @type {Buffer} */ (generated.get(file))].map((bytes) => sharp(bytes).raw().toBuffer({ resolveWithObject: true })),
      );
      assert.deepEqual([left.info.width, left.info.height], [right.info.width, right.info.height], file);
      let different = 0;
      for (let at = 0; at < left.data.length; at += 1) if (Math.abs(left.data[at] - right.data[at]) > 2) different += 1;
      assert.ok(different / left.data.length < 0.001, `${file} shows the same picture`);
    }
  }
});

test('the script reads only the pinned font packages and the theme font, and has no clock or random numbers', () => {
  const source = readFileSync(join(root, 'scripts', 'make-placeholders.mjs'), 'utf8');
  assert.doesNotMatch(source, /Date\.now|new Date|Math\.random|performance\.now|fetch\(|https?:\/\/(?!www\.w3\.org)/);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const name of ['@fontsource/handjet', 'opentype.js']) {
    assert.match(manifest.devDependencies?.[name] ?? '', /^\d+\.\d+\.\d+$/, `${name} is a devDependency pinned to an exact version`);
  }
});
