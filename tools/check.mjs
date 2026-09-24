/**
 * Run every check against this repository and exit non-zero if any fails.
 *
 *   npm run check                 # all of them
 *   SCRY=/path/to/scry npm run check
 *
 * Each check prints its own heading and problems, so a CI log says which rule broke, not only that
 * something did.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFixtures, checkLayout, checkMinors, checkProfiles, findScry } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scry = findScry(root);

const checks = [
  ['contract files are named for what they hold', () => checkLayout(root)],
  ['every profile produces exactly the contract it claims', () => checkProfiles(root, scry)],
  ['a minor version only adds', () => checkMinors(root)],
  ['fixtures validate against their contract', () => checkFixtures(root)],
];

console.log(`scry: ${scry}`);
let failed = 0;
for (const [name, run] of checks) {
  const problems = run();
  console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${name}`);
  for (const p of problems) console.log(`        ${p}`);
  if (problems.length) failed++;
}
process.exit(failed ? 1 : 0);
