# Asset and prompt evaluation matrix

This is the first local measurement plan for the post-V1 pipeline. It separates
**transfer reliability** (the FBX reaches an inspectable, exact Studio instance)
from **prompt compliance** (each requested change is present in that instance).
`UNKNOWN` is never a pass. The table is a coverage plan, not a claim that its
unmarked cases have been implemented or tested.

## Current anchor

| Case | Input and prompt | Blender | Open Cloud | Selected Studio | Prompt requirements | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `horse_black_2x` | Supplied horse FBX; `Gör den svart och dubbelt så stor.` | Real Blender 4.2.3, Gate 1 and FBX round-trip passed | Uploaded exact export hash | Exact selected instance inspected; Gate 2 passed | Black and 2× both passed | Verified through CLI on 2026-09-26 |
| `horse_black_2x_desktop` | Same supplied horse and locked prompt | Real Blender 4.2.3, Gate 1 and independent FBX round-trip passed | New output asset `105026615135962` | Exact selected instance inspected and reinspected after runtime restart | Black and 2× both passed | Verified through Electron buttons on 2026-09-27; persisted result visible after full app restart |

## Local generated fixture coverage

`pnpm test:blender` now runs the deterministic pipeline and FBX round trip against
these generated cases using the installed Blender executable. They are local tests;
they do not upload assets to Roblox or count as additional live Studio cases.

| Fixture | Stress case | Verified outcome |
| --- | --- | --- |
| `multi-root` | Two separated root meshes | Non-empty geometry inspected, recolored, scaled, exported and reimported at 2× |
| `rotated-multi-material` | Rotated parent with two children, independent root and two source materials | All imported parts use the uniform black material; hierarchy-scale mutation remains 2× through FBX round trip |
| `centimeter-units` | Metric scene with `scale_length = 0.01`, different object sizes and materials | Relative world bounds double and exported FBX preserves black and 2× dimensions |
| `empty` | FBX with no mesh objects | Real pipeline exits with a typed Blender process failure before it can be accepted as an asset |

The prompt compiler also has explicit rejection cases for negation, a scoped target,
a contradictory size instruction and an unsupported extra rotation. They stay
unsupported rather than falling through to the black-and-double procedure. These
checks establish the current boundary; they do not measure paraphrase accuracy or
subjective appearance.

The source of truth for that result is [V1_INTEGRATION.md](V1_INTEGRATION.md),
the persisted Job and its evidence. A local version-1 measurement can be derived
without re-running an upload:

```powershell
pnpm benchmark:export 'C:\Users\JM\BloxBot-v1-acceptance' '9f545a52-2452-4d95-bdc5-c2df97e91d11' 'horse_black_2x'
```

This writes `evaluations/<job-id>-v1.json` in that workspace. It contains the
prompt and non-secret hashes/IDs, but no credential or authorization header. It
does not modify or resume the Job. Do not commit user assets or evaluation
records without the user's explicit decision to share them.

## Transfer coverage to build

| Family | Initial fixture or probe | Required observation | Current status |
| --- | --- | --- | --- |
| Geometry | Single mesh; many meshes; disconnected objects; empty parents | Mesh and triangle counts, hierarchy, visible bounds before/after import | Two roots and empty FBX locally verified; other cases planned |
| Materials | Uniform, multiple materials, texture overlays, transparency | Blender material representation, exported FBX, exact Studio part properties and appearance | Uniform black live verified; multiple source materials locally verified; texture/transparency cases planned |
| Transforms | Unit scales, rotated roots, non-origin pivots, very small/large bounds | World-space baseline, FBX reimport, selected Studio ratio | Horse 2× live verified; rotated parent and centimeter scene locally verified |
| Rigging | Armature, skinning, animation, no rig | Inspect actual bones and importer behavior; mark unsupported cases explicitly | Planned |
| Geometry quality | Non-manifold/loose geometry, degenerate faces, high complexity | Preflight issues and whether Roblox preserves usable parts | Empty geometry rejected locally; other quality cases planned |
| Packaging | External textures, unusual names, Unicode/long paths, near upload size limit | Dependencies, artifact bytes/hash, typed failures | Basic FBX path verified; matrix planned |
| Remote failures | API rejection, moderation, polling timeout, ambiguous POST, Studio disconnect/contract change | Receipt/operation provenance; no unsafe duplicate upload or false completion | Adapter tests exist; live failure matrix planned |

Each family should include a known-good control and at least one deliberate
failure. Use generated Blender fixtures for objective cases; add real user files
only with permission and keep their paths outside the repository. Reinspect the
exact imported instance, not whichever Studio window is active.

## Prompt coverage to build

| Family | Example | Expected behavior before support exists |
| --- | --- | --- |
| Known objective | Black and 2×, including safe paraphrases | Compile explicit requirements, verify in Blender and Studio |
| Scoped objective | “Make only the saddle black” | Do not recolor the entire model; reject until target selection is provable |
| Multi-step | Color, scale and rotate in one request | Track each mandatory requirement independently |
| Negation/conflict | “Do not make it black”; mutually inconsistent instructions | Never silently use the known black procedure |
| Appearance | “Make it look like worn leather” | Define a visual rubric and collect views plus a user label; objective checks alone are insufficient |
| Ambiguous | “Make it better” | Ask for the smallest clarification or return an explicit unsupported result |

The current V1 compiler intentionally supports only the locked black-and-double
task. Rows above are future test cases, not current capabilities.

## Measurement and promotion rules

1. Freeze cases and expected labels before testing a candidate. Keep related
   meshes and prompt paraphrases in the same split to avoid leakage between
   development and holdout cases.
2. Record two independent outcomes: transfer milestones and per-requirement
   prompt results. A cloud receipt, Studio insertion or a model's self-rating
   cannot turn an unknown prompt result into a pass.
3. For subjective requirements, store user feedback separately from automated
   evidence. Future standardized Studio views should identify the exact model,
   camera, lighting and capture contract. Do not overwrite objective evidence
   with a visual model judgment.
4. Compare candidate procedures against the fixed holdout set, including false
   `COMPLETED` outcomes, user corrections, time and upload cost. Promote only
   after no known objective regression and a measured prompt-compliance gain.
5. Keep real Open Cloud/Studio runs budgeted and in a disposable place. Local
   Blender preflight and round-trip checks should screen candidates first;
   creation POSTs must not be retried blindly.

The first implementation slice provides a versioned observation schema and a
read-only derivation from persisted Jobs. It does not introduce a policy engine,
automatic procedural promotion, generated-code execution or AI scoring.
