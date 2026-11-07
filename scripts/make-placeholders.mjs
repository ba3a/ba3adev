// Generates the placeholder pictures of the seed projects of ba3a.dev.
//
//   node scripts/make-placeholders.mjs
//
// For every project in `content/ba3a.dev/projects/` it writes a card picture
// (the project's name on a coloured background). For Faultory it also writes a
// wordmark in Handjet on a sticker shape, and a key art. These are design
// placeholders, not photos and not final artwork: they exist so that the pages
// have pictures until the real ones replace them.
//
// Each picture is written twice, because the two readers need different things:
//
//   * `*.svg` is the source: small text that diffs in git. Text is converted to
//     outlines with the font files, because an SVG shown through <img> or opened
//     as a download cannot load a web font. The files contain no script, no
//     external reference and no foreignObject, so they pass coffer's own SVG
//     check (`inspectSvg`), which the press-kit logo is subject to.
//   * `*.png` is the same picture rendered with sharp. The project fields `card`,
//     `logo` and `keyArt` accept only JPEG, PNG, WebP and HEIC (github.com/ba3a/coffer/blob/v0.1.0/docs/projects.md),
//     so the SVG cannot be named there.
//
// The script is deterministic: it uses no clock and no random numbers, so
// running it again writes byte-identical files, and a file whose content has not
// changed is not touched. The fonts are the theme's Manrope Bold (cards of the
// tools) and Handjet Bold from the pinned `@fontsource/handjet` devDependency
// (the Faultory wordmark); opentype.js reads the outlines.
//
// Seed photos
// -----------
// The draft posts of both blogs (content/ba3a.dev/devlog/{first,second} and
// content/my.ba3a.dev/{pervyj,vtoroj}) show a carousel and a captioned picture.
// Their made-up "photographs" are JPEGs with a made-up camera and a GPS position
// at a clearly synthetic place (Point Nemo for the devlog, the middle of the
// North Atlantic for the woodworking blog), so that the location policy has
// something to strip. They are originals in the sense of the media store: they
// sit below `media.include`, git ignores them and `media.lock.json` lists them.
// Because the encoder is deterministic, a clean checkout that has neither the
// store nor credentials gets the very same bytes back:
//
//   node scripts/make-placeholders.mjs --photos          create the seed photos that are missing
//                                                        (then run `coffer media lock`)
//   node scripts/make-placeholders.mjs --restore-photos  write the missing seed photos that
//                                                        media.lock.json lists, and nothing else
//
// Neither ever overwrites a file that exists, so a real photograph that replaces
// a placeholder is safe, and `--restore-photos` leaves out a photo whose lock
// entry was removed on purpose. A lock entry whose hash the generator no longer
// reproduces is an error: pull the original from the media store instead.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import opentype from 'opentype.js';
import sharp from 'sharp';
import { parse as parseYaml } from 'yaml';

import { parseLock } from '../node_modules/coffer/src/media/lock.js';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));

/** Size of a card picture: the size of a link preview image. */
export const CARD_SIZE = Object.freeze({ width: 1200, height: 630 });
/** Size of the key art of a game. */
export const KEY_ART_SIZE = Object.freeze({ width: 1600, height: 900 });
/** Size of the wordmark, at twice the size of its drawing so that it stays sharp. */
export const LOGO_SIZE = Object.freeze({ width: 1920, height: 640 });

const DARK_INK = '#17171c';
const FALLBACK_ACCENT = '#e8841a';

/**
 * The tools that still have a placeholder card (specloop has its real one, from its brand kit): the slug of the project folder, the name written on the card and
 * the colours (the text must stay readable on the background).
 *
 * @type {ReadonlyArray<{ slug: string, name: string, background: string, band: string, text: string }>}
 */
export const TOOL_CARDS = Object.freeze([
  { slug: 'roto', name: 'roto', background: '#1c4a3a', band: '#8fd6b0', text: '#ffffff' },
  { slug: 'coffer', name: 'coffer', background: '#46301f', band: '#e0b27c', text: '#ffffff' },
]);

/**
 * @param {string} path
 * @returns {import('opentype.js').Font}
 */
