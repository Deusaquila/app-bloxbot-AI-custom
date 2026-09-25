# BloxBot autonomous asset pipeline — Codex handoff

## Mission

You are the implementation agent for this repository. Continue implementing the autonomous Blender → Roblox asset pipeline in this repository. Work autonomously until the V1 milestone below is complete. Do not ask for routine approval. Ask the user only when genuinely blocked by missing credentials/environment/user action, or when a decision would materially change product direction.

The user prioritizes:
1. self-running operation and high success rate,
2. efficiency: low latency, compute, tokens, retries, and user input,
3. lightweight safety/versioning rather than heavy infrastructure.

Keep changes on `feature/v1-job-core` and the existing draft PR. Do **not** merge to `main` without explicit user approval.

## V1 acceptance test

Input: `horse.fbx`

Prompt:

> Gör den svart och dubbelt så stor.

Required proof:
1. FBX is read successfully.
2. Color change is actually executed.
3. Size change is actually executed.
4. Result is exported/imported into Roblox Studio.
5. Roblox-side evidence verifies the intended objective result.

V1 is objective/deterministic. Do not add perceptual AI evaluation yet.

A successful import alone is **not** task success. Completion requires Gate 1 + Gate 2 + all mandatory requirements.

## Architectural contract

Core loop:

`Compile → Plan → Execute → Observe → Evaluate → Correct`

Input flow:

`Prompt + Asset → Asset Inspector → Task Compiler → Policy/Plan → Execution → Gate 1 → Export → Roblox Import → Gate 2 → Requirement Evaluation → Result`

Longer-term learning sits above this critical path and is deliberately out of V1.

### Hard boundaries

- **JobService** owns job state transitions. AI must never mutate state directly.
- **OpenCode is a bounded reasoning service**, not the orchestrator or source of truth.
- **ChatSession != Job**.
- MCP tools are transport/tooling, not domain capabilities.
- Execution Engine should be dumb: execute a validated DAG and capture results.
- Deterministic evidence outranks AI/perceptual evidence for objective facts.
- Corrections should target the smallest failing requirement and rerun only affected DAG nodes.
- Prefer idempotent capabilities; known no-op outcomes may return `NO_OP_SUCCESS`.
- Keep control-plane persistence separate from legacy `bloxbot-store.json`.

### Service direction

Domain services:
- `BlenderService`
- `RobloxService`
- `AssetInspector`
- `ArtifactService`
- `ExecutionService`
- `JobService`

Transport/runtime adapters may later include:
- direct deterministic Blender `bpy`
- Blender MCP
- Roblox Studio MCP
- OpenCode/AI-generated procedures

The rest of the control plane should not care which adapter implements a capability.

## Job state machine

States:

`CREATED → INSPECTING → COMPILING → PLANNING → EXECUTING → VERIFYING_GATE_1 → EXPORTING → IMPORTING → VERIFYING_GATE_2 → EVALUATING → COMPLETED`

Failure/correction states:
- `FAILED`
- `CANCELLED`
- `CORRECTING`

Correction can be entered from Gate 1, Gate 2, or evaluation, then returns to execution.

Principle for initial V1: **fail correctly before learning to repair**.

## Requirement model

Prompt requirements receive stable IDs and propagate through:
prompt → plan → operation → Blender evidence → export → Roblox evidence → final evaluation.

Initial V1 requirements:
- `material.base_color` → black `[0,0,0,1]`
- `geometry.relative_size` → factor `2`

Requirement lifecycle:
- PENDING
- PLANNED
- EXECUTED
- GATE_1_VERIFIED
- GATE_2_VERIFIED
- PASSED
- FAILED

## Minimal V1 capabilities

- `asset.inspect`
- `material.set_base_color`
- `transform.scale_uniform`
- `asset.verify_material`
- `asset.verify_dimensions`
- `asset.export_fbx`
- `roblox.import_asset`
- `roblox.inspect_asset`

Intended DAG:

`inspect → (set_color || scale) → (verify_color || verify_dimensions) → export → Roblox import → Roblox inspect`

Independent nodes should run concurrently.

## Gates

### Gate 1 — before Roblox

Primarily deterministic:
- material valid
- expected dimensions/scale valid
- geometry/export readiness
- FBX export readiness

### Gate 2 — in Roblox Studio

