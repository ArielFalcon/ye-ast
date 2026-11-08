# Dispatch reasons only: validation (2026-11-08)

Owner decision: deliver reasons only; pointcut scoping and stereotype permission were evaluated and dropped without measured depth gain. Historical source branch remains `fix/trace-aspect-scope` at `67894e74932177d534818af55b1ae4852077f09b`.

Implementation commit: `ed01882f0cf031ead9f1f1c81efac9c076f9a97b`.

## Scope and baseline

New branch `fix/trace-dispatch-reasons` starts at `84ca43617d4ef2e22256e8415e77bc943b351dbe`, the requested merge-base of main and `67894e74`. Both evaluation engines use that baseline; the candidate adds only reason mapping and transport. The same veto predicates and declared hierarchy are reused, with no pointcut evaluator, XML/Advisor inventory, stereotype permission or SCHEMA bump.

With readable sources, global aspect takes reason priority over a dynamic implementation API; the owner/method annotation and external owner-ancestry guards use generated implementation. All other Java vetoes use dispatch not proven. Earlier unread/parse guards keep the generic reason. These priorities affect diagnostics only.

The optional port reason passes through the language combiner and onto the existing Cut.detail field, retained by trace and compose. Complete body proofs keep their original priority.

## Parity evidence

Twelve named evaluation cases and the same 111 reconstructed pinned probes run on both engines. The reconstructed manifest is identical on both sides; historical identity with the deleted slice 4 manifest is not asserted. Each MCP fact is extracted from the real stdio response. Only Cut.detail values in the closed three-reason set are removed, then all remaining JSON is serialized identically with original object and array order preserved and compared byte for byte. Hashes and paired response paths are retained in scratch/parity.json.

All 159 paired calls match: 123 full traces (12 named + 111 probes) and 36 warm summary calls. This includes the complete steps and cuts arrays, status/complete, effects, snapshot and every other fact field. No complete transition occurs.

## Named cases

Each value is steps / maximum depth / cuts / complete / effects. Before and after are equal.

| Case | Baseline = candidate |
|---|---|
| PCR-1 | 4 / 1 / 5 / no / 0 |
| PCR-2 | 4 / 1 / 6 / no / 0 |
| JH-1 | 13 / 3 / 10 / no / 0 |
| JH-2 | 1 / 0 / 3 / no / 0 |
| JH-3 | 3 / 1 / 2 / no / 0 |
| JH-4 | 41 / 4 / 14 / no / 1 |
| JH-5 | 8 / 2 / 5 / no / 0 |
| SHJ-1 | 11 / 1 / 12 / no / 2 |
| SHJ-2 | 2 / 1 / 1 / no / 0 |
| SHJ-3 | 8 / 3 / 15 / no / 0 |
| SHJ-4 | 16 / 3 / 12 / no / 0 |
| RWJ-2 | 6 / 2 / 6 / no / 0 |

## Same 111 pinned probes by repository

| Repository | Traces | Steps | Max depth | Cuts | Complete | Effects |
|---|---:|---:|---:|---:|---:|---:|
| pfe | 15 | 345 | 4 | 50 | 0 | 47 |
| pbr | 15 | 330 | 5 | 284 | 0 | 0 |
| rwf | 15 | 150 | 3 | 67 | 2 | 16 |
| rwb | 15 | 357 | 6 | 340 | 0 | 0 |
| shop | 15 | 485 | 6 | 261 | 1 | 41 |
| ord | 17 | 383 | 8 | 664 | 0 | 0 |
| web | 17 | 2759 | 12 | 1282 | 0 | 0 |
| self | 2 | 5144 | 17 | 2768 | 0 | 0 |

Every cell is baseline = candidate. Labels: pfe/Petclinic Angular; pbr/Petclinic REST; rwf/Realworld Angular; rwb/Realworld Java; shop/Shopizer admin; ord/ms-name-orders; web/name-webapp; self/ye-ast. The ord/web rows include two acceptance traces each.

## Warm latency

Shopizer, largest Java backend: median of eight retained warm summaries (first call per case discarded), 24180.8 → 16151.1 ms. The host had concurrent external load; this is descriptive, not a causal performance claim.

## Checks

- RED: main returns bare unknown for the newly asserted reason mapping. GREEN: 146 focused tests, 386 Spring tests, 3 language-composition tests.
- Eight type-correct mutations of generic/aspect/dynamic-generator/outside-owner/annotation/trace-transport/language-combiner/schema mapping are caught; originals restored. The real stdio trace and compose responses each retain an aspect reason, verified separately from unit tests.
- Fourteen-command differential: stdout, stderr and exit bytes identical; all exit 0. Same pinned command manifest, including the original map/callers/importers/outline/impact families.
- MCP catalog: 3 tests pass. Total discovery 45,287 bytes; output schema 0 bytes; instructions 4,167 characters (budget 4,200); original tools remain within 41,000 bytes and compose input within 40,000 bytes. No schema version bump.
- Single final `npm run check`, Node 24.22.2: exit 0; typecheck and architecture pass; 3,736/3,736 tests pass, 0 fail. This is the only full gate run on the reasons-only branch.

## Evidence and risk

Scratch: `/tmp/ye-ast-dispatch-reasons.2F2gVL`; isolated HOME/XDG/cache/tmp and all job outputs stay there. One heavy job at a time. No ThingsBoard, push or deletion outside scratch.

This change explains main's conservative cuts and does not claim broader dispatch coverage or resolve advice outside the supplied snapshot. The initial scoping experiment and its correction remain historical evidence, not delivered policy. See [initial report](2026-11-07-d9.md) and [correction report](2026-11-07-d9-correction.md).
