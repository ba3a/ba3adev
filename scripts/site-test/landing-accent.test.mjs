// The inline style of the .landing wrapper (themes/ba3a/templates/partials/landing-accent.njk).
// Its values come from the front matter of a file in another repository and go into a `style`
// attribute, so only listed keys with a hex colour may get through. No build is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import nunjucks from 'nunjucks';

const templates = join(fileURLToPath(new URL('../..', import.meta.url)), 'themes', 'ba3a', 'templates');
const environment = new nunjucks.Environment(new nunjucks.FileSystemLoader(templates), { autoescape: true });

/** @param {unknown} landing `project.landing`. @returns {string} The style of the wrapper. */
function style(landing) {
  return environment.renderString('{% from "partials/landing-accent.njk" import accentStyle %}{{ accentStyle(landing) }}', { landing }).trim();
}

test('a hex colour of a listed key becomes a custom property of its scheme', () => {
  assert.equal(
    style({ accent: { light: { accent: '#9a6b1f', 'accent-text': '#7C5516', 'accent-soft': '#fc0' }, dark: { accent: '#d9a84e', 'term-accent': '#e0b25c', 'on-accent': '#121114' } } }),
    '--accent-light-accent:#9a6b1f;--accent-light-accent-text:#7C5516;--accent-light-accent-soft:#fc0;--accent-dark-accent:#d9a84e;--accent-dark-term-accent:#e0b25c;--accent-dark-on-accent:#121114',
  );
});

test('a landing without accent, or with a malformed one, has no style at all', () => {
  for (const landing of [undefined, null, {}, { layout: {} }, { accent: null }, { accent: 'red' }, { accent: ['#fff'] }, { accent: { light: 'red', dark: null } }]) {
    assert.equal(style(landing), '', JSON.stringify(landing));
  }
});

test('a value that is not a plain hex colour is left out, so it cannot add CSS or break out of the attribute', () => {
  const bad = [
    'red',
    'rgb(0, 0, 0)',
    'var(--x)',
    '#12',
    '#1234',
    '#12345',
    '#1234567',
    '#ggg',
    '#fff;background:url(//evil.example/x)',
    '#fff"><script>alert(1)</script>',
    '#fff" onload="alert(1)',
    '#fff\n;color:red',
    '#fff\n',
    '#fff !important',
    ' #fff',
    '#fff ',
    '',
    12,
    true,
    null,
    ['#fff'],
    { value: '#fff' },
  ];
  for (const value of bad) {
    assert.equal(style({ accent: { light: { accent: value }, dark: { 'accent-text': value } } }), '', JSON.stringify(value));
  }
  // One bad value does not take the good ones with it.
  assert.equal(style({ accent: { light: { accent: '#fff;x:y', 'accent-text': '#123456' } } }), '--accent-light-accent-text:#123456');
});

test('a key that is not listed is left out, whatever its value', () => {
  assert.equal(style({ accent: { light: { bg: '#000000', 'accent;color': '#fff', '--accent': '#fff', constructor: '#fff', __proto__: '#fff' }, other: { accent: '#fff' } } }), '');
});