Ground-truth transport/import verification:
- asset imported
- expected objects present
- materials present
- dimensions survived import
- hierarchy valid
- objective prompt requirements can be checked from Roblox evidence

Gate 2 is not a subjective visual-quality model.

## Evidence and provenance

Evidence sources:
- INPUT
- BLENDER
- EXPORT
- ROBLOX

Artifact lineage should remain explicit, e.g.:

`INPUT_FBX → BLENDER_SCENE → EXPORTED_FBX → ROBLOX_ASSET → REPORT/RENDER`

Artifacts should be immutable references where practical and include provenance/hash.

Per-job workspace target:

```
~/BloxBot/jobs/<job-id>/
  input/
  blender/
  export/
  roblox/
  renders/
  reports/
```

Persist every important transition/operation so crash recovery is possible.

## Current implementation state

At the original handoff point, branch `feature/v1-job-core` was 32 commits ahead of `main` and 0 behind. Re-check branch state before editing; do not rely on this count.

Implemented/started files include:

### Domain/contracts
- `src/types/job.ts`
- `src/types/asset.ts`
- `src/types/evaluation.ts`

### Control plane
- `electron/control/jobStateMachine.ts` + tests
- `electron/control/capabilityRegistry.ts`
- `electron/control/TaskCompiler.ts` + tests
- `electron/control/ExecutionPlanner.ts` + tests
- `electron/control/CapabilityRouter.ts`
- `electron/control/Gate1.ts`
- `electron/control/Gate2.ts`
- `electron/control/EvidenceAggregator.ts`
- `electron/control/RequirementEvaluator.ts`
- `electron/control/ResultEngine.ts` + tests

### Services
- `electron/services/JobStore.ts`
- `electron/services/EventStore.ts`
- `electron/services/JobService.ts`
- `electron/services/WorkspaceService.ts`
- `electron/services/ArtifactService.ts`
- `electron/services/AssetInspector.ts`
- `electron/services/ExecutionService.ts`
- `electron/services/BlenderService.ts`
- `electron/services/BlenderProcess.ts`
- `electron/services/RobloxService.ts`

### Blender V1
- `electron/blender/v1_pipeline.py`

The Blender Python script currently establishes deterministic operations for inspection, material color, uniform scaling, verification, and FBX export. Treat it as an initial implementation to validate and harden, not finished production code.

`ArtifactService` uses streaming SHA-256 so large FBX files need not be loaded fully into Node memory.

The deterministic Task Compiler recognizes the locked Swedish acceptance prompt requirements without invoking an LLM; unsupported semantic tasks should fall through to future reasoning rather than being guessed.

## Existing BloxBot integration to preserve

Existing app architecture is approximately:

React UI → Electron IPC → Electron Main

Electron Main already wires:
- OpenCode
- `StudioMcpBroker`
- `GeneratedProgramRuntime`

`StudioMcpBroker` is Roblox-specific. Do not turn it into a Blender/Roblox god object.

`GeneratedProgramRuntime` is useful for generated procedures, but its `AsyncFunction` mechanism is not a true security sandbox. Do not treat it as one.

Roblox Studio MCP already has multi-Studio concepts and explicit Studio selection. Future Jobs should own `studioId`; Blender can analogously own an instance/session ID if needed.

## Immediate priorities

Before adding learning or UI polish:

1. **Run/establish typecheck and test confidence.** Fix any TypeScript/Effect errors introduced by the branch. Do not claim tests pass unless actually executed by an environment that can run them.
2. Harden `BlenderProcess` and `v1_pipeline.py`; validate request/response contracts and avoid fragile assumptions about Blender versions/material representation.
3. Implement a concrete `BlenderService` layer using the deterministic process adapter.
4. Wire artifact/workspace paths into Blender execution so operations operate on the correct job asset and preserve derived artifacts.
5. Make the V1 DAG executable end-to-end through Gate 1 and FBX export.
6. Implement concrete `RobloxService` using existing `StudioMcpBroker`/Studio MCP. Inspect actual available tool contracts; do not invent tool names or payloads.
7. Extend `CapabilityRouter` to route Roblox capabilities.
8. Add Roblox evidence and Gate 2.
9. Add an orchestration service that drives legal JobService transitions and persists operation/evidence/artifact state.
10. Add bounded failure handling/retry where deterministic and safe.
11. Expose only the minimum UI/IPC needed to start and observe a V1 Job.
12. Prove the locked acceptance test.

