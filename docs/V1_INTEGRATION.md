# V1 Windows integration acceptance

The locked horse acceptance scenario passed on 2026-09-26 at 17:39 UTC on the shared
Windows 11 host. Prompt: `Gör den svart och dubbelt så stor.`

## Recorded result

- Job: `9f545a52-2452-4d95-bdc5-c2df97e91d11`, **COMPLETED**.
- Gate 1: passed before export. Gate 2: passed after real selected-Studio insertion
  and reinspection. Both mandatory requirements: PASS.
- Blender: **4.2.3 LTS**, Node: **22.23.3**, pnpm: **12.6.0**.
- Input: supplied horse ZIP's `tripo_convert_d5a0c727-eaa4-401e-b789-24d5ce356f1f.fbx`.
- Input SHA-256: `20fb7fee8310a13e87dd4d4cc865bd33b62b0af49da71b03cd629a7fd136bf5b`.
- Export: 779,596 bytes; SHA-256
  `bf15019e125f386bfa97693292c5017b17e40e2b639ec9dd36d6cb9652ecaf4c`.
- Open Cloud output operation: `operations/1d2c97b5-e468-4aa8-ba5b-e066f3f00395`;
  asset **102686737847248**, revision 1. The API omitted moderation state; no
  moderation approval is inferred from that omission. Actual Studio insertion succeeded.
- Reference asset: **94878705772322**, revision 1.
- Selected disposable Studio: `7485867d-33df-4782-9476-ac122e0765bf`, local Place1,
  Place ID 0, Edit mode. Original Place1.rbxl remained separate.
- Exact output instance: `Workspace.BloxBot_cecb64ee_06ed_4bde_9bc6_7658c3b80b73`.
- All 13 visible mesh parts were black RGBA `[0,0,0,1]`, with no texture overlays.
- Live contract: 28 tools; SHA-256
  `0fdc23f4778515df5b2c153d0a67069644fb6d52b2e99ad8a5e7fe952205515b`.

| Studio geometry extent | Reference | Output | Ratio |
| --- | ---: | ---: | ---: |
| X | 0.2703704238 | 0.5407407880 | 1.9999997795 |
| Y | 0.8444820046 | 1.6889643669 | 2.0000004235 |
| Z | 0.9813841581 | 1.9627681971 | 1.9999998785 |

Blender's original XYZ extents were 0.2703704983, 0.9813843071, 0.8444823822.
The FBX Y-up conversion maps Blender Y/Z to Studio Z/Y. The original import is
measured in the same Studio frame, avoiding an assumed studs/unit conversion.
Independent Blender reimport of the exact uploaded export retained 13 meshes,
9,499 triangles, black material, and doubled extents
(0.5407410562, 1.9627684355, 1.6889649189).

A new runtime restored the completed Job unchanged. The persisted gates,
requirements, operations and evidence were validated again, then the exact live
Studio output was reinspected and still passed color and scale checks.

## Import compatibility found by the real test

The first real upload/import run failed correctly: Open Cloud discarded uniform
FBX material colors, default Blender export scaling produced 200x meshes in Studio,
and a generated invisible RootPart polluted geometry bounds. The successful run uses:

1. FBX Unit Scale export (`FBX_SCALE_UNITS`), also preserving Blender round-trip size.
2. Geometry inspection excluding only the generated transparent ordinary Part named
   RootPart; visible meshes remain subject to every color/dimension check.
3. A separate durable `roblox.apply_verified_material` operation. It checks the
   exported fingerprint is uniformly black, checks imported mesh count and absence
   of texture overlays, then sets mesh color/material properties on the exact output
   model. It reinspects afterwards. This is an explicit compatibility step, not proof
   that Open Cloud preserved the material unaided. The cloud asset remains the FBX
   upload; the verified final Studio instance includes the recorded material step.

