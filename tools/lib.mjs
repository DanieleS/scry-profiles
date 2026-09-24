/**
 * The three checks this repository runs, as plain functions over a directory tree.
 *
 * Each check takes the repository root (so a test can point it at a scratch copy with one thing
 * broken) and returns a list of problems as strings. An empty list is a pass. Nothing here exits or
 * prints; `check.mjs` does that.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

// ---- finding things -----------------------------------------------------------------------------

/**
 * The scry binary to generate schemas with: `$SCRY` if set, else `scry` on the PATH, else a build in
 * a sibling checkout (`../scry/target/{release,debug}/scry`), which is how this repository is laid
 * out next to scry on a development machine.
 */
export function findScry(root) {
  if (process.env.SCRY) return process.env.SCRY;
  const exe = process.platform === 'win32' ? 'scry.exe' : 'scry';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  for (const flavour of ['release', 'debug']) {
    const sibling = join(root, '..', 'scry', 'target', flavour, exe);
    if (existsSync(sibling)) return sibling;
  }
  throw new Error(
    'no scry binary found: set SCRY=/path/to/scry, put it on the PATH, or build ../scry',
  );
}

function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

function files(dir, suffix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix) && statSync(join(dir, name)).isFile())
    .sort();
}

/** `"2.10"` -> `[2, 10]`, or `null` when it is not a `major.minor`. */
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)$/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x[0] - y[0] || x[1] - y[1];
}

/**
 * Every contract version on disk, grouped by id and sorted oldest first:
 * `{ "sea-of-stars": [{ version: "2.0", file, schema }, …] }`.
 *
 * A file whose name is not `<major>.<minor>.schema.json`, or whose `x-contract` disagrees with the
 * path it sits at, is reported rather than skipped: a schema that silently does not take part in
 * the checks is worse than one that fails them.
 */
export function loadContracts(root) {
  const problems = [];
  const contracts = {};
  const base = join(root, 'contracts');
  for (const id of subdirs(base)) {
    const versions = [];
    for (const name of files(join(base, id), '.json')) {
      const file = join(base, id, name);
      const rel = relative(root, file);
      const version = name.replace(/\.schema\.json$/, '');
      if (!name.endsWith('.schema.json') || !parseVersion(version)) {
        problems.push(`${rel}: expected a name of the form <major>.<minor>.schema.json`);
        continue;
      }
      let schema;
      try {
        schema = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        problems.push(`${rel}: not JSON: ${e.message}`);
        continue;
      }
      const declared = schema['x-contract'] ?? {};
      if (declared.id !== id || declared.version !== version) {
        problems.push(
          `${rel}: x-contract says ${JSON.stringify(declared)}, but the path says ` +
            `{"id":"${id}","version":"${version}"}`,
        );
      }
      versions.push({ version, file: rel, schema });
    }
    versions.sort((a, b) => compareVersions(a.version, b.version));
    contracts[id] = versions;
  }
  return { contracts, problems };
}

/** The layout check: every contract file is named and labelled for where it sits. */
export function checkLayout(root) {
  return loadContracts(root).problems;
}

// ---- comparing shapes ---------------------------------------------------------------------------

/**
 * Keywords that describe a value without constraining its shape. A contract's schema is generated,
 * but a person may annotate it afterwards (`description`, `x-unit`), and that must not count as a
 * change. `maxItems` is here too: it is the profile's safety cap on a collection, which a later
 * build can reasonably raise, and a view has to clamp regardless of what the schema claims.
 */
const NOT_SHAPE = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'maxItems']);

/** A schema with everything but its shape removed, keys sorted, so two can be compared as text. */
export function shape(schema) {
  if (Array.isArray(schema)) return schema.map(shape);
  if (schema === null || typeof schema !== 'object') return schema;
  const out = {};
  for (const key of Object.keys(schema).sort()) {
    if (NOT_SHAPE.has(key) || key.startsWith('x-')) continue;
    out[key] = key === 'required' ? [...schema[key]].sort() : shape(schema[key]);
  }
  return out;
}

