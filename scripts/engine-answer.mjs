// Tells the scheduled refresh whether a newer coffer release than the one a live site was built
// with is available inside the range of package.json. It writes an answer in the shape of
// `coffer rebuild-needed --json`, so scripts/refresh-decide.mjs can combine it with the others.
//
// Usage: node scripts/engine-answer.mjs <package.json> <tags.txt> <build-info.json>...
//   tags.txt  the output of `git ls-remote --tags https://github.com/ba3a/coffer.git`
//   build-info.json  the live build-info.json of each site (it names the engine version)
//
// A missing range, no release in the range, or a build-info without a version is an error (exit
// 1): "could not tell" is never turned into "no" or "yes".
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @param {string} text @returns {number[]} */
function parse(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) throw new Error(`"${text}" is not a plain version x.y.z`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {number[]} a @param {number[]} b @returns {number} */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * @param {string} dependency The coffer entry of package.json, ending in `#semver:^x.y.z`.
 * @returns {number[]} The lowest version of the caret range.
 */
function floorOf(dependency) {
  const match = /#semver:\^(\d+\.\d+\.\d+)$/.exec(dependency);
  if (!match) throw new Error(`the coffer dependency "${dependency}" has no #semver:^x.y.z range`);
  return parse(match[1]);
}

/** @param {number[]} version @param {number[]} floor @returns {boolean} Inside the caret range of floor. */
function inCaret(version, floor) {
  if (compare(version, floor) < 0) return false;
  if (floor[0] > 0) return version[0] === floor[0];
  if (floor[1] > 0) return version[0] === 0 && version[1] === floor[1];
  return version[0] === 0 && version[1] === 0 && version[2] === floor[2];
}

/**
 * @param {string} packageJson Text of package.json.
 * @param {string} tags Text of `git ls-remote --tags`.
 * @param {{ site: string, buildInfo: string }[]} sites
 * @returns {{ needed: boolean, site: string, reasons: { code: string, message: string }[] }}
 */
export function answer(packageJson, tags, sites) {
  const floor = floorOf(JSON.parse(packageJson).dependencies?.coffer ?? '');
  const versions = [...tags.matchAll(/refs\/tags\/v(\d+\.\d+\.\d+)$/gm)].map((m) => parse(m[1])).filter((v) => inCaret(v, floor));
  if (versions.length === 0) throw new Error('no coffer release is in the range of package.json');
  const newest = versions.reduce((a, b) => (compare(a, b) >= 0 ? a : b));
  const reasons = [];
  for (const { site, buildInfo } of sites) {
    const live = JSON.parse(buildInfo).engineVersion;
    if (typeof live !== 'string') throw new Error(`${site}: the build-info.json has no engineVersion`);
    if (compare(parse(live), newest) < 0) {
      reasons.push({ code: 'engine-release', message: `${site} was built with coffer ${live}; ${newest.join('.')} is released` });
    }
  }
  return { needed: reasons.length > 0, site: 'coffer', reasons };
}

/** @param {string[]} args @returns {number} The exit code. */
export function main(args) {
  if (args.length < 3) {
    process.stderr.write('Usage: node scripts/engine-answer.mjs <package.json> <tags.txt> <build-info.json>...\n');
    return 2;
  }
  try {
    const [pkg, tags, ...infos] = args;
    const result = answer(readFileSync(pkg, 'utf8'), readFileSync(tags, 'utf8'), infos.map((file) => ({ site: file, buildInfo: readFileSync(file, 'utf8') })));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`engine-answer: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
