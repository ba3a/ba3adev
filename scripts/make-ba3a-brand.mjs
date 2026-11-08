// Generates the brand pictures of ba3a.dev (themes/ba3a/assets/brand/).
//
//   node scripts/make-ba3a-brand.mjs
//
// The mark is a capital B with a command-line prompt, ">", cut out of its body.
// The chevron is a hole in the letter (an even-odd sub-path), so whatever is
// behind the mark shows through it. Both the letter and the chevron are plain
// polygons and curves, drawn here in a 512 x 512 box; no font is needed.
//
// Two looks, both in the accent teal of the site:
//
//   * light pages: the letter on a slate rounded tile (`logo.svg`);
//   * dark pages: the bare letter, nothing behind it (`logo-dark.svg`).
//
// `favicon.svg` switches between them with prefers-color-scheme. The raster
// files, for browsers and devices that cannot use an SVG icon, always carry the
// tile, so they read on any tab or home screen.
//
// Written files: favicon.svg, favicon.ico (16, 32 and 48 px), apple-touch-icon.png
// (180 px, full bleed: iOS rounds the corners itself), icon-192.png, icon-512.png,
// logo.svg, logo-dark.svg, logo.png and logo-dark.png (512 px). The script is
// deterministic, and a file whose content has not changed is not touched. The
// SVG files contain no script, no external reference and no text.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { ico } from './make-my-brand.mjs';

/** The accent of the dark scheme of the site (themes/ba3a/theme.yaml). */
export const TEAL = '#4FC8DF';
/** The card and dark-page background of the site. */
export const SLATE = '#0C1320';

const BOX = 512;
/** Corner radius of the tile, 22 % of its side. */
const RADIUS = 112;

/**
 * The B: a stem, a smaller upper bowl and a wider lower one, 372 px tall and
 * centred in the box. Absolute coordinates, y down.
 */
const LETTER =
  'M119 100H269C339 100 381 130 381 184C381 220 361 244 331 256C369 266 393 294 393 334C393 390 347 412 273 412H119Z';

/**
 * The prompt, ">", as a polygon with vertical ends and 45 degree arms.
 *
 * @param {number} weight Horizontal width of an arm: the stroke is weight / sqrt 2.
 * @returns {string} Path data.
 */
function chevron(weight) {
  const x = 160;
  const top = 190;
  const mid = 256;
  const bottom = 322;
  const reach = mid - top;
  const w = weight;
  const points = [
    [x, top],
    [x + w, top],
    [x + w + reach, mid],
    [x + w, bottom],
    [x, bottom],
    [x + reach, mid],
  ];
  return `M${points.map(([px, py]) => `${px} ${py}`).join('L')}Z`;
}

/**
 * The letter with the prompt cut out.
 *
 * @param {number} weight Arm width of the chevron.
 * @param {string} [attrs] Further attributes of the path.
 */
function mark(weight, attrs = '') {
  return `<path${attrs} fill="${TEAL}" fill-rule="evenodd" d="${LETTER}${chevron(weight)}"/>`;
}

/** @param {string} body @param {number} [size] @param {string} [head] */
function svg(body, size = BOX, head = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}">\n<title>ba3a</title>\n${head}${body}\n</svg>\n`;
}

/** The slate tile. @param {boolean} rounded @param {string} [attrs] */
function tile(rounded, attrs = '') {
  return `<rect${attrs} width="${BOX}" height="${BOX}"${rounded ? ` rx="${RADIUS}"` : ''} fill="${SLATE}"/>`;
}

/** Arm width of the chevron for the large pictures. */
const WEIGHT = 56;

/**
 * The chevron is the fine detail of the mark, so small sizes get a heavier one.
 *
 * @param {number} px Size of the picture on screen.
 * @returns {number} Arm width.
 */
function weightFor(px) {
  return px <= 16 ? 74 : px <= 32 ? 68 : px <= 48 ? 62 : WEIGHT;
}

/** @returns {Map<string, string | Buffer>} File name to content. */
export function sources() {
  const files = new Map();
  files.set('logo.svg', svg(`${tile(true)}\n${mark(WEIGHT)}`));
  files.set('logo-dark.svg', svg(mark(WEIGHT)));
  // The favicon is drawn at 16 to 32 px, so it carries the heavier chevron.
  files.set(
    'favicon.svg',
    svg(
      `${tile(true, ' class="tile"')}\n${mark(weightFor(32))}`,
      BOX,
      `<style>.tile{fill:${SLATE}}@media (prefers-color-scheme:dark){.tile{fill:none}}</style>\n`,
    ),
  );
  return files;
}

/**
 * @param {number} size
 * @param {{ rounded?: boolean, tile?: boolean }} [options]
 * @returns {Promise<Buffer>}
 */
async function png(size, { rounded = true, tile: withTile = true } = {}) {
  const body = (withTile ? `${tile(rounded)}\n` : '') + mark(weightFor(size));
  return sharp(Buffer.from(svg(body, size)), { density: 72 }).png({ compressionLevel: 9 }).toBuffer();
}

/** @returns {Promise<Map<string, string | Buffer>>} Every file of the brand folder. */
export async function build() {
  const files = sources();
  files.set('apple-touch-icon.png', await png(180, { rounded: false }));
  files.set('icon-192.png', await png(192));
  files.set('icon-512.png', await png(512));
  files.set('logo.png', await png(512));
  files.set('logo-dark.png', await png(512, { tile: false }));
  const sizes = [16, 32, 48];
  files.set('favicon.ico', ico(await Promise.all(sizes.map(async (size) => ({ size, data: await png(size) })))));
  return files;
}

export const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'themes', 'ba3a', 'assets', 'brand');

/** Writes the files that changed. @returns {Promise<string[]>} Names written. */
export async function main(directory = OUTPUT) {
  mkdirSync(directory, { recursive: true });
  const written = [];
  for (const [name, content] of await build()) {
    const path = join(directory, name);
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    if (existsSync(path) && readFileSync(path).equals(data)) continue;
    writeFileSync(path, data);
    written.push(name);
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const written = await main();
  console.log(written.length ? `wrote ${written.join(', ')}` : 'all brand files are up to date');
}
