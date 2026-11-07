# Theme of ba3a.dev

The crisp, professional look of `ba3a.dev`: a cool slate palette with one teal
accent, Manrope for headings and the site name, and a compact header with the
site name as a wordmark. It changes only what it has to; everything else is
coffer's default theme (see `github.com/ba3a/coffer/blob/v0.1.0/docs/themes.md`).

| File | What it does |
| --- | --- |
| `assets/ba3a.css` | Overrides coffer's colour and font custom properties for light and dark (`prefers-color-scheme` and the theme switch), declares the web font, and styles the compact header. |
| `templates/base.njk` | `{% extends "coffer:base.njk" %}`. Overrides the `head` block (with `super()`, to add the stylesheet and the font preload) and the `nav` block of the header. The wordmark and the theme switch are the engine's own markup, restyled by the stylesheet. No other template is replaced. |
| `theme.yaml`, `card.svg.njk`, `fonts/` | The title card for link previews: dark slate with the site accent, set in Manrope Bold. |
| `assets/fonts/` | The self-hosted Manrope web font files, the license texts of Manrope and of Handjet (`OFL.txt`, `OFL-Handjet.txt`). The Handjet font file itself is in the Faultory project folder. |

The stylesheet also turns off synthetic bold on the game page (`.game-page`), which has the display font described under [Handjet](#handjet-the-page-of-faultory).

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

Manrope, weight 700 (Bold), is the only font file of the theme, and the only one that pages load, except the page of Faultory, which also loads Handjet (see below).

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

## Handjet, the page of Faultory

The page of a game may set its own accent colour and display font (see
`github.com/ba3a/coffer/blob/v0.1.0/docs/projects.md`). Faultory uses Handjet Bold for its headings and
buttons. coffer publishes a project's font file only from the project's own
folder (a font from the theme is not supported), so the font is **not** in this
theme: it sits in `content/ba3a.dev/projects/faultory/`, is declared there by
`displayFont` and `displayFontFile` in `project.yaml`, and the engine writes the
`@font-face` rule (with `font-display: swap`) into that page only. The headings
fall back to this theme's heading font (Manrope, then the system sans-serif) while
the font loads or if it does not. The only thing the theme adds is the rule in
`assets/ba3a.css` that keeps the browser from drawing a second, synthetic bold on
top of the font's own bold.

- Designer and license: The Handjet Project Authors, SIL Open Font License 1.1,
  `Copyright 2018 The Handjet Project Authors (https://github.com/rosettatype/Handjet/)`.
  No Reserved Font Name is declared. The license text is
  `assets/fonts/OFL-Handjet.txt` in this theme, the `LICENSE` file of the package
  below, unchanged. It is the single copy: the theme publishes it at
  `/assets/fonts/OFL-Handjet.txt` (the engine publishes only the font file from a
  project folder), and the credit on the page of Faultory links to it, so the
  license text is shipped with the font software, as the OFL requires.
- Upstream: <https://github.com/rosettatype/Handjet>.
- Source of the file: the npm package `@fontsource/handjet` version 5.3.1
  (<https://www.npmjs.com/package/@fontsource/handjet>, tarball
  `https://registry.npmjs.org/@fontsource/handjet/-/handjet-5.3.1.tgz`), pinned in
  the root `package.json`. The file is copied unchanged: it is the latin subset,
  weight 700, of the package.

| Shipped file | Taken from | sha256 |
| --- | --- | --- |
| `content/ba3a.dev/projects/faultory/handjet-latin-700.woff2` | `files/handjet-latin-700-normal.woff2` | `b4039772149a10e5b1c184ad92431cb010ec81ff81fb3db39bc78ebe1108af88` |
| `themes/ba3a/assets/fonts/OFL-Handjet.txt` | `LICENSE` | `33da8fa576faeeb46d111ad12328e30b07ab059b13d6a0f77c562b5e6ce8e3ee` |

The wordmark of Faultory (`logo.svg`, `card.svg`, `key-art.svg`) is drawn by
`scripts/make-placeholders.mjs`, which converts the text to outlines with the
`files/handjet-latin-700-normal.woff` file of the same package. These pictures are
placeholders.

## Copy

This theme has no marketing copy of its own; the site name comes from `title` in
`coffer.yaml`. If a tagline or other text is added to the header or the card,
mark it `TODO: rewrite` until it is final.
