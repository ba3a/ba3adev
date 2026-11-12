// Reusable assertions about the page frame of a theme: the header, the main
// element and the footer must be one column, with the same left and right edges.
// The build has no layout engine, so these read the rules of the stylesheet.
import assert from 'node:assert/strict';

import { readRules } from './wcag.mjs';

/** The three elements that make up the frame of a page. */
export const FRAME_ELEMENTS = ['.site-header', '.site-footer', 'main'];

/** Properties that decide the width and the side position of an element: the "width group". */
const WIDTH_GROUP = /^(width|min-width|max-width|margin|margin-inline|margin-inline-start|margin-inline-end|margin-left|margin-right)$/;

/** Properties that give an element side padding. */
const SIDE_PADDING = /^(padding|padding-inline|padding-inline-start|padding-inline-end|padding-left|padding-right)$/;

/** Units that are resolved in the font size of the element they are used on. */
const OWN_FONT_UNITS = /[\d.](ch|em|ex|cap|ic|lh)\b/;

/**
 * @typedef {{ media: string | null, selector: string, declarations: Record<string, string> }} Rule
 */

/** @param {string} selectors A selector list. @returns {string[]} */
export function selectorParts(selectors) {
  return selectors.split(',').map((part) => part.trim());
}

/**
 * The frame element a selector part ends in, or null when it styles something
 * else (`main > *`, `.site-header nav`).
 *
 * @param {string} part
 * @returns {string | null}
 */
function frameElementOf(part) {
  return FRAME_ELEMENTS.find((element) => part === element || part.endsWith(` ${element}`)) ?? null;
}

/**
 * @param {Rule} rule
 * @param {string[]} exceptions
 * @returns {boolean} True when the rule belongs to one of the explicit exceptions.
 */
function isException(rule, exceptions) {
  return exceptions.some((exception) => rule.selector.includes(exception));
}

/**
 * Collects the rules that touch a frame element, with the element each selector
 * part names.
 *
 * @param {Rule[]} rules
 * @param {string[]} exceptions
 * @returns {Array<{ rule: Rule, element: string, prefix: string }>}
 */
function frameRules(rules, exceptions) {
  /** @type {Array<{ rule: Rule, element: string, prefix: string }>} */
  const found = [];
  for (const rule of rules) {
    if (isException(rule, exceptions)) continue;
    for (const part of selectorParts(rule.selector)) {
      const element = frameElementOf(part);
      if (element) found.push({ rule, element, prefix: part.slice(0, part.length - element.length).trim() });
    }
  }
  return found;
}

/**
 * Header, main and footer appear together in every rule that sets a width group.
 * Returns the groups, so that a caller can make further assertions about them.
 *
 * @param {Rule[]} rules
 * @param {string[]} exceptions
 * @returns {Map<string, Set<string>>} Key: media, selector prefix and the width declarations.
 */
export function assertOneWidthGroup(rules, exceptions) {
  /** @type {Map<string, Set<string>>} */
  const groups = new Map();
  for (const { rule, element, prefix } of frameRules(rules, exceptions)) {
    const width = Object.entries(rule.declarations).filter(([property]) => WIDTH_GROUP.test(property));
    if (width.length === 0) continue;
    const key = `${rule.media ?? ''}|${prefix}|${width.map(([property, value]) => `${property}:${value}`).sort().join(';')}`;
    groups.set(key, (groups.get(key) ?? new Set()).add(element));
  }
  for (const [key, elements] of groups) {
    assert.deepEqual([...elements].sort(), [...FRAME_ELEMENTS].sort(), `"${key}" sets the width of the header, main and the footer together`);
  }
  return groups;
}

/**
 * No width of the footer is in a unit that depends on the footer's own font size.
 * The footer has a smaller font than the page, so such a width would not match the
 * header and main.
 *
 * @param {Rule[]} rules
 * @param {string[]} exceptions
 */
export function assertFooterWidthIndependentOfFont(rules, exceptions) {
  for (const { rule, element } of frameRules(rules, exceptions)) {
    if (element !== '.site-footer') continue;
    for (const [property, value] of Object.entries(rule.declarations)) {
      if (!WIDTH_GROUP.test(property) && !SIDE_PADDING.test(property)) continue;
      assert.ok(!OWN_FONT_UNITS.test(value), `${rule.selector} { ${property}: ${value} } depends on the footer's own font size`);
    }
  }
}

/**
 * The header, main and the footer have no side padding, so the rules at their
 * edges end where the text ends.
 *
 * @param {Rule[]} rules
 * @param {string[]} exceptions
 */
export function assertNoSidePadding(rules, exceptions) {
  const unpadded = new Set();
  for (const { rule, element } of frameRules(rules.filter((candidate) => candidate.media === null), exceptions)) {
    for (const [property, value] of Object.entries(rule.declarations)) {
      if (!SIDE_PADDING.test(property)) continue;
      assert.match(value, /^0(px|rem)?( 0(px|rem)?)*$/, `${rule.selector} { ${property}: ${value} } gives ${element} side padding`);
      if (property === 'padding-inline') unpadded.add(element);
    }
  }
  assert.deepEqual([...unpadded].sort(), [...FRAME_ELEMENTS].sort(), 'padding-inline is 0 on the header, main and the footer');
}

/**
 * All the frame assertions.
 *
 * @param {string} css The stylesheet of the theme.
 * @param {{ exceptions: string[] }} options Selectors (or parts of selectors) of the
 *   rules that may differ from the frame, such as the table of contents or a
 *   landing page. Pass them explicitly; an empty list means there are none.
 * @returns {Map<string, Set<string>>} The width groups.
 */
export function assertFrame(css, { exceptions }) {
  assert.ok(Array.isArray(exceptions), 'the exceptions are passed in explicitly, as a list');
  const rules = readRules(css);
  const groups = assertOneWidthGroup(rules, exceptions);
  assertFooterWidthIndependentOfFont(rules, exceptions);
  assertNoSidePadding(rules, exceptions);
  return groups;
}