function loadFont(path) {
  const bytes = readFileSync(path);
  return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/**
 * @param {import('opentype.js').Font} font
 * @param {string} text
 * @param {number} size Font size, in drawing units.
 * @returns {number} The advance width of the text.
 */
function textWidth(font, text, size) {
  return font.getAdvanceWidth(text, size);
}

/**
 * The outline of a text, centred on a point, as the `d` of an SVG path.
 *
 * @param {import('opentype.js').Font} font
 * @param {string} text
 * @param {number} size
 * @param {number} centerX
 * @param {number} centerY The middle of the capital letters.
 * @returns {string}
 */
function centeredPath(font, text, size, centerX, centerY) {
  const capHeight = ((font.tables.os2?.sCapHeight ?? font.ascender * 0.7) * size) / font.unitsPerEm;
  const x = centerX - textWidth(font, text, size) / 2;
  return font.getPath(text, x, centerY + capHeight / 2, size).toPathData(2);
}

/**
 * @param {import('opentype.js').Font} font
 * @param {string} text
 * @param {number} wanted Preferred size.
 * @param {number} maxWidth
 * @returns {number} The preferred size, or a smaller one when the text is wider than `maxWidth`.
 */
function fitSize(font, text, wanted, maxWidth) {
  const width = textWidth(font, text, wanted);
  return width <= maxWidth ? wanted : Math.floor((wanted * maxWidth) / width);
}

/**
 * @param {string} text
 * @returns {string} The text, escaped for use in XML.
 */
function xml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {object} input
 * @param {number} input.width Width of the picture, in pixels.
 * @param {number} input.height
 * @param {number} [input.viewWidth] Width of the drawing; defaults to `width`.
 * @param {number} [input.viewHeight]
 * @param {string} input.title A short description, for the <title> element.
 * @param {string} input.body The drawing.
 * @returns {string}
 */
function svgDocument({ width, height, viewWidth = width, viewHeight = height, title, body }) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewWidth} ${viewHeight}" role="img">\n` +
    `<title>${xml(title)}</title>\n${body.trim()}\n</svg>\n`
  );
}

/**
 * The card of a tool: its name on a coloured background, with a band along the bottom.
 *
 * @param {import('opentype.js').Font} font
 * @param {(typeof TOOL_CARDS)[number]} tool
 * @returns {string}
 */
function toolCard(font, tool) {
  const { width, height } = CARD_SIZE;
  const size = fitSize(font, tool.name, 220, width - 200);
  return svgDocument({
    width,
    height,
    title: `Placeholder card: ${tool.name}`,
    body: `
<rect width="${width}" height="${height}" fill="${tool.background}"/>
<rect y="${height - 28}" width="${width}" height="28" fill="${tool.band}"/>
<path d="${centeredPath(font, tool.name, size, width / 2, (height - 28) / 2)}" fill="${tool.text}"/>`,
  });
}

/**
 * A sticker with the wordmark: a rounded plate, a dashed inner border, four
 * screws and the name, tilted a little.
 *
 * @param {import('opentype.js').Font} font
 * @param {string} accent
 * @param {{ cx: number, cy: number, width: number, height: number, angle: number }} place
 * @returns {string}
 */
function sticker(font, accent, { cx, cy, width, height, angle }) {
  const left = cx - width / 2;
  const top = cy - height / 2;
  const size = fitSize(font, 'FAULTORY', height * 0.62, width * 0.8);
  const inset = height * 0.06;
  const screw = height * 0.035;
  const screws = [
    [left + inset * 2.2, top + inset * 2.2],
    [left + width - inset * 2.2, top + inset * 2.2],
    [left + inset * 2.2, top + height - inset * 2.2],
    [left + width - inset * 2.2, top + height - inset * 2.2],
  ]
    .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${screw.toFixed(1)}" fill="${DARK_INK}"/>`)
    .join('\n');
  return `
<g transform="rotate(${angle} ${cx} ${cy})">
<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="${height * 0.14}" fill="${accent}"/>
<rect x="${left + inset}" y="${top + inset}" width="${width - inset * 2}" height="${height - inset * 2}" rx="${height * 0.1}" fill="none" stroke="${DARK_INK}" stroke-width="${(height * 0.025).toFixed(1)}" stroke-dasharray="${(height * 0.09).toFixed(1)} ${(height * 0.05).toFixed(1)}"/>
${screws}
<path d="${centeredPath(font, 'FAULTORY', size, cx, cy)}" fill="${DARK_INK}"/>
</g>`;
}

/**
 * @param {import('opentype.js').Font} font
 * @param {string} accent
 * @returns {string} The wordmark: the sticker on a transparent background.
 */
