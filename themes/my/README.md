# Theme of my.ba3a.dev

The warm, personal look of `my.ba3a.dev`: paper-coloured pages with brown ink and
a terracotta accent (and a dark brown page with a lighter terracotta in the dark
scheme), the Literata serif for headings and text, and a centred header with the
site title above a short tagline. It is meant to be told apart from `ba3a.dev`
(cool slate, teal, Manrope, a compact header with a wordmark) at a glance, not
only by language. It changes only what it has to; everything else is coffer's
default theme (see `github.com/ba3a/coffer/blob/v0.1.0/docs/themes.md`).

| File | What it does |
| --- | --- |
| `assets/my.css` | Overrides coffer's colour and font custom properties for light and dark (`prefers-color-scheme` and the theme switch), declares the web fonts, arranges the centred header and styles the 404 page. |
| `templates/base.njk` | `{% extends "coffer:base.njk" %}`. Overrides the `head` block (with `super()`, to add the stylesheet and the font preloads) and the `nav` block of the header. No other template or block is replaced. |
| `i18n/ru.yaml` | The tagline of the header and the copy of the 404 page. |
| `theme.yaml`, `card.svg.njk`, `fonts/` | The title card for link previews: warm paper in a thin terracotta frame, set in Literata Bold. |
| `assets/fonts/` | The self-hosted web font files and their license. |

## Colours

The palette is defined once, in `assets/my.css`. Every colour pair that the
engine's components and this theme's own rules use (body, muted and link text,
text on an accent button, code, control borders, the focus outline, the tagline,
the navigation and the 404 page) is checked for WCAG 2.x AA contrast in light and
dark by `scripts/site-test/my-theme.test.mjs`, which reads the values from the
stylesheet. Change a colour there and `npm run test:sites` tells you whether it
still passes. The stylesheet has no colour of its own outside the two schemes and
the print rule; a test enforces that.

| Role | Light | Dark |
| --- | --- | --- |
| Page | `#fbf6ec` | `#1d1813` |
| Text | `#2a2018` | `#efe5d6` |
| Muted text | `#6a5846` | `#bcab96` |
| Accent | `#a4401e` | `#e8936a` |

## Header and navigation

Coffer's `header` block holds the site title, a `nav` block and the theme switch.
Overriding `header` as a whole would mean redeclaring the nested blocks (and, with
Nunjucks, losing the theme switch), so the theme overrides only `nav`. Its first
element is the tagline, `<p class="site-tagline">`, followed by the navigation
list. The stylesheet makes the header a centred, wrapping flex row: the title and
the tagline each take a full row, and the navigation and the theme switch share a
centred row below. The engine's skip link, landmarks and theme switch are kept as
they are.

Because the header is centred, the column of text is centred under it too, once and
as a whole: the header, `main` and the footer get one shared width (the engine's
measure plus the side padding) and the engine centres each of them. The children of
`main` are not centred one by one (the engine caps each child at the measure in `ch`,
which depends on the child's own font size, so every child would get a different
indent); they fill the column and share its left edge. A post with a table of
contents (and a documentation page with its sidebar) needs a second column, so on
those pages the three elements get the engine's wide width together. The footer has
the same double rule as the header.

The navigation lists what coffer builds for the page, except the entries that lead
home (the home link and the blog at the root, because the site title already links
home). The site has no projects, so there is no project navigation. What remains is
the search. The tag tree is linked from the blog index.

## The 404 page

`404.njk` is coffer's own. The theme replaces its three strings in `i18n/ru.yaml`
(`not_found.title`, `not_found.text` and `not_found.home`) and styles the
`.not-found` article in `assets/my.css`: a centred block with a short accent rule
above the heading and the way back as a button. The other Russian UI strings are
coffer's own.

## Fonts