const same = (a, b) => JSON.stringify(shape(a)) === JSON.stringify(shape(b));

/**
 * Whether `next` can be read by something written against `prev`: every property `prev` has is still
 * there with the same type, recursively through records and collections. New properties, and new
 * required fields inside records, are additions and are allowed. Returns the paths that break.
 */
export function breaks(prev, next, path = '') {
  const out = [];
  const here = path || '(root)';
  const scalarKeys = ['type', 'minimum', 'maximum', 'enum', 'const'];
  for (const key of scalarKeys) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      out.push(`${here}: ${key} changed from ${JSON.stringify(prev[key])} to ${JSON.stringify(next[key])}`);
    }
  }
  if (prev.items || next.items) {
    if (!prev.items || !next.items) out.push(`${here}: items appeared or disappeared`);
    else out.push(...breaks(prev.items, next.items, `${path}[]`));
  }
  for (const [name, sub] of Object.entries(prev.properties ?? {})) {
    const at = path ? `${path}.${name}` : name;
    const other = next.properties?.[name];
    if (!other) out.push(`${at}: removed`);
    else out.push(...breaks(sub, other, at));
  }
  for (const name of prev.required ?? []) {
    if (!(next.required ?? []).includes(name)) out.push(`${here}: ${name} is no longer required`);
  }
  return out;
}

// ---- check (i): every profile matches the contract it claims ------------------------------------

/** Run `scry schema` on one profile. */
export function generateSchema(scry, profileFile) {
  const out = execFileSync(scry, ['schema', profileFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

/**
 * For every `profiles/<id>/<name>.json`: regenerate its schema with scry, and require it to have
 * exactly the contract's properties, each with the contract's shape.
 *
 * Exactly, not "at least": the contract is the single source of truth for which values exist. A
 * profile that emits a field the contract does not declare is describing a newer contract, and the
 * fix is to publish that as a minor, not to let views find out by accident.
 */
export function checkProfiles(root, scry = findScry(root)) {
  const { contracts } = loadContracts(root);
  const problems = [];
  const base = join(root, 'profiles');
  for (const dir of subdirs(base)) {
    for (const name of files(join(base, dir), '.json')) {
      const file = join(base, dir, name);
      const rel = relative(root, file);
      let generated;
      try {
        generated = generateSchema(scry, file);
      } catch (e) {
        problems.push(`${rel}: scry schema failed: ${(e.stderr ?? e.message).toString().trim()}`);
        continue;
      }
      const claim = generated['x-contract'];
      if (!claim?.id) {
        problems.push(`${rel}: declares no contract; every profile here must implement one`);
        continue;
      }
      if (claim.id !== dir) {
        problems.push(`${rel}: implements contract "${claim.id}" but lives under profiles/${dir}/`);
      }
      const contract = contracts[claim.id]?.find((c) => c.version === claim.version);
      if (!contract) {
        problems.push(`${rel}: claims ${claim.id} ${claim.version}, which has no contracts/${claim.id}/${claim.version}.schema.json`);
        continue;
      }
      const want = contract.schema.properties ?? {};
      const got = generated.properties ?? {};
      for (const key of Object.keys(want)) {
        if (!(key in got)) problems.push(`${rel}: does not produce "${key}", which ${claim.id} ${claim.version} declares`);
        else if (!same(want[key], got[key])) {
          problems.push(
            `${rel}: "${key}" does not match ${claim.id} ${claim.version}: ` +
              `contract ${JSON.stringify(shape(want[key]))}, profile ${JSON.stringify(shape(got[key]))}`,
          );
        }
      }
      for (const key of Object.keys(got)) {
        if (!(key in want)) {
          problems.push(`${rel}: produces "${key}", which ${claim.id} ${claim.version} does not declare (publish a new minor)`);
        }
      }
    }
  }
  return problems;
}

// ---- check (ii): a minor only adds --------------------------------------------------------------

/**
 * Diff each contract version against the one before it. Within a major, a version may only add:
 * anything `breaks()` reports fails. Across a major anything goes — that is what a major is for —
 * but the first version of a new major must be `<major>.0`, so a range like `^3.0` has somewhere to
 * start.
 */
export function checkMinors(root) {
  const { contracts } = loadContracts(root);
  const problems = [];
  for (const [id, versions] of Object.entries(contracts)) {
    for (let i = 0; i < versions.length; i++) {
      const next = versions[i];
      const prev = versions[i - 1];
      const [major, minor] = parseVersion(next.version);
      if (!prev || parseVersion(prev.version)[0] !== major) {
        if (minor !== 0) problems.push(`${next.file}: the first ${id} ${major}.x must be ${major}.0`);
        continue;
      }
      for (const problem of breaks(prev.schema, next.schema)) {
        problems.push(`${next.file}: breaks ${id} ${prev.version} in a minor: ${problem}`);
      }
    }
  }
  return problems;
}

// ---- check (iii): captured fixtures fit their schema --------------------------------------------

/**
 * Parse a capture: the JSON events `scry watch --format json` printed, either one per line or
 * pretty-printed back to back (which is what piping the stream through a formatter leaves behind).
 */
export function parseEvents(text) {
  const events = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) events.push(JSON.parse(text.slice(start, i + 1)));
    } else if (depth === 0 && !/\s/.test(ch)) {
      throw new Error(`unexpected ${JSON.stringify(ch)} between events at offset ${i}`);
    }
  }
  if (depth !== 0) throw new Error('capture ends in the middle of an event');
  return events;
}

