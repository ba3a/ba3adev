#!/usr/bin/env node
// Generates the reference of specloop for coffer, in coffer's `json` reference
// format (see coffer/docs/project-docs.md, "The output").
//
// Usage: node specloop-reference.mjs <repo> <out>
//
//   <repo>  a checkout of the specloop repository (read only)
//   <out>   an existing or new folder; the generator writes `reference.json`
//           in it and nothing else
//
// coffer runs it from the `reference` block of the project's `project.yaml`:
//
//   command: [node, "{site}/generators/specloop-reference.mjs", "{repo}", "{out}"]
//   format: json
//   output: "{out}/reference.json"
//
// WHAT IS LISTED
//
//   Slash commands. One item for every `kit/commands/*.md`. The name is the
//   file name without `.md`, shown with the default prefix, which is the value
//   of `commandPrefix` in `kit/specloop/defaults.json` (`/sl-go`). The
//   description is the `description` of the file's front matter, followed by a
//   note that the prefix is configurable. The signature adds `argument-hint`
//   when the front matter has one. The front matter is read by a small parser
//   of this file (single-line `key: value` entries with plain, 'single' or
//   "double" quoted values, and `|` / `>` block scalars), not by a YAML
//   library, so nothing from the repository is interpreted as YAML.
//
//   Configuration keys. One item for every key of `defaults.json`, at every
//   depth, named by its dotted path. The flattening rule:
//     * an object with at least one key is a group: it gets an item of its own
//       (kind "configuration group") and its keys are flattened with the
//       group's path as prefix;
//     * everything else is a value (kind "configuration key") with its default:
//       a string, number, boolean, null, an array (not looked into) or an empty
//       object;
//     * an object with names chosen by the user (the phases of `phases`) is not
//       recognised as such: defaults.json names its members, so they are keys.
//   Two different keys with the same dotted path (`{"a.b": 1, "a": {"b": 2}}`)
//   are an error.
//
//   Environment variables. The names that `kit/specloop/engine.py` reads, found
//   by a text scan of these forms (comment lines are skipped, the rest of the
//   file is not parsed):
//       environ.get("NAME" ...)     os.environ.get("NAME" ...)
//       environ["NAME"]             os.environ["NAME"]
//       os.getenv("NAME" ...)
//   Either quote character works. Writes such as `dict(os.environ, KEY=...)`
//   are not reads and are not listed. Variables read by other files (the
//   launcher, the installer) are not listed.
//
// DESCRIPTIONS FROM THE DOCUMENTATION
//
//   Every Markdown table in `docs/*.md` (top folder only, files in code-point
//   order, tables inside fenced code blocks ignored) whose first column starts
//   with a backticked text gives a description: the first code span of the
//   first cell is the key, the last cell is the text. The header row is not
//   data. The text is shown as plain text, so a link `[text](url)` is reduced
//   to `text`, `**` and backticks are removed and white space is collapsed;
//   `\|` is a literal bar. The first description of a key wins.
//
//   * A configuration key takes the description of its exact dotted key. Without
//     one, it takes the description of the nearest enclosing key that has a row
//     (for a nested block, normally the top-level key), shown as
//     Part of "key": followed by that description.
//   * An environment variable takes the description of the row whose key is its
//     name, also when the row is written `NAME=value`.
//   * A command takes its description from its front matter only.
//
//   An item without a description is marked `undocumented: true` and listed on
//   standard error, which coffer shows only when the command fails; coffer
//   itself reports every undocumented item as a warning in the build report.
//
// SAFETY
//
//   The repository is untrusted data. The generator never executes or imports
//   anything from it, reads only the files named above, refuses symbolic links
//   and paths that leave the repository, limits the size of every file and the
//   number of items, uses no recursion on untrusted depth beyond MAX_DEPTH, and
//   uses only regular expressions without nested quantifiers. It does not read
//   environment variables. Its output is sorted (commands by name, keys by
//   dotted path in code-point order, variables by name) and holds no time, so
//   two runs on the same input are byte-identical.
//
// EXIT CODES
//
//   0 done; 2 wrong arguments; 3 an input is missing, unreadable or not valid
//   (the message names it); 4 the output cannot be written.