Literata, in three styles (regular, italic, bold) and three subsets each: Latin,
Cyrillic and Cyrillic extended. The stylesheet splits the faces by `unicode-range`
so a page downloads only the subsets it uses, and declares them with
`font-display: swap` and a serif fallback stack (Noto Serif, PT Serif, Georgia).
The pages preload the Cyrillic regular and bold files, which every page of this
site uses. The web fonts weigh about 107 KB in total.

- Designer and license: The Literata Project Authors, SIL Open Font License 1.1.
  The copyright line and the license text are in `assets/fonts/OFL.txt` and
  `fonts/OFL.txt` (the `LICENSE` file of the npm package). The copyright notice
  declares no Reserved Font Name, so the converted card font below may keep the
  family name "Literata".
- Upstream: <https://github.com/googlefonts/literata>.
- Source of the files: the npm package `@fontsource/literata` version 5.3.0
  (<https://www.npmjs.com/package/@fontsource/literata>; tarball
  `fontsource-literata-5.3.0.tgz`, SHA-256
  `b9335958dc362b0e7e4268098550bc0cb93ab4c68a2db9bc48c67154abbd75c9`), copied
  unchanged from its `files/` folder. The file names are the package's, with the
  `-normal` or `-italic` suffix kept.
- `fonts/Literata-Bold.ttf` is for the title cards only: the card renderer does
  not read woff2. It is the three bold woff2 files below (Latin, Cyrillic,
  Cyrillic extended) decompressed to TrueType and merged into one file with
  fontTools 4.25 (`fontTools.merge`); no glyph is changed. It is not served on the
  site. It covers the Latin and Cyrillic letters of the Russian site (a test
  checks the whole Russian alphabet), which the Latin-only card font of
  `ba3a.dev` would not.
- The pages load no font from another host.

| File | SHA-256 |
| --- | --- |
| `assets/fonts/literata-latin-400-normal.woff2` | `a60c193b55766b68b922e2327e15c2d8c145532f283a27c3411b9c47a8583d18` |
| `assets/fonts/literata-latin-400-italic.woff2` | `1e98bfbbb4eb8177b9c21b3fd526e1118c4835d21ff870c0d1c25b1ef4409fba` |
| `assets/fonts/literata-latin-700-normal.woff2` | `1f2985e0fc368aac76f95b847cd05ef6ec4bac2733a648098c62edf990756cf5` |
| `assets/fonts/literata-cyrillic-400-normal.woff2` | `39bb5c343c21e6a4b29fef83c0b909d2c80fd9084d46c981b742b1dac54663d0` |
| `assets/fonts/literata-cyrillic-400-italic.woff2` | `8bb34e53cef46b327609dd3d9ac6b1f0fda14855a241fe36baabb763f2e1ca51` |
| `assets/fonts/literata-cyrillic-700-normal.woff2` | `d3414d99a6c9bbcf9b4a2ae8a177e0f656ac162f0c8755155373268415989505` |
| `assets/fonts/literata-cyrillic-ext-400-normal.woff2` | `0ef2d13c7c6ab91431435107873e76f218c891236db8496b2155acbbc62d565a` |
| `assets/fonts/literata-cyrillic-ext-400-italic.woff2` | `0febea0fb80fb68d530344cc5ca01edee920c7b8443fdecd3ef83ac933204ba9` |
| `assets/fonts/literata-cyrillic-ext-700-normal.woff2` | `627cbc065a640799c5e4d09c49c0bf558cc0e44e92002ad7f6c9aa070429be64` |
| `fonts/Literata-Bold.ttf` (derived, see above) | `dec0f8ffb2eb55f3cbd2f8692ed951de1e2f6749256a002262d63990d3debc00` |

Bold italic is not shipped; the browser draws it from the italic with a synthetic
bold, which is rare in running text. The Latin extended subset is left out too, as
the site is Russian; characters outside the shipped ranges fall back to the system
serif.

## Copy

The copy written for the author is a first draft and is marked `TODO: rewrite`
in the files that hold it: the tagline (`site.tagline`) and the 404 text
(`not_found.*`) in `i18n/ru.yaml`. The site name and description come from
`coffer.yaml`.
