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

The acceptance ran through the application services using the repository CLI.
The desktop IPC/UI path is wired and built; a full desktop button-driven acceptance
run was not performed. Studio window capture timed out; MCP viewport capture worked.
The installed Roblox mcp.bat prints malformed trailing batch lines on shutdown;
live MCP operations succeed. The launcher was not modified.

Review history: no AGENTS.md was found in the repository/ancestors. The handoff was
read in full; no unresolved inline PR reviews existed. The alternate old branch
`codex/read-project-handoff-document` was inspected; its persistence work was already
superseded by this implementation. No main merge, reset or force push was performed.

See [Windows setup](WINDOWS_V1_ENVIRONMENT.md) and [smoke test](V1_LOCAL_SMOKE_TEST.md).
References: [Roblox Assets API](https://create.roblox.com/docs/cloud/guides/usage-assets),
[Roblox Blender export settings](https://create.roblox.com/docs/art/characters/creating/blender-configurations).