function faultoryLogo(font, accent) {
  return svgDocument({
    width: LOGO_SIZE.width,
    height: LOGO_SIZE.height,
    viewWidth: 960,
    viewHeight: 320,
    title: 'Faultory (placeholder wordmark)',
    body: sticker(font, accent, { cx: 480, cy: 160, width: 880, height: 240, angle: -3 }),
  });
}

/**
 * A grid, like the floor of a retro-futuristic warehouse.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} step
 * @param {string} colour
 * @returns {string}
 */
function grid(width, height, step, colour) {
  const lines = [];
  for (let x = step; x < width; x += step) lines.push(`M${x} 0V${height}`);
  for (let y = step; y < height; y += step) lines.push(`M0 ${y}H${width}`);
  return `<path d="${lines.join('')}" fill="none" stroke="${colour}" stroke-width="2"/>`;
}

/**
 * @param {import('opentype.js').Font} font
 * @param {string} accent
 * @returns {string} The card of Faultory: the sticker on a dark grid.
 */
function faultoryCard(font, accent) {
  const { width, height } = CARD_SIZE;
  return svgDocument({
    width,
    height,
    title: 'Faultory (placeholder card)',
    body: `
<rect width="${width}" height="${height}" fill="${DARK_INK}"/>
${grid(width, height, 60, '#26262f')}
${sticker(font, accent, { cx: width / 2, cy: height / 2, width: 900, height: 270, angle: -3 })}`,
  });
}

/**
 * A crate on the conveyor; a defective one is marked and tilted.
 *
 * @param {number} x
 * @param {number} y Top of the crate.
 * @param {number} size
 * @param {string} fill
 * @param {boolean} defective
 * @returns {string}
 */
function crate(x, y, size, fill, defective) {
  const inner = size * 0.18;
  const mark = defective
    ? `<path d="M${x + inner} ${y + inner}L${x + size - inner} ${y + size - inner}M${x + size - inner} ${y + inner}L${x + inner} ${y + size - inner}" stroke="${DARK_INK}" stroke-width="${size * 0.1}" stroke-linecap="square"/>`
    : `<rect x="${x + inner}" y="${y + inner}" width="${size - inner * 2}" height="${size - inner * 2}" fill="none" stroke="${DARK_INK}" stroke-width="${size * 0.06}"/>`;
  const tilt = defective ? ` transform="rotate(8 ${x + size / 2} ${y + size})"` : '';
  return `<g${tilt}><rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${fill}"/>${mark}</g>`;
}

/**
 * @param {import('opentype.js').Font} font
 * @param {string} accent
 * @returns {string} The key art of Faultory: a conveyor of crates, one of them defective, under the sticker.
 */
function faultoryKeyArt(font, accent) {
  const { width, height } = KEY_ART_SIZE;
  const belt = 640;
  const crates = [];
  for (let index = 0; index < 8; index += 1) {
    const x = 90 + index * 190;
    crates.push(crate(x, belt - 130, 130, index === 5 ? accent : '#8d93a6', index === 5));
  }
  return svgDocument({
    width,
    height,
    title: 'Faultory (placeholder key art)',
    body: `
<defs>
<linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#101015"/>
<stop offset="1" stop-color="#262633"/>
</linearGradient>
</defs>
<rect width="${width}" height="${height}" fill="url(#wall)"/>
${grid(width, height, 80, '#2d2d3a')}
<rect y="${belt}" width="${width}" height="40" fill="#3a3a48"/>
<rect y="${belt + 40}" width="${width}" height="${height - belt - 40}" fill="#17171c"/>
<path d="M0 ${belt + 120}H${width}M0 ${belt + 200}H${width}M0 ${belt + 280}H${width}" stroke="#2d2d3a" stroke-width="2"/>
${crates.join('\n')}
${sticker(font, accent, { cx: 580, cy: 290, width: 880, height: 240, angle: -3 })}`,
  });
}

/**
 * @param {string} svg
 * @returns {Promise<Buffer>} The picture as a PNG, rendered at the size the SVG declares.
 */
