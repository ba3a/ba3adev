// Helpers for the theme tests: WCAG 2.x contrast ratios and a small reader for
// the custom properties a theme stylesheet sets. Nothing here knows a colour of
// the ba3a.dev theme; the tests derive every value from the stylesheet itself.

/**
 * @param {string} colour `#rgb` or `#rrggbb`.
 * @returns {[number, number, number]} Red, green and blue, 0 to 255.
 */
export function parseHex(colour) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (!match) throw new Error(`not a hex colour: ${JSON.stringify(colour)}`);
  let digits = match[1];
  if (digits.length === 3) digits = [...digits].map((digit) => digit + digit).join('');
  const value = Number.parseInt(digits, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Relative luminance as defined by WCAG 2.x.
 *
 * @param {string} colour `#rgb` or `#rrggbb`.
 * @returns {number} 0 for black, 1 for white.
 */
export function relativeLuminance(colour) {
  const [red, green, blue] = parseHex(colour).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * @param {string} first
 * @param {string} second
 * @returns {number} The contrast ratio, from 1 to 21.
 */
export function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Splits CSS into the rules that matter to a theme and returns, for each rule
 * whose selector list is exactly `selector`, the custom properties it declares.
 * Only top-level rules and the rules directly inside one `@media` block are read;
 * comments are ignored.
 *
 * @param {string} css
 * @returns {Array<{ media: string | null, selector: string, declarations: Record<string, string> }>}
 */
export function readRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {Array<{ media: string | null, selector: string, declarations: Record<string, string> }>} */
  const rules = [];
  /** @type {Array<{ kind: 'media' | 'rule', head: string, body: string }>} */
  const stack = [];
  let buffer = '';
  for (const character of source) {
    if (character === '{') {
      stack.push({ kind: buffer.trim().startsWith('@media') ? 'media' : 'rule', head: buffer.trim(), body: '' });
      buffer = '';
    } else if (character === '}') {
      const closed = stack.pop();
      if (!closed) throw new Error('unbalanced braces in the stylesheet');
      if (closed.kind === 'rule') {
        const parent = stack.at(-1);
        const declarations = readDeclarations(closed.body + buffer);
        rules.push({
          media: parent ? parent.head.replace(/^@media\s*/, '') : null,
          selector: closed.head.replace(/\s+/g, ' '),
          declarations,
        });
      }
      buffer = '';
    } else if (stack.length > 0 && stack.at(-1)?.kind === 'rule') {
      /** @type {{ body: string }} */ (stack.at(-1)).body += character;
    } else {
      buffer += character;
    }
  }
  if (stack.length > 0) throw new Error('unbalanced braces in the stylesheet');
  return rules;
}

/**
 * @param {string} body
 * @returns {Record<string, string>}
 */
function readDeclarations(body) {
  /** @type {Record<string, string>} */
  const declarations = {};
  for (const part of body.split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    declarations[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return declarations;
}

/**
 * The custom properties a theme stylesheet sets for each colour scheme, found
 * in the same four places as in the engine's stylesheet (see docs/themes.md):
 * `:root` (light), `@media (prefers-color-scheme: dark) :root`,
 * `:root[data-theme="dark"]` and `:root[data-theme="light"]`.
 *
 * @param {string} css
 * @returns {{ light: Record<string, string>, darkMedia: Record<string, string>, darkChoice: Record<string, string>, lightChoice: Record<string, string> }}
 */
export function readSchemes(css) {
  const rules = readRules(css);
  /**
   * @param {string | null} media
   * @param {string} selector
   */
  const pick = (media, selector) => {
    const found = rules.filter((rule) => rule.media === media && rule.selector === selector);
    if (found.length !== 1) {
      throw new Error(`expected exactly one rule "${selector}"${media ? ` in @media ${media}` : ''}, found ${found.length}`);
    }
    return found[0].declarations;
  };
  return {
    light: pick(null, ':root'),
    darkMedia: pick('(prefers-color-scheme: dark)', ':root'),
    darkChoice: pick(null, ':root[data-theme="dark"]'),
    lightChoice: pick(null, ':root[data-theme="light"]'),
  };
}