function validator() {
  // `strict: false` because the schemas carry `x-` annotations, which are legal JSON Schema but
  // unknown keywords to Ajv's strict mode.
  return new Ajv2020({ strict: false, allErrors: true });
}

/**
 * Every `fixtures/<id>/<version>/<name>.json` is a capture taken from a profile implementing that
 * contract version. Each `values` event in it must validate against that version's schema — and
 * against every *earlier* minor of the same major, which is the minor rule tested on real data
 * rather than on the schemas alone: something written against 2.0 has to be able to read what a 2.1
 * profile produces. (Not the other way round. A 2.0 capture lacks what 2.1 added, and a 2.1 reader
 * is entitled to expect it.)
 */
export function checkFixtures(root) {
  const { contracts } = loadContracts(root);
  const problems = [];
  const ajv = validator();
  const compiled = new Map();
  const base = join(root, 'fixtures');
  for (const id of subdirs(base)) {
    for (const version of subdirs(join(base, id))) {
      const versions = contracts[id] ?? [];
      const own = versions.find((c) => c.version === version);
      if (!own) {
        problems.push(`fixtures/${id}/${version}/: no contracts/${id}/${version}.schema.json to check against`);
        continue;
      }
      const [major] = parseVersion(version);
      const targets = versions.filter(
        (c) => parseVersion(c.version)[0] === major && compareVersions(c.version, version) <= 0,
      );
      for (const name of files(join(base, id, version), '.json')) {
        const rel = relative(root, join(base, id, version, name));
        let events;
        try {
          events = parseEvents(readFileSync(join(base, id, version, name), 'utf8'));
        } catch (e) {
          problems.push(`${rel}: ${e.message}`);
          continue;
        }
        const ticks = events.filter((e) => e.event === 'values');
        if (ticks.length === 0) problems.push(`${rel}: holds no "values" event`);
        for (const target of targets) {
          const validate = compiled.get(target.file) ?? ajv.compile(target.schema);
          compiled.set(target.file, validate);
          ticks.forEach((tick, n) => {
            if (!validate(tick.values)) {
              for (const err of validate.errors) {
                problems.push(`${rel}: values event #${n} vs ${id} ${target.version}: ${err.instancePath || '(root)'} ${err.message}`);
              }
            }
          });
        }
      }
    }
  }
  return problems;
}