async function renderPng(svg) {
  return sharp(Buffer.from(svg), { density: 72 }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}

/**
 * The accent colour of Faultory, read from its declaration so that the colour is written once.
 *
 * @param {string} root
 * @returns {string}
 */
function faultoryAccent(root) {
  const declaration = join(root, 'content', 'ba3a.dev', 'projects', 'faultory', 'project.yaml');
  if (!existsSync(declaration)) return FALLBACK_ACCENT;
  const accent = /** @type {{ accent?: string }} */ (parseYaml(readFileSync(declaration, 'utf8'))).accent;
  return typeof accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent.toLowerCase() : FALLBACK_ACCENT;
}

/**
 * Makes every placeholder picture.
 *
 * @param {object} [options]
 * @param {string} [options.root] The repository root.
 * @returns {Promise<Map<string, Buffer | string>>} The content of each file, by its path below `content/ba3a.dev/projects/`, with forward slashes.
 */
export async function renderPlaceholders({ root = defaultRoot } = {}) {
  const manrope = loadFont(join(root, 'themes', 'ba3a', 'fonts', 'Manrope-Bold.ttf'));
  const handjet = loadFont(join(root, 'node_modules', '@fontsource', 'handjet', 'files', 'handjet-latin-700-normal.woff'));
  const accent = faultoryAccent(root);

  /** @type {Array<[string, string]>} */
  const drawings = [
    ...TOOL_CARDS.map(/** @returns {[string, string]} */ (tool) => [`${tool.slug}/card.svg`, toolCard(manrope, tool)]),
    ['faultory/card.svg', faultoryCard(handjet, accent)],
    ['faultory/logo.svg', faultoryLogo(handjet, accent)],
    ['faultory/key-art.svg', faultoryKeyArt(handjet, accent)],
  ];

  /** @type {Map<string, Buffer | string>} */
  const files = new Map();
  for (const [file, svg] of drawings) {
    files.set(file, svg);
    files.set(file.replace(/\.svg$/, '.png'), await renderPng(svg));
  }
  return files;
}

/**
 * Writes the placeholders below the projects folder; a file that already has the same content is left alone.
 *
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {string} [options.projectsDir] Where to write; defaults to `content/ba3a.dev/projects` below `root`.
 * @returns {Promise<{ written: string[], unchanged: string[] }>}
 */
export async function writePlaceholders({ root = defaultRoot, projectsDir } = {}) {
  const projects = projectsDir ?? join(root, 'content', 'ba3a.dev', 'projects');
  const written = [];
  const unchanged = [];
  for (const [file, content] of await renderPlaceholders({ root })) {
    const target = join(projects, ...file.split('/'));
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (existsSync(target) && readFileSync(target).equals(bytes)) {
      unchanged.push(file);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    written.push(file);
  }
  return { written, unchanged };
}

// ---------------------------------------------------------------------------
// Seed photos
// ---------------------------------------------------------------------------

/** Size of a seed photo, in pixels. */
export const PHOTO_SIZE = Object.freeze({ width: 1600, height: 1066 });

/** JPEG quality of the seed photos: small files, good enough for a made-up picture. */
const PHOTO_QUALITY = 70;

const CAMERA = Object.freeze({ Make: 'Placeholder Camera Co.', Model: 'Made-up 1' });

/**
 * The made-up places of the photos, as degrees, minutes and seconds. Each photo
 * moves a few arc seconds away from the base so that the positions differ.
 *
 * - The devlog: Point Nemo, 48 deg 52' 36" S, 123 deg 23' 36" W, the point of the
 *   ocean farthest from any land.
 * - The woodworking blog: 30 deg N, 40 deg W, in the middle of the North Atlantic.
 */
const PLACES = Object.freeze({
  devlog: { latitudeRef: 'S', latitude: [48, 52, 36], longitudeRef: 'W', longitude: [123, 23, 36] },
  woodworking: { latitudeRef: 'N', latitude: [30, 0, 0], longitudeRef: 'W', longitude: [40, 0, 0] },
});

/**
 * @typedef {object} SeedPhoto
 * @property {string} path Path from the repository root, with forward slashes.
 * @property {'devlog' | 'woodworking'} place
 * @property {'window' | 'loop' | 'cards' | 'box'} motif
 * @property {string} title The words drawn on the picture (Latin letters only: the font has no Cyrillic).
 * @property {[string, string]} sky Top and bottom colour of the background.
 * @property {string} ink Colour of the drawing; it must stand out from the background.
 */

/**
 * The photos of the four seed posts. Per post: one captioned photo and the three photos of its carousel.
 *
 * @type {ReadonlyArray<SeedPhoto>}
 */
export const SEED_PHOTOS = Object.freeze(
  /** @type {SeedPhoto[]} */ ([
    { path: 'content/ba3a.dev/devlog/first/desk.jpg', place: 'devlog', motif: 'window', title: 'Desk', sky: ['#16365c', '#0b1b30'], ink: '#7fb6ff' },
    { path: 'content/ba3a.dev/devlog/first/sketch-1.jpg', place: 'devlog', motif: 'loop', title: 'Sketch 1', sky: ['#1c4a3a', '#0d241c'], ink: '#8fd6b0' },
    { path: 'content/ba3a.dev/devlog/first/sketch-2.jpg', place: 'devlog', motif: 'cards', title: 'Sketch 2', sky: ['#3a2a5c', '#1b1230'], ink: '#c4a8ff' },
    { path: 'content/ba3a.dev/devlog/first/sketch-3.jpg', place: 'devlog', motif: 'window', title: 'Sketch 3', sky: ['#5c2a3a', '#301219'], ink: '#ffa8bd' },
    { path: 'content/ba3a.dev/devlog/second/run-1.jpg', place: 'devlog', motif: 'cards', title: 'Run 1', sky: ['#16365c', '#0b1b30'], ink: '#ffd27f' },
    { path: 'content/ba3a.dev/devlog/second/run-2.jpg', place: 'devlog', motif: 'loop', title: 'Run 2', sky: ['#1c4a3a', '#0d241c'], ink: '#ffd27f' },
    { path: 'content/ba3a.dev/devlog/second/run-3.jpg', place: 'devlog', motif: 'window', title: 'Run 3', sky: ['#3a2a5c', '#1b1230'], ink: '#ffd27f' },
    { path: 'content/ba3a.dev/devlog/second/terminal.jpg', place: 'devlog', motif: 'window', title: 'Terminal', sky: ['#222222', '#0c0c0c'], ink: '#9be39b' },
    { path: 'content/my.ba3a.dev/pervyj/bench.jpg', place: 'woodworking', motif: 'box', title: 'Bench', sky: ['#7a5230', '#46301f'], ink: '#e6c590' },
    { path: 'content/my.ba3a.dev/pervyj/box-1.jpg', place: 'woodworking', motif: 'box', title: 'Box 1', sky: ['#6e4a22', '#3a2610'], ink: '#f0d9a8' },
    { path: 'content/my.ba3a.dev/pervyj/box-2.jpg', place: 'woodworking', motif: 'box', title: 'Box 2', sky: ['#5e7a8a', '#2d3d46'], ink: '#ead3a4' },
    { path: 'content/my.ba3a.dev/pervyj/box-3.jpg', place: 'woodworking', motif: 'box', title: 'Box 3', sky: ['#7b5a46', '#40291c'], ink: '#f4e1bd' },
    { path: 'content/my.ba3a.dev/vtoroj/hinge-1.jpg', place: 'woodworking', motif: 'box', title: 'Hinge 1', sky: ['#6e4a22', '#3a2610'], ink: '#d9b36d' },
    { path: 'content/my.ba3a.dev/vtoroj/hinge-2.jpg', place: 'woodworking', motif: 'box', title: 'Hinge 2', sky: ['#5e7a8a', '#2d3d46'], ink: '#d9b36d' },
    { path: 'content/my.ba3a.dev/vtoroj/hinge-3.jpg', place: 'woodworking', motif: 'box', title: 'Hinge 3', sky: ['#7b5a46', '#40291c'], ink: '#d9b36d' },
    { path: 'content/my.ba3a.dev/vtoroj/lid.jpg', place: 'woodworking', motif: 'box', title: 'Lid', sky: ['#7a5230', '#46301f'], ink: '#f0d9a8' },
  ]),
);

/**
 * @param {SeedPhoto['motif']} motif
 * @param {string} ink
 * @param {number} width
 * @param {number} height
 * @returns {string} The drawing of a motif, in the upper two thirds of the picture.
 */
function motifShapes(motif, ink, width, height) {
  const cx = width / 2;
  const cy = height * 0.4;
  switch (motif) {
    case 'window':
      return (
        `<rect x="${cx - 380}" y="${cy - 220}" width="760" height="440" rx="18" fill="none" stroke="${ink}" stroke-width="10"/>` +
        `<path d="M${cx - 380} ${cy - 140}H${cx + 380}" stroke="${ink}" stroke-width="10"/>` +
        [0, 1, 2, 3]
          .map((row) => `<rect x="${cx - 330}" y="${cy - 90 + row * 70}" width="${260 + ((row * 97) % 320)}" height="22" rx="6" fill="${ink}" fill-opacity="0.7"/>`)
          .join('')
      );
    case 'loop':
      return (
        `<circle cx="${cx}" cy="${cy}" r="190" fill="none" stroke="${ink}" stroke-width="22" stroke-dasharray="900 300"/>` +
        `<polygon points="${cx + 190},${cy - 70} ${cx + 262},${cy + 30} ${cx + 118},${cy + 30}" fill="${ink}"/>` +
        `<circle cx="${cx}" cy="${cy}" r="52" fill="${ink}" fill-opacity="0.8"/>`
      );
    case 'cards':
      return [0, 1, 2]
        .map(
          (index) =>
            `<rect x="${cx - 420 + index * 290}" y="${cy - 170 + (index % 2) * 60}" width="250" height="340" rx="16" fill="${ink}" fill-opacity="${0.35 + index * 0.2}" stroke="${ink}" stroke-width="6"/>`,
        )
        .join('');
    case 'box':
      return (
        `<rect x="${cx - 330}" y="${cy - 60}" width="660" height="250" rx="10" fill="${ink}" fill-opacity="0.85" stroke="#2b2118" stroke-width="8"/>` +
        `<polygon points="${cx - 330},${cy - 60} ${cx - 250},${cy - 170} ${cx + 410},${cy - 170} ${cx + 330},${cy - 60}" fill="${ink}" fill-opacity="0.6" stroke="#2b2118" stroke-width="8"/>` +
        `<polygon points="${cx + 330},${cy - 60} ${cx + 410},${cy - 170} ${cx + 410},${cy + 80} ${cx + 330},${cy + 190}" fill="${ink}" fill-opacity="0.4" stroke="#2b2118" stroke-width="8"/>` +
        [0, 1, 2, 3]
          .map(
            (index) =>
              `<polygon points="${cx - 330 + index * 165},${cy - 60} ${cx - 290 + index * 165},${cy + 40} ${cx - 250 + index * 165},${cy - 60}" fill="#2b2118" fill-opacity="0.55"/>`,
          )
          .join('')
      );
    default:
      return '';
  }
}

/**
 * @param {import('opentype.js').Font} font
 * @param {SeedPhoto} photo
 * @returns {string} The picture as SVG: a coloured background, a motif and the title.
 */
function seedScene(font, photo) {
  const { width, height } = PHOTO_SIZE;
  const label = 'PLACEHOLDER PHOTO';
  const labelSize = fitSize(font, label, 54, width - 200);
  const titleSize = fitSize(font, photo.title, 130, width - 200);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${photo.sky[0]}"/><stop offset="1" stop-color="${photo.sky[1]}"/></linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#sky)"/>` +
    motifShapes(photo.motif, photo.ink, width, height) +
    `<path d="${centeredPath(font, photo.title, titleSize, width / 2, height * 0.74)}" fill="#ffffff"/>` +
    `<path d="${centeredPath(font, label, labelSize, width / 2, height * 0.88)}" fill="${photo.ink}"/>` +
    '</svg>'
  );
}

/**
 * @param {number[]} parts Degrees, minutes, seconds.
 * @param {number} offset Arc seconds to add.
 * @returns {string} The rational form that the EXIF writer takes.
 */
function dms(parts, offset) {
  return `${parts[0]}/1 ${parts[1]}/1 ${parts[2] + offset}/1`;
}

/**
 * @param {SeedPhoto} photo
 * @param {number} index Place of the photo in the list; it moves the position by a few arc seconds.
 * @returns {Record<string, Record<string, string>>} The EXIF data to write.
 */
function seedExif(photo, index) {
  const place = PLACES[photo.place];
  return {
    IFD0: { ...CAMERA },
    IFD3: {
      GPSLatitudeRef: place.latitudeRef,
      GPSLatitude: dms(place.latitude, index),
      GPSLongitudeRef: place.longitudeRef,
      GPSLongitude: dms(place.longitude, index),
    },
  };
}

/**
 * Makes the seed photos.
 *
 * @param {object} [options]
 * @param {string} [options.root] The repository whose theme font is used.
 * @returns {Promise<Map<string, Buffer>>} The bytes of each photo, by its path from the repository root.
 */
export async function renderSeedPhotos({ root = defaultRoot } = {}) {
  const font = loadFont(join(root, 'themes', 'ba3a', 'fonts', 'Manrope-Bold.ttf'));
  /** @type {Map<string, Buffer>} */
  const photos = new Map();
  for (const [index, photo] of SEED_PHOTOS.entries()) {
    const bytes = await sharp(Buffer.from(seedScene(font, photo)), { density: 72 })
      .jpeg({ quality: PHOTO_QUALITY, mozjpeg: false, progressive: false, chromaSubsampling: '4:2:0', optimiseCoding: false })
      .withExif(seedExif(photo, index))
      .toBuffer();
    photos.set(photo.path, bytes);
  }
  return photos;
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Writes a file through a temporary name, so that an interrupted run leaves no half file.
 *
 * @param {string} target
 * @param {Buffer} bytes
 */
function writeNew(target, bytes) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), '.seed-photo.part');
  writeFileSync(temporary, bytes);
  renameSync(temporary, target);
}

/**
 * Writes the seed photos that do not exist yet. A file that exists is left alone, whatever it contains,
 * so a real photograph that took the place of a placeholder is never overwritten.
 *
 * @param {object} [options]
 * @param {string} [options.root] The repository root.
 * @returns {Promise<{ written: string[], present: string[] }>}
 */
export async function createSeedPhotos({ root = defaultRoot } = {}) {
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const present = [];
  for (const [path, bytes] of await renderSeedPhotos()) {
    const target = join(root, ...path.split('/'));
    if (existsSync(target)) {
      present.push(path);
      continue;
    }
    writeNew(target, bytes);
    written.push(path);
  }
  return { written, present };
}

/**
 * Brings back the seed photos that a clean checkout lacks, as far as the lock file lists them: a photo is
 * written only when it is missing, the lock lists its path, and the generated bytes are exactly what the
 * lock says (hash and size). A photo whose entry is not in the lock was deleted on purpose and stays
 * deleted. Nothing is written when any photo that has to be restored does not match its entry.
 *
 * @param {object} [options]
 * @param {string} [options.root] The repository root; its media.lock.json is read.
 * @returns {Promise<{ written: string[], present: string[], skipped: string[] }>}
 */
export async function restoreSeedPhotos({ root = defaultRoot } = {}) {
  const lockPath = join(root, 'media.lock.json');
  const entries = new Map(existsSync(lockPath) ? parseLock(readFileSync(lockPath, 'utf8')).map((entry) => [entry.path, entry]) : []);
  /** @type {string[]} */
  const written = [];
  /** @type {string[]} */
  const present = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {Array<[string, Buffer]>} */
  const pending = [];
  for (const [path, bytes] of await renderSeedPhotos()) {
    const entry = entries.get(path);
    if (entry === undefined) {
      skipped.push(path);
    } else if (existsSync(join(root, ...path.split('/')))) {
      present.push(path);
    } else if (entry.sha256 !== sha256Of(bytes) || entry.size !== bytes.length) {
      throw new Error(
        `${path} does not match the lock: media.lock.json says ${entry.sha256} (${entry.size} bytes) but the generator makes ${sha256Of(bytes)} (${bytes.length} bytes). Pull the original with "coffer media pull" instead.`,
      );
    } else {
      pending.push([path, bytes]);
    }
  }
  for (const [path, bytes] of pending) {
    writeNew(join(root, ...path.split('/')), bytes);
    written.push(path);
  }
  return { written, present, skipped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--photos' && flag !== '--restore-photos')) {
    console.error('Usage: node scripts/make-placeholders.mjs [--photos | --restore-photos]');
    process.exit(2);
  }
  if (flags.includes('--restore-photos')) {
    try {
      const { written, present, skipped } = await restoreSeedPhotos();
      for (const file of written) console.log(`restored ${file}`);
      console.log(`seed photos: ${written.length} restored, ${present.length} present, ${skipped.length} not in the lock`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    const { written, unchanged } = await writePlaceholders();
    for (const file of written) console.log(`wrote ${file}`);
    console.log(`${written.length} written, ${unchanged.length} unchanged`);
    if (flags.includes('--photos')) {
      const photos = await createSeedPhotos();
      for (const file of photos.written) console.log(`wrote ${file}`);
      console.log(`seed photos: ${photos.written.length} written, ${photos.present.length} already present (run "coffer media lock" to record them)`);
    }
  }
}
