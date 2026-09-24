/**
 * Each check, proved able to fail.
 *
 * A check that has only ever been seen passing is indistinguishable from one that checks nothing, so
 * every test here copies the real repository into a scratch directory, breaks exactly one thing, and
 * asserts the check names it. The first test is the other half: the repository as committed passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  breaks,
  checkFixtures,
  checkLayout,
  checkMinors,
  checkProfiles,
  findScry,
  parseEvents,
} from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scry = findScry(root);

const CONTRACT = 'contracts/sea-of-stars/2.0.schema.json';
const PROFILE = 'profiles/sea-of-stars/steam.json';
const FIXTURE = 'fixtures/sea-of-stars/2.0/steam-first-tick.json';

/** A scratch copy of the repository, handed to `fn` and removed afterwards. */
function scratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scry-profiles-'));
  try {
    for (const top of ['contracts', 'profiles', 'fixtures']) {
      cpSync(join(root, top), join(dir, top), { recursive: true });
    }
    const read = (rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
    const write = (rel, value) =>
      writeFileSync(join(dir, rel), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return fn({ dir, read, write });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hasProblem = (problems, pattern) =>
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n${problems.join('\n') || '(none)'}`,
  );

test('the repository as committed passes every check', () => {
  assert.deepEqual(checkLayout(root), []);
  assert.deepEqual(checkProfiles(root, scry), []);
  assert.deepEqual(checkMinors(root), []);
  assert.deepEqual(checkFixtures(root), []);
});

// ---- (i) profile vs contract -------------------------------------------------------------------

test('(i) a profile that retypes a watch fails against its contract', () =>
  scratch(({ dir, read, write }) => {
    const profile = read(PROFILE);
    const watch = profile.watches.find((w) => w.name === 'encounter_xp');
    watch.type = 'f32';
    write(PROFILE, profile);
    hasProblem(checkProfiles(dir, scry), /"encounter_xp" does not match sea-of-stars 2\.0/);
  }));

test('(i) a profile that drops a watch fails against its contract', () =>
  scratch(({ dir, read, write }) => {
    const profile = read(PROFILE);
    profile.watches = profile.watches.filter((w) => w.name !== 'paused');
    write(PROFILE, profile);
    hasProblem(checkProfiles(dir, scry), /does not produce "paused"/);
  }));

test('(i) a profile that emits a watch its contract lacks is told to publish a minor', () =>
  scratch(({ dir, read, write }) => {
    const profile = read(PROFILE);
    profile.watches.push({ tier: 'tier1', name: 'gold', module: 'GameAssembly.dll', offsets: [0], type: 'u32' });
    write(PROFILE, profile);
    hasProblem(checkProfiles(dir, scry), /produces "gold".*publish a new minor/);
  }));

test('(i) a profile claiming a contract version that does not exist fails', () =>
  scratch(({ dir, read, write }) => {
    const profile = read(PROFILE);
    profile.contract.version = '2.7';
    write(PROFILE, profile);
    hasProblem(checkProfiles(dir, scry), /claims sea-of-stars 2\.7, which has no/);
  }));

// ---- (ii) minor diff ---------------------------------------------------------------------------

/** Write `contracts/sea-of-stars/<version>.schema.json` as 2.0 with `edit` applied. */
function nextVersion({ read, write }, version, edit) {
  const schema = read(CONTRACT);
  schema['x-contract'] = { id: 'sea-of-stars', version };
  schema.$id = `urn:scry:contract:sea-of-stars:${version}`;
  edit(schema);
  write(`contracts/sea-of-stars/${version}.schema.json`, schema);
}

test('(ii) a minor that only adds passes', () =>
  scratch((repo) => {
    nextVersion(repo, '2.1', (s) => {
      s.properties.gold = { type: ['integer', 'null'], minimum: 0, maximum: 4294967295 };
      s.properties.party_progress.properties.ap = { type: ['integer', 'null'] };
      s.properties.party_progress.required.push('ap');
    });
    assert.deepEqual(checkMinors(repo.dir), []);

    // A capture from a 2.1 profile has to read as 2.0 too, which is the whole promise of a minor:
    // a view written against 2.0 keeps working. The fixture check validates it against both.
    const events = parseEvents(readFileSync(join(root, FIXTURE), 'utf8'));
    const tick = events.find((e) => e.event === 'values');
    tick.values.gold = 120;
    tick.values.party_progress.ap = 3;
    mkdirSync(join(repo.dir, 'fixtures/sea-of-stars/2.1'));
    repo.write('fixtures/sea-of-stars/2.1/steam-1.4.json', events.map((e) => JSON.stringify(e)).join('\n'));
    assert.deepEqual(checkFixtures(repo.dir), []);

    // ...and one that forgets the field 2.1 added is not a 2.1 capture.
    delete tick.values.party_progress.ap;
    repo.write('fixtures/sea-of-stars/2.1/steam-1.4.json', events.map((e) => JSON.stringify(e)).join('\n'));
    hasProblem(checkFixtures(repo.dir), /vs sea-of-stars 2\.1: \/party_progress must have required property 'ap'/);
  }));

test('(ii) a minor that removes a watch fails', () =>
  scratch((repo) => {
    nextVersion(repo, '2.1', (s) => delete s.properties.paused);
    hasProblem(checkMinors(repo.dir), /2\.1\.schema\.json: breaks sea-of-stars 2\.0 in a minor: paused: removed/);
  }));

test('(ii) a minor that retypes a field inside a collection of records fails', () =>
  scratch((repo) => {
    nextVersion(repo, '2.1', (s) => {
      s.properties.enemies.items.properties.hp = { type: ['number', 'null'] };
    });
    hasProblem(checkMinors(repo.dir), /enemies\[\]\.hp: type changed/);
  }));

test('(ii) a new major may change anything, but must start at .0', () =>
  scratch((repo) => {
    nextVersion(repo, '3.0', (s) => delete s.properties.paused);
    assert.deepEqual(checkMinors(repo.dir), []);
    nextVersion(repo, '4.1', () => {});
    hasProblem(checkMinors(repo.dir), /the first sea-of-stars 4\.x must be 4\.0/);
  }));

// ---- (iii) fixtures ----------------------------------------------------------------------------

test('(iii) a fixture whose value has the wrong type fails', () =>
  scratch(({ dir, write }) => {
    const events = parseEvents(readFileSync(join(root, FIXTURE), 'utf8'));
    const tick = events.find((e) => e.event === 'values');
    tick.values.encounter_xp = 'lots';
    write(FIXTURE, events.map((e) => JSON.stringify(e)).join('\n'));
    hasProblem(checkFixtures(dir), /\/encounter_xp must be integer,null/);
  }));

test('(iii) a fixture with a record missing a field fails', () =>
  scratch(({ dir, write }) => {
    const events = parseEvents(readFileSync(join(root, FIXTURE), 'utf8'));
    const tick = events.find((e) => e.event === 'values');
    delete tick.values.party_progress.level;
    write(FIXTURE, events.map((e) => JSON.stringify(e)).join('\n'));
    hasProblem(checkFixtures(dir), /\/party_progress must have required property 'level'/);
  }));

// ---- layout and parsing ------------------------------------------------------------------------

test('a contract file whose x-contract disagrees with its path fails the layout check', () =>
  scratch(({ dir, read, write }) => {
    const schema = read(CONTRACT);
    schema['x-contract'].version = '2.1';
    write(CONTRACT, schema);
    hasProblem(checkLayout(dir), /x-contract says .*"2\.1".*but the path says/);
  }));

test('captures parse one-per-line and pretty-printed alike', () => {
  const events = [{ event: 'attached', note: 'a } in a string' }, { event: 'values', values: { hp: 1 } }];
  assert.deepEqual(parseEvents(events.map((e) => JSON.stringify(e)).join('\n')), events);
  assert.deepEqual(parseEvents(events.map((e) => JSON.stringify(e, null, 4)).join('\n')), events);
  assert.throws(() => parseEvents('{"event": "values"'), /middle of an event/);
});

test('breaks() ignores annotations and a raised collection cap', () => {
  const prev = { type: ['array', 'null'], maxItems: 8, items: { type: ['integer', 'null'] } };
  const next = { ...prev, maxItems: 64, description: 'now documented', 'x-unit': 'hp' };
  assert.deepEqual(breaks(prev, next), []);
});