import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The largest file of each kind that is read, in bytes. */
export const LIMITS = Object.freeze({
  commandFile: 64 * 1024,
  defaults: 1024 * 1024,
  engine: 4 * 1024 * 1024,
  docFile: 1024 * 1024,
});

/** The most command files, documentation files, configuration keys and items. */
export const MAX_COMMANDS = 200;
export const MAX_DOC_FILES = 200;
export const MAX_KEYS = 5000;
export const MAX_ENV = 500;
/** The deepest nesting of defaults.json that is flattened. */
export const MAX_DEPTH = 16;
/** The longest description, signature and name, below the limits of coffer (50000, 5000, 500). */
const MAX_DESCRIPTION = 4000;
const MAX_SIGNATURE = 400;
const MAX_NAME = 200;
/** The longest table cell that is looked at. */
const MAX_CELL = 4000;

/** The file the generator writes in `<out>`. */
export const OUTPUT_FILE = 'reference.json';

/** An input is missing, unreadable or invalid; carries the exit code. */
export class InputError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 3) {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

/** Code-point order, the same on every machine (unlike `localeCompare`). */
const byCodePoint = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Reading the repository
// ---------------------------------------------------------------------------

/**
 * @param {string} realRoot The real path of the repository.
 * @param {string} full A path to check.
 * @param {string} shown The path to show in a message.
 */
function assertInside(realRoot, full, shown) {
  let real;
  try {
    real = realpathSync(full);
  } catch {
    throw new InputError(`${shown}: cannot be resolved`);
  }
  const rel = relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new InputError(`${shown}: leads outside the repository`);
}

/**
 * Lists the Markdown files of a folder of the repository, sorted.
 *
 * @param {string} realRoot
 * @param {string} dir Forward-slash path relative to the repository.
 * @param {number} max
 * @returns {string[]} File names.
 */
function listMarkdown(realRoot, dir, max) {
  const full = join(realRoot, ...dir.split('/'));
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    throw new InputError(`${dir}/ is missing from the repository`);
  }
  if (stat.isSymbolicLink()) throw new InputError(`${dir}/ is a symbolic link, which is not read`);
  if (!stat.isDirectory()) throw new InputError(`${dir} is not a folder`);
  assertInside(realRoot, full, `${dir}/`);
  const names = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (!entry.name.endsWith('.md')) continue;
    if (entry.isSymbolicLink()) throw new InputError(`${dir}/${entry.name} is a symbolic link, which is not read`);
    if (!entry.isFile()) continue;
    names.push(entry.name);
  }
  names.sort(byCodePoint);
  if (names.length > max) throw new InputError(`${dir}/ has ${names.length} Markdown files; at most ${max} are read`);
  return names;
}

/**
 * Reads a text file of the repository: a regular file, not a link, inside the
 * repository, at most `maxBytes`, valid UTF-8. A byte order mark is dropped and
 * every line ending becomes `\n`.
 *
 * @param {string} realRoot
 * @param {string} rel Forward-slash path relative to the repository.
 * @param {number} maxBytes
 * @returns {string}
 */
