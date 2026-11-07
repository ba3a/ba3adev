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
//     `logo` and `keyArt` accept only JPEG, PNG, WebP and HEIC (coffer/docs/projects.md),
//     so the SVG cannot be named there.
//
// The script is deterministic: it uses no clock and no random numbers, so
// running it again writes byte-identical files, and a file whose content has not
// changed is not touched. The fonts are the theme's Manrope Bold (cards of the
// tools) and Handjet Bold from the pinned `@fontsource/handjet` devDependency
// (the Faultory wordmark); opentype.js reads the outlines.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import opentype from 'opentype.js';
import sharp from 'sharp';
import { parse as parseYaml } from 'yaml';

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
 * The tools: the slug of the project folder, the name written on the card and
 * the colours (the text must stay readable on the background).
 *
 * @type {ReadonlyArray<{ slug: string, name: string, background: string, band: string, text: string }>}
 */
export const TOOL_CARDS = Object.freeze([
  { slug: 'specloop', name: 'specloop', background: '#16365c', band: '#7fb6ff', text: '#ffffff' },
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { written, unchanged } = await writePlaceholders();
  for (const file of written) console.log(`wrote ${file}`);
  console.log(`${written.length} written, ${unchanged.length} unchanged`);
}