The failed run `3fb46cf4-d1e7-462b-960b-ece5d41a869f` and its two temporary assets
remain in the disposable place as diagnostic evidence. A preceding long-path run
failed before upload. Artifact filenames now use UUID plus extension to reduce
Windows path growth; choose a short workspace root.

## Architecture and safety

JobService alone owns transitions and rejects COMPLETED without persisted passing
gates, successful operations, backed evidence, and every mandatory evaluation.
ExecutionService validates dependency graphs and checkpoints RUNNING/SUCCEEDED/FAILED.
Each current capability resolves to one versioned deterministic procedure, and the
procedure ID/version are checkpointed on its operation before execution. A second
procedure for the same capability is rejected until an explicit selection policy
exists; this work does not add a Policy Registry or AI fallback.
The per-job Blender adapter serializes scene operations, preserves immutable derived
scenes and uses a persisted absolute scale target so retrying 2x cannot produce 4x.
Known V1 instructions compile deterministically; unsupported prompts fail.

RobloxOpenCloudAssetService is separate from the Studio adapter. It reads the external
key only at request time, pins requests to the Roblox API origin, rejects redirects,
validates operation paths and response types, limits upload size to 20 MB, snapshots
and hashes the exact uploaded bytes, and records non-secret receipts. Creation is
never retried automatically; transient polling retries and total duration are bounded.
Known non-approved moderation states block insertion. No credential enters artifacts,
logs, repository files, or CLI arguments.

RobloxService uses StudioMcpBroker and the discovered live contract. Every specific
Studio call carries the selected ID. Import intent, insertion result, material
projection, inspections, contract hash and upload receipts are persisted.

Interrupted Jobs fail/cancel on restart rather than replaying uploads or mutations.
Only one controller may use a workspace at a time; the atomic JSON store provides
in-process serialization, not cross-process locking. Chat sessions remain separate.

## Evidence and validation

Local acceptance workspace: `C:\Users\JM\BloxBot-v1-acceptance`.
The `evidence/9f545a52-2452-4d95-bdc5-c2df97e91d11` directory contains the completed
Job, contract, restart verification, independent Blender round-trip and viewport
capture. Original/derived/export artifacts and Blender logs remain under `jobs`.
Asset binaries and credential files are not committed.

The original acceptance ran through the application services using the repository
CLI. A separate desktop button-driven acceptance passed on 2026-09-27 (below).
Studio window capture timed out in the original run; MCP viewport capture worked.
The installed Roblox mcp.bat prints malformed trailing batch lines on shutdown;
live MCP operations succeed. The launcher was not modified.

Review history: no AGENTS.md was found in the repository/ancestors. The handoff was
read in full; no unresolved inline PR reviews existed. The alternate old branch
`codex/read-project-handoff-document` was inspected; its persistence work was already
superseded by this implementation. No main merge, reset or force push was performed.

