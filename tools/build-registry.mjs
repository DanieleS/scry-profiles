#!/usr/bin/env node
// Build the registry a host reads profiles from: site/index.json, and every profile copied next to
// it under the same path it has here.
//
// A host does not download the whole registry. It reads the index, looks up the executable it is
// about to attach to, and fetches only the profiles whose `match.process` names it. That is why each
// entry carries the process (and the optional build version) out of the profile itself: the host
// has to be able to choose without opening every file.
//
//   node tools/build-registry.mjs [outDir]    (default: site)

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const out = join(root, process.argv[2] ?? 'site');
const profilesDir = join(root, 'profiles');

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith('.json')) yield path;
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const profiles = [];
for (const path of walk(profilesDir)) {
  const bytes = readFileSync(path);
  const profile = JSON.parse(bytes.toString('utf8'));
  const match = profile.match ?? {};
  if (typeof match.process !== 'string' || match.process === '') {
    throw new Error(`${relative(root, path)}: no match.process, so no host could ever pick it`);
  }
  if (!profile.contract || typeof profile.contract.id !== 'string') {
    throw new Error(`${relative(root, path)}: no contract id; a registry profile must name its contract`);
  }

  // Forward slashes whatever the build machine uses: this is a URL path as much as a file path.
  const file = relative(root, path).split(sep).join('/');
  mkdirSync(dirname(join(out, file)), { recursive: true });
  copyFileSync(path, join(out, file));

  profiles.push({
    file,
    process: match.process,
    version: typeof match.version === 'string' ? match.version : null,
    contract: { id: profile.contract.id, version: profile.contract.version },
    label: profile.label ?? null,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

const index = { format: 1, profiles };
writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`registry  ${relative(root, out)}/index.json (${profiles.length} profile${profiles.length === 1 ? '' : 's'})`);
