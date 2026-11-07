// Turns the report of a build (`.coffer/report.json`) into the Markdown the deploy workflow adds to
// its job summary:
//
//   node scripts/build-summary.mjs [--report <file>] >> "$GITHUB_STEP_SUMMARY"
//
// It has three parts: the posts that publish exact locations, the elements of the generated
// references that have no documentation, and the other warnings. Errors cannot be there (a build
// with errors does not get as far as the deployment) but are listed if they are. The script only
// reads the report; it prints no environment variable and reads no secret.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EXACT_LOCATIONS_TITLE } from '../coffer/src/report.js';

/** The root of this repository. */
const repository = fileURLToPath(new URL('..', import.meta.url));

/** A warning of this form says that a documented symbol of a generated reference is missing its text. */
const UNDOCUMENTED = /has no documentation\s*$/;

/**
 * Escapes the characters that would make a line of Markdown into something else.
 *
 * @param {string} text
 * @returns {string}
 */
function plain(text) {
  // One pass, so the backslash that escapes a character is never escaped itself. Brackets and
  // parentheses would make a link, "@" a mention.
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\`<>|[\]()@]/g, (char) => `\\${char}`);
}

/**
 * @param {import('../coffer/src/report.js').ReportIssue} issue
 * @returns {string}
 */
function line(issue) {
  const site = issue.site === undefined ? '' : `${issue.site}: `;
  return `- ${site}${plain(issue.message)}`;
}

/**
 * Renders the summary.
 *
 * @param {Partial<import('../coffer/src/report.js').ReportData>} report
 * @returns {string} Markdown ending in a newline.
 */
export function renderBuildSummary(report) {
  const errors = report.errors ?? [];
  const warnings = report.warnings ?? [];
  const exact = report.exactLocations ?? [];
  const undocumented = warnings.filter((warning) => UNDOCUMENTED.test(warning.message));
  const other = warnings.filter((warning) => !UNDOCUMENTED.test(warning.message));

  /** @type {string[]} */
  const out = ['## Build report', ''];

  out.push(`### ${EXACT_LOCATIONS_TITLE}`, '');
  if (exact.length === 0) {
    out.push('None.', '');
  } else {
    out.push(`${exact.length} post(s) publish exact locations:`, '');
    for (const entry of exact) {
      /** @type {string[]} */
      const what = [];
      if (entry.images > 0 || !entry.tracks) what.push(`${entry.images} image(s)`);
      if (entry.tracks) what.push(`${entry.tracks} track(s)`);
      out.push(`- ${entry.site}: ${plain(entry.file)}: ${what.join(', ')}`);
    }
    out.push('');
  }

  out.push('### Undocumented elements of the generated references', '');
  if (undocumented.length === 0) {
    out.push('None.', '');
  } else {
    out.push(`${undocumented.length} element(s) without documentation (the build still passes):`, '');
    out.push(...undocumented.map(line), '');
  }

  if (other.length > 0) {
    out.push(`### Other warnings (${other.length})`, '', ...other.map(line), '');
  }
  if (errors.length > 0) {
    out.push(`### Errors (${errors.length})`, '', ...errors.map(line), '');
  }
  return `${out.join('\n')}`;
}

/**
 * Reads the report file and renders it.
 *
 * @param {string} file
 * @returns {string}
 */
export function summarizeReportFile(file) {
  if (!existsSync(file)) return `## Build report\n\nNo build report was found at \`${plain(file)}\`.\n`;
  try {
    return renderBuildSummary(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    return `## Build report\n\nThe build report could not be read: ${plain(error instanceof Error ? error.message : String(error))}\n`;
  }
}

// Run as a script (not when a test imports it).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let report = join(repository, '.coffer', 'report.json');
  if (args.length === 2 && args[0] === '--report') {
    report = resolve(args[1]);
  } else if (args.length > 0) {
    console.error('Usage: node scripts/build-summary.mjs [--report <file>]');
    process.exit(2);
  }
  process.stdout.write(summarizeReportFile(report));
}