function readText(realRoot, rel, maxBytes) {
  const full = join(realRoot, ...rel.split('/'));
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    throw new InputError(`${rel} is missing from the repository`);
  }
  if (stat.isSymbolicLink()) throw new InputError(`${rel} is a symbolic link, which is not read`);
  if (!stat.isFile()) throw new InputError(`${rel} is not a file`);
  if (stat.size > maxBytes) throw new InputError(`${rel} is ${stat.size} bytes; at most ${maxBytes} are read`);
  assertInside(realRoot, full, rel);
  let bytes;
  try {
    bytes = readFileSync(full);
  } catch (error) {
    throw new InputError(`${rel} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length > maxBytes) throw new InputError(`${rel} is ${bytes.length} bytes; at most ${maxBytes} are read`);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new InputError(`${rel} is not valid UTF-8`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------
// Front matter of the command templates
// ---------------------------------------------------------------------------

/** The one-character escapes of a double-quoted YAML scalar. */
const SIMPLE_ESCAPES = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['0', '\0'],
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  [' ', ' '],
]);

/**
 * Reads the value of a double-quoted YAML scalar that starts at `text[0]`.
 *
 * @param {string} text
 * @returns {string | null} The value, or null when the quote is not closed.
 */
function readDoubleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') return out;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    const next = text[i];
    if (next === undefined) return null;
    const simple = SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) {
      out += simple;
    } else if (next === 'u' || next === 'x') {
      const width = next === 'u' ? 4 : 2;
      const hex = text.slice(i + 1, i + 1 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return null;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += width;
    } else {
      out += `\\${next}`;
    }
  }
  return null;
}

/**
 * Reads the value of a single-quoted YAML scalar that starts at `text[0]`.
 *
 * @param {string} text
 * @returns {string | null}
 */
function readSingleQuoted(text) {
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      return out;
    }
    out += text[i];
  }
  return null;
}

/**
 * Drops a trailing YAML comment (a `#` after a space or tab) from a plain value.
 * Written with `indexOf` because a regular expression for "white space, then #"
 * takes quadratic time on a long run of spaces.
 *
 * @param {string} raw
 * @returns {string}
 */
function withoutComment(raw) {
  const cuts = [raw.indexOf(' #'), raw.indexOf('\t#')].filter((at) => at !== -1);
  return (cuts.length === 0 ? raw : raw.slice(0, Math.min(...cuts))).trim();
}

/**
 * Reads the front matter of a Markdown file: the entries between a first line
 * `---` and the next line `---`. Only top-level `key: value` entries are read.
 *
 * @param {string} text Text with `\n` line endings.
 * @returns {{ values: Map<string, string>, problems: string[] } | null} Null when the file has no front matter.
 */
export function parseFrontMatter(text) {
  const lines = text.split('\n', 400);
  if (lines[0]?.trimEnd() !== '---') return null;
  const values = new Map();
  /** @type {string[]} */
  const problems = [];
  let closed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimEnd() === '---') {
      closed = true;
      break;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!entry) continue; // nested or continuation lines belong to a value we do not read
    const key = entry[1];
    const raw = (entry[2] ?? '').trim();
    /** @type {string | null} */
    let value;
    if (raw.startsWith('"')) {
      value = readDoubleQuoted(raw);
    } else if (raw.startsWith("'")) {
      value = readSingleQuoted(raw);
    } else if (/^[|>][+-]?$/.test(raw)) {
      const block = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t') || lines[i + 1].trim() === '')) {
        i += 1;
        block.push(lines[i].trim());
      }
      value = raw[0] === '|' ? block.join('\n').trim() : block.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      value = withoutComment(raw);
    }
    if (value === null) problems.push(`${key}: the quoted value is not closed on its line`);
    else if (!values.has(key)) values.set(key, value);
  }
  if (!closed) return { values: new Map(), problems: ['the front matter is not closed by a line "---"'] };
  return { values, problems };
}

// ---------------------------------------------------------------------------
// Tables of the documentation
// ---------------------------------------------------------------------------

/**
 * Splits a table row into trimmed cells. `\|` is a literal bar.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  // Text after the last bar is a cell only when the row did not end with a bar.
  if (cell.trim() !== '') cells.push(cell.trim());
  return cells.map((text) => (text.length > MAX_CELL ? text.slice(0, MAX_CELL) : text));
}

/** @param {string[]} cells */
const isSeparator = (cells) => cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));

/**
 * Replaces every inline link `[text](target)` by `text`. A single pass that
 * remembers where the next `]` and `)` are, so that the time is proportional to
 * the length of the text however many brackets it holds (a regular expression
 * for this would rescan the text from every `[`).
 *
 * @param {string} text
 * @returns {string}
 */
