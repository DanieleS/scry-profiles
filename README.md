# scry-profiles

Contracts and profiles for [scry](https://github.com/DanieleS/scry): which values a game offers, and
how to read them out of each build of it.

Nothing in here knows about a host, a client or a view. A host (Vibepollo) takes profiles from here;
a client's views (Ratatoskr's, in `ratatoskr-telemetry-views`) take contract schemas from here. See
scry's [`docs/contracts-and-views.md`](https://github.com/DanieleS/scry/blob/main/docs/contracts-and-views.md)
for why these are three things and who owns each.

## Layout

```
contracts/<id>/<major>.<minor>.schema.json   the shape of the values: one JSON Schema per version
profiles/<id>/<name>.json                    how to read them from one build; implements one version
fixtures/<id>/<major>.<minor>/<name>.json    real `scry watch --format json` captures of that version
maps/<id>/<name>.map.json                    il2cpp2scry input a profile was generated from, if any
```

- A **contract** is named by an id (`sea-of-stars`, a lowercase slug that never changes) and a
  `major.minor` version. Its schema describes the `values` object of scry's JSON stream: one
  property per watch, its type, and `null` allowed everywhere, because unreadable memory is `null`.
- A **profile** says which contract it implements, in its own file:
  `"contract": { "id": "sea-of-stars", "version": "2.0" }`. Many profiles implement one contract —
  one per storefront, one per patch — and it lives under `profiles/<id>/` for the contract it
  implements.
- A **fixture** is a capture taken from a profile implementing that version, kept so the schema is
  tested against what a game really produced and not only against itself. It may be one event per
  line or pretty-printed events back to back.

### What is here today

| Contract | Profiles | Fixtures |
|---|---|---|
| `sea-of-stars` 2.0 (43 watches) | `steam.json` | `steam-first-tick.json` |

The Sea of Stars profile came from Ratatoskr's `telemetry-views/fixtures`, where it had been living
with the integer `contractVersion: 2`; here it declares `sea-of-stars` 2.0 instead, and nothing else
in it changed. Its capture was recorded with **scry 0.1.0-alpha.2** — before 0.1.0-alpha.3, and so
before `contract` existed — which is why its `attached` event carries `contract_version: 2` and no
`contract`. The `values` are what matter to the check, and they are unaffected.

## The version rule

- **Minor** (`2.0` → `2.1`): additions only. A new watch, or a new field inside a record.
- **Major** (`2.x` → `3.0`): anything else. A rename, a retype, a removal, or a value that keeps its
  name and type but starts to mean something else.

A view that treats every value as optional reads any later minor of its major, which is why a view
declares a range like `^2.0`. That only holds if minors really only add, so CI checks it.

The last case in the major list — same name, same type, new meaning — is the one CI cannot see. It
is on the reviewer.

## What the checks do

```sh
npm install
npm run check    # the checks, against this repository
npm test         # proof that each check can fail (breaks one thing at a time in a scratch copy)
npm run ci       # both
```

They need a scry build that has `scry schema`. They use `$SCRY` if set, else `scry` on the `PATH`,
else `../scry/target/release/scry` or `../scry/target/debug/scry`, so a checkout of scry next to
this one is enough after `cargo build`.

1. **Every profile produces exactly the contract it claims.** Each profile's schema is regenerated
   with `scry schema` and compared with the contract file, property by property. A missing or
   retyped value fails. So does a value the contract does not declare: the contract is the one
   place that says which values exist, and a profile that emits more is describing a newer minor,
   which should be published as one.
2. **A minor only adds.** Each contract version is diffed against the previous version of the same
   major. A removed or retyped property, at any depth, fails; so does a record field that stops
   being required. The first version of a major must be `<major>.0`.
3. **Fixtures validate against their contract** — and against every earlier minor of the same major,
   because data from a 2.1 profile has to be readable by a view written for 2.0.

Comparisons ignore annotations (`title`, `description`, `$id`, `x-*`, …) and `maxItems`, which is a
profile's safety cap on a collection rather than part of its shape, and which a view has to clamp
against regardless. So a contract schema may be annotated by hand after it is generated.

## Adding a profile for a new build

The common case: the game patched, the offsets moved, the values did not.

1. Write the new profile — by hand, or by re-running `il2cpp2scry` on the map in `maps/` against the
   new build's dump — as `profiles/<id>/<name>.json` (`steam-1.4.json`, say).
2. Keep the same `contract` as the profile it replaces. Keep the watch names and types.
3. `npm run check`. If it passes, nothing downstream has to change.

If the check says the profile produces something the contract does not declare, or lacks something
it does, decide which version it is:

- **It only adds**: bump the minor in the profile (`2.0` → `2.1`) and run
  `npm run new-contract -- profiles/<id>/<name>.json`, which writes `contracts/<id>/2.1.schema.json`
  from it. The minor check then confirms it only adds.
- **Anything else**: bump the major (`3.0`) the same way. Views declaring `^2.0` will not draw it,
  which is the point.

`new-contract` never overwrites an existing file. A published contract version is immutable:
views are built against it.

A capture helps: `scry watch --format json --once … > fixtures/<id>/<version>/<name>.json`.

## Adding a new game

Pick an id — a lowercase slug, stable forever, since views and caches key on it — write the profile
with `"contract": { "id": "<id>", "version": "1.0" }`, and run `npm run new-contract` on it.
