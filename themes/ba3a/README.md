# Theme of ba3a.dev

The crisp, professional look of `ba3a.dev`: a cool slate palette with one teal
accent, Manrope for headings and the site name, and a compact header with the
site name as a wordmark. It changes only what it has to; everything else is
coffer's default theme (see `coffer/docs/themes.md`).

| File | What it does |
| --- | --- |
| `assets/ba3a.css` | Overrides coffer's colour and font custom properties for light and dark (`prefers-color-scheme` and the theme switch), declares the web font, and styles the compact header. |
| `templates/base.njk` | `{% extends "coffer:base.njk" %}`. Overrides the `head` block (with `super()`, to add the stylesheet and the font preload) and the `nav` block of the header. The wordmark and the theme switch are the engine's own markup, restyled by the stylesheet. No other template is replaced. |
| `theme.yaml`, `card.svg.njk`, `fonts/` | The title card for link previews: dark slate with the site accent, set in Manrope Bold. |
| `assets/fonts/` | The self-hosted web font files and their license. |

UI strings are coffer's English defaults; this theme has no `i18n/` folder.

## Colours

The palette is defined once, in `assets/ba3a.css`. Every colour pair that the
engine's components use (body, muted and link text, text on an accent button,
code, control borders, the focus outline) is checked for WCAG 2.x AA contrast in
light and dark by `scripts/site-test/ba3a-theme.test.mjs`, which reads the
values from the stylesheet. Change a colour there and `npm run test:sites` tells
you whether it still passes.

## Navigation

The header lists the links in the `nav` that coffer builds for the page, except
the home link, because the wordmark already links home. The Projects entry
therefore appears as soon as the site has projects (`projects` in `coffer.yaml`)
and links to the projects index, and a site without projects has no link to a
page that does not exist.

## Fonts

Manrope, weight 700 (Bold), is the only font file the pages load.

- Designer and license: The Manrope Project Authors, SIL Open Font License 1.1.
  The license text and copyright line are in `assets/fonts/OFL.txt` and
  `fonts/OFL.txt`.
- Upstream: <https://github.com/sharanda/manrope>.
- Source of the files: the npm package `@fontsource/manrope` version 5.3.0
  (<https://www.npmjs.com/package/@fontsource/manrope>), files
  `files/manrope-latin-700-normal.woff2` and
  `files/manrope-latin-ext-700-normal.woff2`, copied unchanged to
  `assets/fonts/manrope-latin-700.woff2` and `assets/fonts/manrope-latin-ext-700.woff2`.
  `OFL.txt` is the `LICENSE` file of that package.
- `fonts/Manrope-Bold.ttf` is for the title cards only: the card renderer does
  not read woff2. It is the two woff2 files above converted to TrueType and merged
  into one file with fontTools 4.25 (`fontTools.merge`); no glyph is changed. It
  is not served on the site.
- The pages load no font from another host. The font is declared with
  `font-display: swap` and a system sans-serif fallback stack.

## Copy

This theme has no marketing copy of its own; the site name comes from `title` in
`coffer.yaml`. If a tagline or other text is added to the header or the card,
mark it `TODO: rewrite` until it is final.