See [Windows setup](WINDOWS_V1_ENVIRONMENT.md) and [smoke test](V1_LOCAL_SMOKE_TEST.md).
References: [Roblox Assets API](https://create.roblox.com/docs/cloud/guides/usage-assets),
[Roblox Blender export settings](https://create.roblox.com/docs/art/characters/creating/blender-configurations).

## Follow-up on 2026-09-27

The branch's Electron app started and exposed its current UI. Live contract discovery
again returned 28 tools with the same contract hash and two Studio instances; the
disposable `Place1` still had ID `7485867d-33df-4782-9476-ac122e0765bf`.
Automated Windows input to the app was denied (`GetCursorPos`, access denied), so
no button-driven upload or Gate 2 run occurred in this follow-up. A focused React
test now exercises the asset-job button through the desktop API with an explicit
Studio ID, but that test uses a fake API and is not a live desktop acceptance.

The first versioned, local benchmark observation was derived from the existing
completed horse Job without re-running an upload. It records transfer milestones
and mandatory prompt requirements separately. See [ASSET_EVALUATION_MATRIX.md](ASSET_EVALUATION_MATRIX.md).

## Desktop acceptance on 2026-09-27

After Windows input access was restored, the current branch was started with
`pnpm dev`. The run was initiated through the actual Electron UI: new session,
explicit `Place1` selection, Asset job, native FBX file picker, creator user ID
`4974439157`, then Run asset job. No CLI command created this Job.

- Job `e490280e-d499-4491-a783-9812da7a2db7`: **COMPLETED**, all 11 operations
  SUCCEEDED, Gate 1 and Gate 2 passed, both mandatory requirements PASS.
- The UI visibly progressed from INSPECTING to COMPLETED and displayed
  `2/2 requirements passed`.
- Input SHA-256 remains `20fb7fee8310a13e87dd4d4cc865bd33b62b0af49da71b03cd629a7fd136bf5b`
  (837,644 bytes). Blender 4.2.3 LTS inspected 13 meshes, 5,068 vertices and 9,499
  triangles before mutation.
- Export: 779,580 bytes, SHA-256
  `3d590ee9bfe50cfcda0076265a2dcb36a29c9c1c576f81894909c3f16567f57e`.
- Open Cloud output operation `operations/608ecd7c-9cc2-4359-a972-2541aaa79e56`:
  SUCCEEDED, asset `105026615135962`, revision 1. Reference asset `86563116361752`,
  revision 1, operation `operations/0fafe24d-82ad-47f7-bf6f-91151ff74864`.
  Moderation state was again omitted; no moderation approval is inferred.
- Selected Studio `7485867d-33df-4782-9476-ac122e0765bf`; exact output instance
  `Workspace.BloxBot_27df081e_dada_4f3c_aae5_8a30c91759df`.
- All 13 inspected mesh parts had black RGBA `[0,0,0,1]`, no texture overlays,
  and a valid hierarchy after the recorded material projection.
- Studio output XYZ extents: `(0.5407406092, 1.6889648438, 1.9627684355)`;
  reference: `(0.2703703046, 0.8444824219, 0.9813842177)`. All three ratios were 2.
- A fresh runtime loaded the persisted Job unchanged and independently reinspected
  this exact Studio instance. A full Electron restart then displayed the same
  completed Job and `2/2` results, without rerunning it.
- Independent Blender 4.2.3 reimport of the exact uploaded FBX retained black,
  13 meshes, 9,499 triangles and doubled XYZ extents
  `(0.5407410562, 1.9627684355, 1.6889649189)`.
- Live tools/list again returned 28 tools with the same contract hash shown above.

Local evidence is under
`C:\Users\JM\BloxBot\evidence\e490280e-d499-4491-a783-9812da7a2db7`:
completed Job, contract, restart reinspection, FBX round-trip inspection and Studio
viewport capture. Original and derived assets plus Blender logs are retained under
the corresponding `jobs` directory. The versioned observation at
`evaluations/e490280e-d499-4491-a783-9812da7a2db7-v1.json` records all seven transfer
milestones and both prompt requirements as PASS.

Validation on this run: `pnpm typecheck`; `pnpm test` (204 application, 44 control
and 8 release tests passed; one external Blender test skipped in the ordinary
suite); `pnpm test:blender` (one real integration test passed with the PATH-selected
Blender 5.2.2 LTS); and `pnpm check:v1-environment` passed. The desktop horse run
and its independent round-trip used Blender 4.2.3 LTS as recorded above.

The desktop acceptance initially exposed Explorer and narrow-layout defects. They
were fixed and verified in the next implementation slice below. The viewport capture
includes earlier diagnostic models in the disposable place and is not a standardized
visual-quality evaluation. This run proves the locked objective scenario, not
arbitrary prompt support or autonomous learning.

## Explorer and evaluation matrix follow-up on 2026-09-27

Live tools/list showed that `search_game_tree` requires both `studio_id` and
`datamodel_type` (`Edit`, `Client` or `Server`). The built-in Explorer program sent
the selected Studio ID but omitted the required datamodel. It now sends the
contract's `Edit` value. With the current live Studio selected as Place1, the actual
Explorer loaded and displayed Workspace, its imported models and the other default
services. No asset was uploaded or changed during this verification.

The Asset job panel now uses a viewport-fixed, bounded card, so it remains fully
visible with Explorer open in the 906-pixel-wide app window. The asset form remains
available and its controls do not overlap the Explorer content area.

The real Blender integration suite now generates four disposable cases: two root
meshes, rotated parents with multiple source materials, metric centimeter units and
an empty FBX. The first three passed black-material and absolute-2x checks through
export and FBX reimport. The empty FBX was rejected by the real pipeline with a
typed Blender process failure. Compiler tests confirm that negated, scoped,
contradictory and extra-rotation prompts remain unsupported rather than being
silently mapped to the known procedure.

Validation on Node 22.23.3, pnpm 12.6.0 and Blender 5.2.2 LTS: `pnpm typecheck`,
`pnpm build`, `pnpm check:v1-environment`, and `pnpm test` passed (204 application,
48 control and 8 release tests; four external Blender cases are skipped by the
ordinary suite). `pnpm test:blender` separately ran and passed all four cases with
the installed Blender 5.2.2 LTS. The live Explorer view was verified through the
actual application and broker. No new Open Cloud or Studio asset import was part of
this follow-up.

## Frozen prompts and Studio import failure gates on 2026-09-27

The compiler regression set now freezes three supported complete prompts (the
locked Swedish instruction and two enumerated English forms) plus four labeled
rejections for negation, scoped targets, contradiction and an unsupported extra
rotation. It protects the current explicit boundary; it is not a natural-language
accuracy benchmark.

Studio adapter tests now verify that a disconnected selected instance and a
non-Edit Studio mode both stop before any Open Cloud request. A separate case
simulates successful Open Cloud creation and polling followed by Studio rejecting
`insert_asset`; the service returns failure and does not proceed to inspection.
Together with the existing Open Cloud timeout, malformed response, moderation,
untrusted-operation-path and no-create-retry tests, this covers local adapter
failure boundaries without a live upload or place mutation.

Focused prompt and Studio adapter tests passed (14 tests), and `pnpm typecheck`
passed. Live disconnect and contract-change cases remain planned; no autonomous
learning or new Gate 2 claim is introduced.

## Asset holdout and MCP boundary follow-up on 2026-09-27

The generated Blender matrix now includes an image-textured material, a weighted
one-bone armature, a mesh with a missing face, and loose geometry. The deterministic
inspector records the share of manifold edges and whether mesh vertices or edges
are loose. Those observations are warnings; this change does not decide that such
assets are unusable. The real export/reimport test confirms the non-manifold ratio,
the rig's bones, black material and 2x world dimensions where applicable. Skinning
weights and animation are not yet verified.

`pnpm test:blender` ran all eight fixture cases on installed Blender 5.2.2 LTS and
passed. The textured input reached the pipeline with no flat base color and was
replaced by the deterministic black material; the resulting FBX retained the
expected objective color and dimensions. These tests are local Blender evidence,
not Roblox importer or Studio evidence.

The Explorer result normalizer now fails on MCP's explicit `isError` flag, so a
failed tree query cannot be mistaken for a valid empty place. Broker tests exercise
an upstream disconnect as a typed failure and confirm each `tools/list` call sees
an updated upstream schema. The generated-program and broker test files currently
pass 10 and 7 focused tests, respectively. No live Studio disconnect or contract
change, Open Cloud upload, place mutation, or Gate 2 run occurred in this follow-up.
The next validation step is to observe those MCP failures against the running
selected Studio version, then extend local holdouts for transparency, animation and
skinning, degenerate/high-complexity geometry, and FBX packaging edge cases.
