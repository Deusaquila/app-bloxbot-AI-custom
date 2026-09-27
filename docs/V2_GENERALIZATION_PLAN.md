# Generalization V2: production plan

Status: in progress. The verified horse V1 run is regression case 1, not evidence of general prompt support. This plan is subordinate to executed tests and persisted Job evidence. Work stays on `feature/v1-job-core` and draft PR #1; merging to `main` requires the user's explicit approval.

## Release rule

V2 passes only when an unseen supported asset and an unseen feasible instruction reach an inspected, explicitly selected Roblox Studio instance with every mandatory requirement supported by evidence, or return a precise unresolved requirement. A successful upload or import alone is insufficient. Record technical transfer and prompt compliance separately. Never count `UNKNOWN` as `PASS`.

## Corpus V1 boundary

Corpus V1 is a separate evaluation/development subsystem. It may consume the production `AssetFingerprint`, Asset Inspector, and asset/artifact contracts; production contracts remain authoritative. Keep production inspection callable without Electron UI, a complete Job, or corpus services. Normal BloxBot Jobs must not depend on Poly Haven, a corpus database, or benchmark infrastructure. Do not add Corpus-specific behavior to inspection semantics. Wait to integrate a Benchmark Runner until Requirement IR and Job boundaries are stable. Use early corpus assets as held-out evidence, never as asset-specific product rules.

## Phase 0: lock the baseline

1. Keep `horse_black_2x` as regression case 1, including Gate 1, exact Studio Gate 2, both requirements, persistence, and restart verification.
2. Recheck the current Studio MCP contract and select the disposable `PlaceTest` instance by live `studio_id` before any future live import. Historical Place1 evidence stays historical.
3. Establish local baseline typecheck, control tests, real Blender fixtures, and a sanitized benchmark export. Do not publish user assets or credentials.

Exit: the existing acceptance evidence remains reproducible and no V2 change creates a false `COMPLETED` result.

## Phase 1: validated understanding and property projection

1. Define a typed Requirement IR with target, expected value, verification kind, tolerance, and mandatory status. Validate all external/LLM output at the boundary. Preserve decoding of persisted V1 Jobs.
2. Keep the deterministic compiler as a fast path. Add a bounded LLM compiler fallback for unsupported requests, using the compact asset fingerprint. The model proposes requirements only; it cannot change Job state or invoke arbitrary Blender code. Reject ambiguous, contradictory, ungrounded targets and unsupported requirement types explicitly.
3. Expand deterministic asset inspection for geometry, material, rig and hierarchy facts needed by that compiler. Mark unknown facts explicitly and keep expensive inspection bounded.
4. Replace the black-only Roblox material projection with verified property projection. Require traceable mesh/material mapping and reinspection. Reject cases whose mapping, textures or alpha cannot yet be reproduced reliably.

For the first hosted LLM role trials, prefer a free OpenCode Zen model. The first candidate for text-to-Requirement-IR compilation is `opencode/space-bunny-free`; model availability and terms must be rechecked when a trial is run. Do not select the visual prompt-compliance evaluator yet: compare image-focused models when standardized result renders and semantic evaluation are ready. A compiler adapter is not permission to wire model output into the live Job path; that remains gated on an explicit prompt-coverage strategy and end-to-end evidence.

Exit: a non-black, objective instruction compiles to validated requirements, executes with a known capability, and is checked against actual Studio evidence. The horse case remains green.

Current finding: a real Blender inspection fixture with an action on the armature object's transform reports 2× immediately after scaling but returns to its original size after the saved `.blend` is reopened. Treat animated armature scaling as unsupported until mutation and persistence are fixed and verified through export/reimport. The fixture currently checks inspection metadata only.

## Phase 2: heterogeneous execution and correction

1. Freeze a matrix of generated assets and prompts before measuring changes: simple prop, multi-material, textured, rigged, topology-problematic, and at least one unseen holdout from a different asset family. Keep prompt paraphrases and related meshes in the same split.
2. Extend known capabilities only where the matrix shows a real gap. The planner must reject any requirement with no available, verifiable procedure; it must never silently omit one.
3. Add requirement-targeted correction after Gate 1, Gate 2 or evaluation failure. Diagnose from recorded evidence, rerun the smallest affected operation subgraph and downstream transfer checks, and bound attempts and cost. Avoid duplicate non-idempotent Open Cloud creation.
4. Add semantic evaluation only for requirements that deterministic checks cannot decide, using standardized renders and a separate quality result. Objective measurements retain precedence.

Exit: an unseen supported asset/prompt pair completes or reports the exact failing requirement without code specific to that pair. Benchmark records transfer, each requirement, latency, retries and cost independently.

## Phase 3: measured improvement

Collect enough real Job observations before enabling policy experiments. Keep procedure versions, applicability, failures and user feedback traceable. Promote a policy or procedure only after fixed holdouts show a prompt-compliance or reliability gain without an objective regression. Learning is outside the critical Job state machine.

## Current work orders

| Workstream | Deliverable | Dependency |
| --- | --- | --- |
| Requirement IR | Typed, validated IR and deterministic fast-path compatibility | None |
| Roblox property projection | Verified export properties projected and reinspected, with explicit unsupported cases | Existing export fingerprint |
| Asset inspection | Compact, optional geometry/material/rig/structure metadata and real Blender assertions | None |
| Integration (production lead) | Review shared contracts, build and test a bounded OpenCode compiler adapter, run full tests, and define the prompt-coverage gate before any live fallback | First three workstreams |

## Decision points

- For each new requirement type, specify a verifier and a capability before enabling execution.
- Before enabling an LLM fallback in a Job, require coverage evidence mapping each requested action to requirement IDs or an explicit unresolved reason. Any unsupported, ambiguous, or uncovered action blocks execution. Evaluate models on coverage and false-pass rate as well as schema validity, latency, and token cost; include negation, target scope, and combined-request holdouts.
- Keep model identity and version in job evidence so results can be reproduced. Use the free Zen candidate first when it is still available and configured; never silently fall back to another model.
- Use `PlaceTest` for future disposable Studio runs only after fresh live discovery. Keep upload count and cost visible.
- Do not merge PR #1 to `main` without explicit user approval.

