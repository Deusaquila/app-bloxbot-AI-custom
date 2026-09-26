import { createHash, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import type { AssetFingerprint, Vector3 } from "../../src/types/asset";
import type { Artifact, Evidence, ExecutionOperation, Job } from "../../src/types/job";
import { compileKnownV1Task } from "../control/TaskCompiler";
import { buildV1ExecutionPlan } from "../control/ExecutionPlanner";
import { CapabilityRouterLive } from "../control/CapabilityRouter";
import { evaluateGate1 } from "../control/Gate1";
import { evaluateGate2 } from "../control/Gate2";
import { determineJobOutcome } from "../control/ResultEngine";
import { JobService } from "./JobService";
import { WorkspaceService } from "./WorkspaceService";
import { ArtifactService } from "./ArtifactService";
import { BlenderService } from "./BlenderService";
import { makeBlenderServiceLayer } from "./BlenderServiceLive";
import { makeRobloxServiceLayer } from "./RobloxServiceLive";
import { type RobloxAssetRef, type RobloxAssetFingerprint } from "./RobloxService";
import { ExecutionService, ExecutionServiceLive } from "./ExecutionService";
import type { OpenCloudOptions } from "./RobloxOpenCloud";
import { StudioMcpBroker } from "./StudioMcpBroker";

export interface V1JobInput {
  sourcePath: string;
  prompt: string;
  studioId: string;
}
export interface V1RunnerOptions {
  blenderExecutable: string;
  blenderScript: string;
  openCloud: OpenCloudOptions;
}
export function dimensionRatios(before: Vector3, after: Vector3): number[] {
  return (["x", "y", "z"] as const).flatMap((axis) =>
    before[axis] > 1e-8 ? [after[axis] / before[axis]] : after[axis] <= 1e-8 ? [] : [0],
  );
}
export function matchesScale(before: Vector3, after: Vector3, factor: number): boolean {
  const ratios = dimensionRatios(before, after);
  return (
    ratios.length > 0 && ratios.every((r) => Number.isFinite(r) && Math.abs(r - factor) <= 0.01)
  );
}
export function matchesColor(asset: RobloxAssetFingerprint, expected: readonly number[]): boolean {
  return (
    asset.texturedParts === 0 &&
    asset.colors.length > 0 &&
    asset.colors.every(
      (c) => c.length === expected.length && c.every((v, i) => Math.abs(v - expected[i]) <= 1e-5),
    )
  );
}

/** Jobs own transitions and checkpoints. Adapters own effects; no AI is in the control loop. */
export function runV1Job(input: V1JobInput, options: V1RunnerOptions) {
  return Effect.gen(function* () {
    const jobs = yield* JobService;
    const workspaces = yield* WorkspaceService;
    const artifacts = yield* ArtifactService;
    const broker = yield* StudioMcpBroker;
    const job = yield* jobs.create({
      prompt: input.prompt,
      inputAssets: [],
      studioId: input.studioId,
    });
    const update = (f: (current: Job) => Job) => jobs.checkpoint(job.id, f);
    const evidence = (
      source: Evidence["source"],
      type: string,
      value: unknown,
      requirementId?: string,
    ): Evidence => ({
      id: randomUUID(),
      jobId: job.id,
      source,
      type,
      value,
      requirementId,
      capturedAt: new Date().toISOString(),
    });
    const addEvidence = (item: Evidence) =>
      update((current) => ({ ...current, evidence: [...(current.evidence ?? []), item] }));
    const record = (op: ExecutionOperation) =>
      update((current) => {
        const previous = current.executionPlan?.operations ?? [];
        const result = op.result as { value?: { artifact?: Artifact } } | undefined;
        let artifact = result?.value?.artifact;
        if (op.capability === "roblox.import_asset" && op.status === "SUCCEEDED") {
          const imported = (op.result as { value: RobloxAssetRef }).value;
          artifact = {
            id: op.id,
            jobId: job.id,
            type: "ROBLOX_ASSET",
            path: "rbxassetid://" + imported.id,
            parentArtifactId: (op.input as { artifact: Artifact }).artifact.id,
            createdByOperationId: op.id,
            createdAt: new Date().toISOString(),
          };
        }
        return {
          ...current,
          executionPlan: {
            operations: previous.some((p) => p.id === op.id)
              ? previous.map((p) => (p.id === op.id ? { ...op, dependsOn: p.dependsOn } : p))
              : [...previous, op],
          },
          artifacts: artifact
            ? [...(current.artifacts ?? []).filter((a) => a.id !== artifact.id), artifact]
            : current.artifacts,
        };
      }).pipe(Effect.asVoid);
    const work = Effect.gen(function* () {
      const discovered = yield* broker.listTools;
      const contract = discovered.tools
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
        .sort((a, b) => a.name.localeCompare(b.name));
      yield* addEvidence(
        evidence("ROBLOX", "mcp.contract", {
          sha256: createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
          tools: contract,
        }),
      );
      yield* jobs.transition(job.id, "INSPECTING");
      const workspace = yield* workspaces.ensureJob(job.id);
      const original = yield* artifacts.registerFile({
        jobId: job.id,
        type: "INPUT_FBX",
        sourcePath: input.sourcePath,
        destinationDirectory: workspace.input,
      });
      const assetId = randomUUID();
      yield* update((current) => ({
        ...current,
        inputAssets: [{ assetId, artifactId: original.id }],
        artifacts: [original],
      }));
      const blenderLayer = makeBlenderServiceLayer({
        executable: options.blenderExecutable,
        assetId,
        inputArtifact: original,
        workspace,
        script: options.blenderScript,
      }).pipe(Layer.provide(Layer.succeed(ArtifactService, artifacts)));
      const cloud = makeRobloxServiceLayer({
        ...options.openCloud,
        onReceipt: (receipt) =>
          Effect.runPromise(
            addEvidence(evidence("ROBLOX", "upload.receipt", receipt)).pipe(Effect.asVoid),
          ),
        onOperation: (path) =>
          Effect.runPromise(
            addEvidence(evidence("ROBLOX", "upload.operation", { path })).pipe(Effect.asVoid),
          ),
        onUploaded: (artifactId, id) =>
          Effect.runPromise(
            addEvidence(evidence("ROBLOX", "upload.completed", { artifactId, assetId: id })).pipe(
              Effect.asVoid,
            ),
          ),
        onInserted: (asset, result) =>
          Effect.runPromise(
            addEvidence(evidence("ROBLOX", "import.inserted", { asset, result })).pipe(
              Effect.asVoid,
            ),
          ),
        onImportIntent: (asset) =>
          Effect.runPromise(
            addEvidence(evidence("ROBLOX", "import.intent", asset)).pipe(Effect.asVoid),
          ),
      }).pipe(Layer.provide(Layer.succeed(StudioMcpBroker, broker)));
      const adapters = Layer.merge(blenderLayer, cloud);
      const engineLayer = ExecutionServiceLive.pipe(
        Layer.provide(CapabilityRouterLive.pipe(Layer.provide(adapters))),
      );
      return yield* Effect.gen(function* () {
        const blender = yield* BlenderService;
        const engine = yield* ExecutionService;
        const initial = yield* blender.inspectAsset(assetId, original);
        yield* addEvidence(evidence("INPUT", "asset.inspection", initial));
        yield* jobs.transition(job.id, "COMPILING");
        const compiled = compileKnownV1Task(input.prompt, initial);
        if (!compiled || compiled.requirements.length !== 2)
          return yield* Effect.fail(
            new Error("V1 requires the supported black and double-size task"),
          );
        yield* jobs.transition(job.id, "PLANNING");
        const plan = buildV1ExecutionPlan(compiled.requirements);
        yield* update((current) => ({
          ...current,
          requirements: compiled.requirements.map((r) => ({ ...r, status: "PLANNED" })),
          executionPlan: plan,
        }));
        yield* jobs.transition(job.id, "EXECUTING");
        const executed = yield* engine.execute(
          { operations: plan.operations.filter((op) => op.capability !== "asset.export_fbx") },
          record,
        );
        const resultOf = (capability: string) =>
          (
            executed.find((op) => op.capability === capability)?.result as {
              value: Record<string, unknown>;
            }
          ).value;
        const materialValid = resultOf("asset.verify_material").valid === true;
        const dimensions = resultOf("asset.verify_dimensions").dimensions as Vector3;
        const dimsValid = matchesScale(initial.dimensions, dimensions, 2);
        yield* update((current) => ({
          ...current,
          requirements: current.requirements.map((r) => ({ ...r, status: "EXECUTED" })),
        }));
        yield* jobs.transition(job.id, "VERIFYING_GATE_1");
        const proof1 = evidence("BLENDER", "gate1.observed", {
          materialValid,
          dimensions,
          baseline: initial.dimensions,
        });
        yield* addEvidence(proof1);
        const gate1 = evaluateGate1({
          materialValid,
          dimensionsValid: dimsValid,
          geometryValid: initial.meshes > 0 && initial.vertices > 0 && initial.triangles > 0,
          exportReady: initial.issues.every((issue) => issue.severity !== "ERROR"),
          evidenceIds: [proof1.id],
        });
        yield* update((current) => ({
          ...current,
          report: { gate1 },
          requirements: current.requirements.map((r) => ({
            ...r,
            status: gate1.passed ? "GATE_1_VERIFIED" : "FAILED",
          })),
        }));
        if (!gate1.passed) return yield* Effect.fail(new Error("GATE_1_FAILED"));
        yield* jobs.transition(job.id, "EXPORTING");
        const exportOp = plan.operations.find((op) => op.capability === "asset.export_fbx")!;
        const exported = yield* engine.execute(
          { operations: [{ ...exportOp, dependsOn: [] }] },
          record,
        );
        const output = (
          exported[0].result as { value: { artifact: Artifact; fingerprint: AssetFingerprint } }
        ).value;
        yield* addEvidence(evidence("EXPORT", "asset.exported", output));
        yield* jobs.transition(job.id, "IMPORTING");
        const perform = (capability: string, parameters: unknown) =>
          engine
            .execute(
              {
                operations: [
                  {
                    id: randomUUID(),
                    capability,
                    requirementIds: compiled.requirements.map((r) => r.id),
                    dependsOn: [],
                    input: parameters,
                    executor: "ROBLOX",
                    status: "PENDING",
                    attempts: 0,
                  },
                ],
              },
              record,
            )
            .pipe(Effect.map((ops) => (ops[0].result as { value: unknown }).value));
        // Baseline import avoids assuming an FBX-to-stud unit conversion.
        const reference = yield* perform("roblox.import_asset", {
          artifact: original,
          studioId: input.studioId,
        }) as Effect.Effect<RobloxAssetRef, unknown>;
        const baseline = yield* perform("roblox.inspect_asset", {
          asset: reference,
        }) as Effect.Effect<RobloxAssetFingerprint, unknown>;
        yield* addEvidence(evidence("ROBLOX", "baseline.inspection", { reference, baseline }));
        const imported = yield* perform("roblox.import_asset", {
          artifact: output.artifact,
          studioId: input.studioId,
        }) as Effect.Effect<RobloxAssetRef, unknown>;
        const projected = yield* perform("roblox.apply_verified_material", {
          asset: imported,
          fingerprint: output.fingerprint,
        });
        yield* addEvidence(
          evidence("ROBLOX", "material.projected", {
            imported,
            exportedArtifactId: output.artifact.id,
            exportedHash: output.artifact.hash,
            observed: projected,
          }),
        );
        yield* jobs.transition(job.id, "VERIFYING_GATE_2");
        const observed = yield* perform("roblox.inspect_asset", {
          asset: imported,
        }) as Effect.Effect<RobloxAssetFingerprint, unknown>;
        const proof2 = evidence("ROBLOX", "asset.inspection", { imported, observed });
        yield* addEvidence(proof2);
        const preserved = matchesScale(baseline.dimensions, observed.dimensions, 2);
        const black = matchesColor(observed, [0, 0, 0, 1]);
        const gate2 = evaluateGate2({
          imported: true,
          expectedObjectsPresent: baseline.objects === observed.objects,
          expectedMaterialsPresent: observed.materials > 0,
          dimensionsPreserved: preserved,
          hierarchyValid: observed.hierarchyValid,
          evidenceIds: [proof2.id],
        });
        const evaluations = compiled.requirements.map((r) => ({
          requirementId: r.id,
          status: (r.type === "material.base_color" ? black : preserved)
            ? ("PASS" as const)
            : ("FAIL" as const),
          expected: r.expected,
          observed:
            r.type === "material.base_color"
              ? observed.colors
              : dimensionRatios(baseline.dimensions, observed.dimensions),
          confidence: 1,
          evidenceIds: [proof2.id],
        }));
        for (const evaluation of evaluations)
          yield* addEvidence(
            evidence(
              "ROBLOX",
              "requirement.observed",
              evaluation.observed,
              evaluation.requirementId,
            ),
          );
        yield* update((current) => ({
          ...current,
          report: { gate1, gate2, evaluations },
          requirements: current.requirements.map((r) => ({
            ...r,
            status: gate2.passed ? "GATE_2_VERIFIED" : "FAILED",
          })),
        }));
        yield* jobs.transition(job.id, "EVALUATING");
        const outcome = determineJobOutcome(gate1, gate2, evaluations);
        yield* update((current) => ({
          ...current,
          report: { gate1, gate2, evaluations, outcome, reference, imported },
          requirements: current.requirements.map((r) => ({
            ...r,
            status:
              evaluations.find((e) => e.requirementId === r.id)?.status === "PASS" && gate2.passed
                ? "PASSED"
                : "FAILED",
          })),
        }));
        return yield* jobs.transition(job.id, outcome.completed ? "COMPLETED" : "FAILED");
      }).pipe(Effect.provide(Layer.merge(adapters, engineLayer)));
    });
    return yield* work.pipe(
      Effect.catchAll(() =>
        Effect.gen(function* () {
          const current = yield* jobs.get(job.id);
          yield* update((j) => ({
            ...j,
            report: {
              previous: j.report,
              error:
                "V1 stopped in " +
                current.state +
                "; inspect persisted operations and evidence before retrying.",
            },
          }));
          return yield* jobs.transition(job.id, "FAILED");
        }),
      ),
    );
  });
}