function stripLinks(text) {
  const next = { ']': -2, ')': -2 };
  /** @param {']' | ')'} char @param {number} from */
  const find = (char, from) => {
    if (next[char] < from) {
      const at = text.indexOf(char, from);
      next[char] = at === -1 ? Number.POSITIVE_INFINITY : at;
    }
    return next[char];
  };
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '[') {
      const close = find(']', i + 1);
      if (close !== Number.POSITIVE_INFINITY && text[close + 1] === '(') {
        const end = find(')', close + 2);
        if (end !== Number.POSITIVE_INFINITY) {
          out += text.slice(i + 1, close);
          i = end + 1;
          continue;
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/**
 * Turns the Markdown of a table cell into plain text: links become their text,
 * `**` is removed, white space is collapsed.
 *
 * @param {string} cell
 * @returns {string}
 */
export function plainText(cell) {
  return stripLinks(cell.slice(0, MAX_CELL))
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds the rows of the tables of a Markdown text whose first cell starts with
 * a code span.
 *
 * @param {string} text Text with `\n` line endings.
 * @returns {{ key: string, description: string }[]}
 */
export function tableRows(text) {
  const lines = text.split('\n');
  /** @type {{ key: string, description: string }[]} */
  const rows = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null || !trimmed.startsWith('|') || i + 1 >= lines.length) continue;
    if (!isSeparator(splitRow(lines[i + 1])) || !lines[i + 1].trim().startsWith('|')) continue;
    // lines[i] is the header row and lines[i + 1] the separator; the data follows.
    let row = i + 2;
    while (row < lines.length && lines[row].trim().startsWith('|')) {
      const cells = splitRow(lines[row]);
      row += 1;
      if (cells.length < 2) continue;
      const code = /^`([^`\n]+)`/.exec(cells[0]);
      if (!code) continue;
      const key = code[1].trim();
      const description = plainText(cells[cells.length - 1]);
      if (key !== '' && description !== '') rows.push({ key, description });
    }
    i = row - 1;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// defaults.json and engine.py
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Flattens the defaults into one entry for every key at every depth.
 *
 * @param {Record<string, unknown>} root
 * @returns {{ key: string, group: boolean, value: unknown }[]} In code-point order of the keys.
 */
export function flattenDefaults(root) {
  /** @type {Map<string, { key: string, group: boolean, value: unknown }>} */
  const found = new Map();
  /** @param {Record<string, unknown>} object @param {string} prefix @param {number} depth */
  const walk = (object, prefix, depth) => {
    if (depth > MAX_DEPTH) throw new InputError(`defaults.json is nested deeper than ${MAX_DEPTH} levels`);
    for (const name of Object.keys(object)) {
      if (name === '' || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new InputError(`defaults.json: the key ${JSON.stringify(name.slice(0, 40))} under "${prefix}" is empty, too long or has control characters`);
      }
      const key = prefix === '' ? name : `${prefix}.${name}`;
      const value = object[name];
      const group = isObject(value) && Object.keys(value).length > 0;
      if (found.has(key)) throw new InputError(`defaults.json: the dotted key "${key}" names two different keys`);
      found.set(key, { key, group, value });
      if (found.size > MAX_KEYS) throw new InputError(`defaults.json has more than ${MAX_KEYS} keys`);
      if (group) walk(/** @type {Record<string, unknown>} */ (value), key, depth + 1);
    }
  };
  walk(root, '', 1);
  return [...found.values()].sort((a, b) => byCodePoint(a.key, b.key));
}

/**
 * The names of the environment variables a Python source reads.
 *
 * @param {string} source
 * @returns {string[]} Sorted, without duplicates.
 */
export function environmentReads(source) {
  const names = new Set();
  const patterns = [
    /\benviron\s*\.\s*get\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]{0,127})\1/g,
    /\benviron\s*\[\s*(["'])([A-Za-z_][A-Za-z0-9_]{0,127})\1\s*\]/g,
    /\bos\s*\.\s*getenv\s*\(\s*(["'])([A-Za-z_][A-Za-z0-9_]{0,127})\1/g,
  ];
  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) names.add(match[2]);
    }
  }
  if (names.size > MAX_ENV) throw new InputError(`engine.py reads more than ${MAX_ENV} environment variables`);
  return [...names].sort(byCodePoint);
}

/**
 * @param {unknown} value
 * @returns {string} The value as compact JSON, shortened.
 */
function showValue(value) {
  const json = JSON.stringify(value);
  return json.length > MAX_SIGNATURE ? `${json.slice(0, MAX_SIGNATURE - 1)}…` : json;
}

/**
 * Makes an anchor from a prefix and a name, unique among `used`.
 *
 * @param {Set<string>} used
 * @param {string} prefix
 * @param {string} name
 */
function anchorFor(used, prefix, name) {
  const base = `${prefix}-${name.replace(/[^A-Za-z0-9_.:-]/g, '_')}`;
  let anchor = base;
  for (let n = 2; used.has(anchor); n += 1) anchor = `${base}-${n}`;
  used.add(anchor);
  return anchor;
}

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Item
 * @property {string} name
 * @property {string} kind
 * @property {string} signature
 * @property {string} [description]
 * @property {string} anchor
 * @property {boolean} undocumented
 */

/**
 * @typedef {object} Result
 * @property {{ sections: { title: string, items: Item[] }[] }} reference The document coffer reads.
 * @property {{ commands: number, keys: number, environment: number, undocumented: number }} counts
 * @property {string[]} undocumented `kind name` of every undocumented item, in the order of the reference.
 * @property {string[]} warnings Things that are odd but not errors.
 */

/**
 * Builds the reference of a specloop checkout.
 *
 * @param {string} repoPath
 * @returns {Result}
 */
export function buildReference(repoPath) {
  let realRoot;
  try {
    realRoot = realpathSync(resolve(repoPath));
    if (!lstatSync(realRoot).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new InputError(`the repository folder "${repoPath}" does not exist`);
  }
  /** @type {string[]} */
  const warnings = [];

  // defaults.json first: the command prefix comes from it.
  const defaultsText = readText(realRoot, 'kit/specloop/defaults.json', LIMITS.defaults);
  let defaults;
  try {
    defaults = JSON.parse(defaultsText);
  } catch (error) {
    throw new InputError(`kit/specloop/defaults.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(defaults)) throw new InputError('kit/specloop/defaults.json must hold a JSON object');
  const prefix = typeof defaults.commandPrefix === 'string' ? defaults.commandPrefix : null;

  // The descriptions of the documentation.
  /** @type {Map<string, string>} */
  const described = new Map();
  /** @type {Map<string, string>} */
  const describedEnv = new Map();
  for (const name of listMarkdown(realRoot, 'docs', MAX_DOC_FILES)) {
    for (const { key, description } of tableRows(readText(realRoot, `docs/${name}`, LIMITS.docFile))) {
      if (!described.has(key)) described.set(key, description);
      const variable = /^([A-Za-z_][A-Za-z0-9_]*)(?:=.*)?$/.exec(key);
      if (variable && !describedEnv.has(variable[1])) describedEnv.set(variable[1], description);
    }
  }

  /** @type {string[]} */
  const undocumented = [];
  const used = new Set();

  // Slash commands.
  const commandNames = listMarkdown(realRoot, 'kit/commands', MAX_COMMANDS).map((file) => file.slice(0, -3));
  if (commandNames.length === 0) throw new InputError('kit/commands/ has no command templates (*.md)');
  /** @type {Item[]} */
  const commands = [];
  for (const stem of commandNames) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(stem)) throw new InputError(`kit/commands/${stem}.md: the file name is not a usable command name`);
    const rel = `kit/commands/${stem}.md`;
    const front = parseFrontMatter(readText(realRoot, rel, LIMITS.commandFile));
    for (const problem of front?.problems ?? []) warnings.push(`${rel}: ${problem}`);
    if (front === null) warnings.push(`${rel}: has no front matter`);
    const description = (front?.values.get('description') ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
    const hint = (front?.values.get('argument-hint') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const name = `/${prefix ?? ''}${stem}`;
    /** @type {Item} */
    const item = {
      name,
      kind: 'slash command',
      signature: hint === '' ? name : `${name} ${hint}`,
      anchor: anchorFor(used, 'cmd', stem),
      undocumented: description === '',
    };
    if (description !== '') {
      const note = prefix === null || prefix === '' ? '' : `\n\nShown with the default prefix "${prefix}", which is the default of the "commandPrefix" setting; an installation can use another prefix.`;
      item.description = `${description}${note}`;
    }
    commands.push(item);
  }

  // Configuration keys.
  /** @type {Item[]} */
  const keys = [];
  for (const entry of flattenDefaults(defaults)) {
    const parts = entry.key.split('.');
    let description = described.get(entry.key);
    if (description === undefined) {
      for (let length = parts.length - 1; length >= 1 && description === undefined; length -= 1) {
        const owner = parts.slice(0, length).join('.');
        const text = described.get(owner);
        if (text !== undefined) description = `Part of "${owner}": ${text}`;
      }
    }
    /** @type {Item} */
    const item = {
      name: entry.key,
      kind: entry.group ? 'configuration group' : 'configuration key',
      signature: entry.group ? `${entry.key} { ... }` : `${entry.key} = ${showValue(entry.value)}`,
      anchor: anchorFor(used, 'config', entry.key),
      undocumented: description === undefined,
    };
    if (description !== undefined) item.description = description.slice(0, MAX_DESCRIPTION);
    keys.push(item);
  }

  // Environment variables.
  const engine = readText(realRoot, 'kit/specloop/engine.py', LIMITS.engine);
  /** @type {Item[]} */
  const variables = [];
  for (const name of environmentReads(engine)) {
    const description = describedEnv.get(name);
    /** @type {Item} */
    const item = { name, kind: 'environment variable', signature: name, anchor: anchorFor(used, 'env', name), undocumented: description === undefined };
    if (description !== undefined) item.description = description.slice(0, MAX_DESCRIPTION);
    variables.push(item);
  }
  if (variables.length === 0) warnings.push('kit/specloop/engine.py reads no environment variable that this generator recognises');

  const sections = [
    { title: 'Slash commands', items: commands },
    { title: 'Configuration keys', items: keys },
    { title: 'Environment variables', items: variables },
  ].filter((section) => section.items.length > 0);
  for (const section of sections) {
    for (const item of section.items) if (item.undocumented) undocumented.push(`${item.kind} ${item.name}`);
  }
  return {
    reference: { sections },
    counts: { commands: commands.length, keys: keys.length, environment: variables.length, undocumented: undocumented.length },
    undocumented,
    warnings,
  };
}

/**
 * Runs the generator.
 *
 * @param {string[]} args `[repo, out]`
 * @returns {number} The exit code.
 */
export function run(args) {
  if (args.length !== 2 || args.some((arg) => arg === '')) {
    process.stderr.write('usage: node specloop-reference.mjs <repo> <out>\n');
    return 2;
  }
  try {
    const result = buildReference(args[0]);
    const out = resolve(args[1]);
    try {
      mkdirSync(out, { recursive: true });
      if (lstatSync(out).isSymbolicLink()) throw new Error('the output folder is a symbolic link');
      writeFileSync(join(out, OUTPUT_FILE), `${JSON.stringify(result.reference, null, 2)}\n`);
    } catch (error) {
      throw new InputError(`cannot write ${OUTPUT_FILE} in "${args[1]}": ${error instanceof Error ? error.message : String(error)}`, 4);
    }
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    for (const name of result.undocumented) process.stderr.write(`undocumented: ${name}\n`);
    const { commands, keys, environment, undocumented } = result.counts;
    process.stdout.write(`specloop reference: ${commands} commands, ${keys} configuration keys, ${environment} environment variables, ${undocumented} undocumented\n`);
    return 0;
  } catch (error) {
    if (error instanceof InputError) {
      process.stderr.write(`specloop-reference: ${error.message}\n`);
      return error.code;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
