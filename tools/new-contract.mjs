/**
 * Write the schema of a new contract version from the profile that first implements it.
 *
 *   npm run new-contract -- profiles/sea-of-stars/steam-1.4.json
 *
 * The profile's own `contract` says which file to write. An existing schema is never overwritten:
 * a published contract version is immutable (views are built against it), and it may carry
 * descriptions someone added by hand.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findScry } from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv[2];
if (!profile) {
  console.error('usage: npm run new-contract -- <profile.json>');
  process.exit(1);
}

const text = execFileSync(findScry(root), ['schema', profile], { encoding: 'utf8' });
const claim = JSON.parse(text)['x-contract'];
if (!claim?.id) {
  console.error(`${profile} declares no contract ({"id", "version"}); nothing to write`);
  process.exit(1);
}
const out = join(root, 'contracts', claim.id, `${claim.version}.schema.json`);
if (existsSync(out)) {
  console.error(`${out} already exists; a published contract version is never rewritten`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log(`wrote ${out}`);
