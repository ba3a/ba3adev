// The accent palette of a landing page, as the browser resolves it: the front
// matter of the landing file gives --accent-light-<key> and --accent-dark-<key>
// on the wrapper (themes/ba3a/templates/partials/landing-accent.njk), and
// themes/ba3a/assets/landing.css picks the pair of the scheme with the palette
// it keeps as the fallback. The contrast tests of the landing pages use this to
// check the colours the page really shows, from the file that was fetched.
import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

/**
 * @param {string} path A landing file (`.cache/repos/{slug}/site/landing.md`).
 * @returns {Record<string, any>} Its front matter.
 */
export function readFrontMatter(path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(readFileSync(path, 'utf8'));
  if (!match) throw new Error(`${path} has no front matter`);
  return parseYaml(match[1]);
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * @param {Record<string, string>} declarations The custom properties of a palette rule of landing.css.
 * @param {Record<string, any> | undefined} accent `accent` of the front matter, or nothing.
 * @param {'light' | 'dark'} scheme
 * @returns {Record<string, string>} The same, with every `var(--accent-<scheme>-<key>, fallback)` replaced by the
 *   value of the front matter when it is a hex colour, and by the fallback otherwise.
 */
export function resolveAccent(declarations, accent, scheme) {
  const given = accent && typeof accent === 'object' && accent[scheme] && typeof accent[scheme] === 'object' ? accent[scheme] : {};
  return Object.fromEntries(Object.entries(declarations).map(([name, value]) => [
    name,
    value.replace(/^var\(--accent-(light|dark)-([a-z-]+),\s*([^)]+)\)$/, (_all, wanted, key, fallback) => {
      if (wanted !== scheme) throw new Error(`${name} reads the ${wanted} palette in the ${scheme} scheme`);
      return typeof given[key] === 'string' && HEX.test(given[key]) ? given[key] : fallback;
    }),
  ]));
}