If actual Blender or Roblox Studio execution cannot be performed in the Codex execution environment, still complete the code path, automated unit/integration tests with fakes at adapter boundaries, and document the exact local smoke-test steps. Never fabricate a successful real-world run.

## Persistence note

The current `JobStore` is a crash-safe atomic JSON snapshot boundary, not SQLite. That was intentional to establish the service boundary without adding a dependency. It can later be replaced by SQLite behind the interface.

However, artifacts/evidence/operation results need durable persistence before V1 is considered robust. Evolve the store coherently. Prefer a backward-compatible snapshot migration or a clean control-plane store refactor over scattering unrelated files.

## Known areas to review

- Ensure EventStore/JobService error channels remain concrete and typed.
- Ensure the execution engine records RUNNING/SUCCEEDED/FAILED rather than only returning final in-memory operations.
- Validate cycles/missing dependencies in plans before execution.
- Avoid unbounded concurrency if future plans can become large; V1 graph is tiny.
- `ArtifactService` hashes are streaming, but persistence/provenance registration is not yet fully integrated.
- Asset fingerprint topology fields are placeholders until deterministic Blender inspection supplies them.
- Current Task Compiler is deliberately narrow.
- Current `BlenderService` is an interface; wire the real layer.
- Current `RobloxService` is an interface; wire the real adapter.
- Do not infer Roblox MCP tool contracts; inspect them.
- Do not add learning/experiments/multimodal scoring before V1 acceptance is functioning.

## Post-V1 direction — do not implement prematurely

Later architecture should support:
- Procedure Registry: how capabilities are implemented
- Policy Registry: when a procedure is selected
- AI fallback ladder:
  - L0 deterministic
  - L1 known cached procedure
  - L2 policy selection
  - L3 AI-generated procedure
  - L4 exploratory agent
  - L5 human
- Successful AI procedures normalized, parameterized, tested, and promoted
- hypothesis experiments on small traffic allocations (e.g. 10%)
- concurrent/conflicting experiment variants
- automatic rejection + rollback on negative metrics
- accepted hypotheses incorporated into live policy/procedures
- multimodal semantic quality evaluation from standardized Roblox renders

Learning must improve both:
1. technical reliability/import compatibility, and
2. qualitative prompt compliance.

Do not collapse those into one metric.

## Codex execution protocol

Before editing:
1. Inspect `git status`, current branch, diff against `main`, and this document.
2. Run the repository's existing install/typecheck/test commands if the environment permits; establish a real baseline before attributing failures to new work.
3. Inspect nearby existing patterns before introducing new abstractions or dependencies.

While implementing:
- Use the repository filesystem and terminal as the source of truth; do not reconstruct files from this document.
- Run focused tests/typechecks after coherent changes, then the broader relevant suite before declaring the milestone complete.
- Prefer editing and testing locally, then commit coherent verified changes.
- Never overwrite unrelated user changes. If the working tree contains unexpected changes, preserve them and work around them.
- Inspect actual MCP tool contracts/runtime behavior before implementing Roblox calls; never guess names or payloads.
- If Blender/Roblox binaries or GUI access are unavailable, use adapter-boundary tests/fakes and leave an explicit smoke-test checklist rather than fabricating success.
- Keep a short implementation log in commit messages and the draft PR; the code/tests remain the source of truth.

## Working rules

- Prefer small coherent commits.
- Keep the draft PR updated.
- Do not merge `main`.
- Preserve existing BloxBot behavior unless a V1 integration requires a deliberate change.
- Avoid large dependency additions without clear benefit.
- Optimize for autonomous operation and low token/compute overhead.
- Use deterministic code for known operations; use AI only where reasoning is genuinely required.
- Never report an unexecuted test or external integration as successful.
- When blocked, report the exact blocker and the smallest user action needed.

## Definition of done for this Codex handoff

V1 is ready for user review when:
- the branch typechecks/tests in an executable development environment,
- the full control path is wired,
- Blender deterministic edit/export is implemented,
- Roblox import/inspection adapter is implemented against real MCP contracts,
- both gates and requirement evaluation drive the final state,
- state/artifact/evidence provenance survives restart,
- the locked acceptance test has either been executed successfully in a real local Blender+Roblox environment, **or** all code/tests are complete and only an explicitly documented local environment smoke test remains.

At that point, stop before merging and give the user a concise review summary plus any real-world verification still required.
