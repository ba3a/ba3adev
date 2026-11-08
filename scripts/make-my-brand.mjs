// Generates the brand pictures of my.ba3a.dev (themes/my/assets/brand/).
//
//   node scripts/make-my-brand.mjs
//
// The mark is the Armenian capital letter Վ (vev) in a brush script. Its outline
// below, VEV, was taken from the glyph U+054E of the font Vrdznagir by Levon
// Chkolyan (https://fonter.am/en/fonts/vrdznagir, free for personal and
// commercial use; see themes/my/README.md). Only the outline is kept, in font
// units (2048 per em, y up), so the script needs neither the font nor a network.
//
// Two looks, both sky blue ink:
//
//   * light pages: the letter on a deep-navy rounded tile (`logo.svg`);
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

export const SKY = '#38BDF8';
export const NAVY = '#0C4A6E';

/** The outline of U+054E in Vrdznagir: font units, y up. */
const VEV =
  'M701 -608 681 -589 660 -569Q647 -556 628 -539L611 -523Q625 -488 648 -434L667 -386L688 -337Q740 -211 776 -124Q888 140 975 333Q1224 878 1411 1142Q1470 1208 1480 1222Q1501 1253 1488 1269Q1473 1288 1445 1312Q1407 1344 1372 1364Q1330 1389 1304 1388Q1298 1388 1285 1379L1274 1372Q1269 1369 1265 1368Q1180 1346 774 364Q756 331 728 296Q557 81 412 95Q361 100 325 134Q294 162 293 188Q285 332 500 580Q538 637 499 680L404 739Q371 760 334 746L319 740L302 734Q282 727 267 721Q224 704 188 685Q89 631 5 536Q2 532 3 520L4 510L5 505L6 502Q13 470 41 449Q73 425 113 433Q118 434 126 439Q133 444 138 448Q195 501 210 514Q170 457 147 400Q111 312 118 230L117 226H118Q127 143 181 74Q236 4 377 -2Q496 -8 581 27Q615 41 652 69Q549 -187 468 -399L462 -394Q443 -378 428 -367Q378 -330 330 -311Q181 -252 67 -365Q4 -428 0 -528Q-3 -627 53 -698Q97 -756 165 -782Q232 -808 308 -802Q401 -795 470 -749Q519 -717 549 -669Q549 -670 552 -671L553 -672Q557 -675 563 -680Q581 -692 600 -704Q924 -932 1202 -837Q1347 -785 1430 -666Q1287 -757 1180 -771Q993 -797 790 -678Q750 -655 701 -608ZM408 -558 406 -562Q400 -572 394 -579Q376 -605 353 -622Q280 -675 188 -643Q136 -616 128 -605Q118 -593 112 -580Q95 -543 108 -511Q154 -405 286 -453Q320 -470 360 -504Q373 -516 389 -532L401 -543Q406 -548 411 -553Q410 -554 409 -556Z';

/** Bounds of VEV in font units: x 0..1493, y -865..1388. */
const CENTRE = { x: 746.5, y: 261.5 };
const HEIGHT = 2253;

const BOX = 512;
/** The letter is this share of the picture tall. */
const FILL = 0.72;
const SCALE = (BOX * FILL) / HEIGHT;
/** Corner radius of the tile, 22 % of its side. */
const RADIUS = 112;

/** @param {number} n @returns {string} */
const num = (n) => String(Math.round(n * 1000) / 1000);

/**
 * The letter as a path. `extra` is the stroke added around it, in picture
 * units: the brush is thin, so small sizes get a little more ink.
 *
 * @param {number} extra
 * @param {string} [attrs] Further attributes of the path.
 */
function letter(extra, attrs = '') {
  const tx = BOX / 2 - SCALE * CENTRE.x;
  const ty = BOX / 2 + SCALE * CENTRE.y;
  const stroke = extra > 0 ? ` stroke="${SKY}" stroke-width="${num(extra / SCALE)}" stroke-linejoin="round"` : '';
  return `<path${attrs} fill="${SKY}"${stroke} fill-rule="evenodd" transform="matrix(${num(SCALE)} 0 0 ${num(-SCALE)} ${num(tx)} ${num(ty)})" d="${VEV}"/>`;
}

/** @param {string} body @param {number} [size] @param {string} [head] */
function svg(body, size = BOX, head = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${BOX} ${BOX}">\n<title>ba3a</title>\n${head}${body}\n</svg>\n`;
}

/** The navy tile. @param {boolean} rounded @param {string} [attrs] */
function tile(rounded, attrs = '') {
  return `<rect${attrs} width="${BOX}" height="${BOX}"${rounded ? ` rx="${RADIUS}"` : ''} fill="${NAVY}"/>`;
}

/**
 * @param {number} px Size of the picture on screen, to size the extra ink.
 * @returns {number} Extra stroke in picture units.
 */
function ink(px) {
  const pixels = px <= 16 ? 0.5 : px <= 32 ? 0.4 : px <= 48 ? 0.3 : 0;
  return (pixels * BOX) / px;
}

/** @returns {Map<string, string | Buffer>} File name to content. */
export function sources() {
  const files = new Map();
  files.set('logo.svg', svg(`${tile(true)}\n${letter(0)}`));
  files.set('logo-dark.svg', svg(letter(0)));
  // The favicon is drawn at 16 to 32 px, so it carries a little extra ink.
  files.set(
    'favicon.svg',
    svg(
      `${tile(true, ' class="tile"')}\n${letter(6)}`,
      BOX,
      `<style>.tile{fill:${NAVY}}@media (prefers-color-scheme:dark){.tile{fill:none}}</style>\n`,
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
  const body = (withTile ? `${tile(rounded)}\n` : '') + letter(ink(size));
  return sharp(Buffer.from(svg(body, size)), { density: 72 }).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * An ICO file that holds PNG images.
 *
 * @param {{ size: number, data: Buffer }[]} images
 * @returns {Buffer}
 */
export function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
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

export const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'themes', 'my', 'assets', 'brand');

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
