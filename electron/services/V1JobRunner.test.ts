import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { makeV1Runtime } from "./V1Runtime";
import { runV1Job } from "./V1JobRunner";
import { hasCompletionEvidence } from "../control/completionEvidence";
import { JobService } from "./JobService";
import { StudioMcpBroker } from "./StudioMcpBroker";
const controls = vi.hoisted(() => ({
  badMaterial: false,
  badRobloxColor: false,
  inspectionFails: false,
  imports: 0,
}));
vi.mock("./BlenderServiceLive", async () => {
  const { BlenderService } = await import("./BlenderService");
  return {
    makeBlenderServiceLayer: (options: import("./BlenderServiceLive").BlenderJobOptions) => {
      const initial = {
        assetId: options.assetId,
        format: "fbx" as const,
        objects: 1,
        meshes: 1,
        vertices: 8,
        triangles: 12,
        materials: [],
        dimensions: { x: 1, y: 2, z: 3 },
        transforms: { scale: [1, 1, 1] as const, rotation: [0, 0, 0] as const },
        rig: { exists: false },
        topology: {},
        issues: [],
      };
      const artifact = {
        ...options.inputArtifact,
        id: "export",
        type: "EXPORTED_FBX" as const,
        parentArtifactId: options.inputArtifact.id,
      };
      return Layer.succeed(
        BlenderService,
        BlenderService.of({
          inspectAsset: () => Effect.succeed(initial),
          exportFbx: () => Effect.succeed(artifact),
          executeCapability: (capability) =>
            Effect.succeed({
              status: "SUCCEEDED",
              value:
                capability === "asset.inspect"
                  ? initial
                  : capability === "asset.verify_material"
                    ? { valid: !controls.badMaterial }
                    : capability === "asset.verify_dimensions"
                      ? { dimensions: { x: 2, y: 4, z: 6 } }
                      : capability === "asset.export_fbx"
                        ? { artifact, fingerprint: initial }
                        : { changed: true },
            }),
        }),
      );
    },
  };
});
vi.mock("./RobloxServiceLive", async () => {
  const { RobloxService, RobloxServiceError } = await import("./RobloxService");
  return {
    makeRobloxServiceLayer: () =>
      Layer.succeed(
        RobloxService,
        RobloxService.of({
          importAsset: (_artifact, studioId) => {
            controls.imports++;
            return Effect.succeed({
              id: String(controls.imports),
              studioId,
              instanceName: "BloxBot_test",
            });
          },
          inspectAsset: (asset) =>
            controls.inspectionFails
              ? Effect.fail(new RobloxServiceError({ message: "Disconnected" }))
              : Effect.succeed({
                  objects: 1,
                  materials: 1,
                  hierarchyValid: true,
                  texturedParts: 0,
                  colors: [controls.badRobloxColor ? [1, 0, 0, 1] : [0, 0, 0, 1]],
                  dimensions: asset.id === "1" ? { x: 1, y: 2, z: 3 } : { x: 2, y: 4, z: 6 },
                }),
          applyVerifiedMaterial: () =>
            Effect.succeed({
              objects: 1,
              materials: 1,
              hierarchyValid: true,
              texturedParts: 0,
              colors: [[0, 0, 0, 1]],
              dimensions: { x: 2, y: 4, z: 6 },
            }),
          captureEvidence: () => Effect.succeed([]),
        }),
      ),
  };
});
const dirs: string[] = [];
beforeEach(() => {
  Object.assign(controls, {
    badMaterial: false,
    badRobloxColor: false,
    inspectionFails: false,
    imports: 0,
  });
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const broker = Layer.succeed(StudioMcpBroker, {
  info: { url: "test" },
  listTools: Effect.succeed({ tools: [] }),
  callTool: () => Effect.succeed({ content: [] }),
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bloxbot-job-"));
  dirs.push(root);
  const source = join(root, "test.fbx");
  await writeFile(source, "fake adapter input");
  return { root, source };
}
const options = {
  blenderExecutable: "fake",
  blenderScript: "fake",
  openCloud: { credentialPath: "unused", creator: { type: "user" as const, id: "42" } },
};
describe("V1 orchestration (adapter-boundary fakes, not Gate 2 proof)", () => {
  it("completes only after both gates and restores results, hashes, lineage and evidence", async () => {
    const { root, source } = await fixture();
    const runtime = makeV1Runtime(root, broker);
    const job = await runtime.runPromise(
      runV1Job(
        { sourcePath: source, studioId: "selected", prompt: "Gör den svart och dubbelt så stor." },
        options,
      ),
    );
    expect(job.state).toBe("COMPLETED");
    expect(hasCompletionEvidence(job)).toBe(true);
    expect(hasCompletionEvidence({ ...job, evidence: [] })).toBe(false);
    expect(hasCompletionEvidence({ ...job, requirements: [] })).toBe(false);
    expect(hasCompletionEvidence({ ...job, executionPlan: { operations: [] } })).toBe(false);
    expect(
      hasCompletionEvidence({
        ...job,
        requirements: job.requirements.map((r) => ({ ...r, status: "PENDING" })),
      }),
    ).toBe(false);
    const report = job.report as Record<string, unknown>;
    expect(hasCompletionEvidence({ ...job, report: { ...report, evaluations: [] } })).toBe(false);
    expect(job.requirements.every((r) => r.status === "PASSED")).toBe(true);
    expect(job.environment.studioId).toBe("selected");
    expect(job.artifacts?.[0].hash).toHaveLength(64);
    expect(job.executionPlan?.operations.every((op) => op.status === "SUCCEEDED")).toBe(true);
    expect(job.evidence?.filter((e) => e.source === "ROBLOX").length).toBeGreaterThanOrEqual(4);
    await runtime.dispose();
    const restored = makeV1Runtime(root, broker);
    try {
      expect(
        await restored.runPromise(Effect.flatMap(JobService, (jobs) => jobs.get(job.id))),
      ).toEqual(job);
    } finally {
      await restored.dispose();
    }
  });
  it("marks interrupted operations failed on restart without replaying imports", async () => {
    const { root } = await fixture();
    const runtime = makeV1Runtime(root, broker);
    const job = await runtime.runPromise(
      Effect.gen(function* () {
        const jobs = yield* JobService;
        const created = yield* jobs.create({
          prompt: "test",
          inputAssets: [],
          studioId: "selected",
        });
        yield* jobs.transition(created.id, "INSPECTING");
        return yield* jobs.checkpoint(created.id, (current) => ({
          ...current,
          executionPlan: {
            operations: [
              {
                id: "interrupted",
                capability: "roblox.import_asset",
                executor: "ROBLOX",
                input: {},
                dependsOn: [],
                requirementIds: [],
                status: "RUNNING",
                attempts: 1,
              },
            ],
          },
          evidence: [
            {
              id: "receipt",
              jobId: created.id,
              source: "ROBLOX",
              type: "upload.operation",
              value: { path: "operations/saved" },
              capturedAt: new Date().toISOString(),
            },
          ],
        }));
      }),
    );
    await runtime.dispose();
    const restored = makeV1Runtime(root, broker);
    try {
      const recovered = await restored.runPromise(
        Effect.flatMap(JobService, (jobs) => jobs.get(job.id)),
      );
      expect(recovered.state).toBe("FAILED");
      expect(recovered.executionPlan?.operations[0].status).toBe("FAILED");
      expect(recovered.evidence).toEqual(job.evidence);
      expect(controls.imports).toBe(0);
    } finally {
      await restored.dispose();
    }
  });
  it("stops before uploading when Gate 1 fails", async () => {
    controls.badMaterial = true;
    const { root, source } = await fixture();
    const runtime = makeV1Runtime(root, broker);
    try {
      const job = await runtime.runPromise(
        runV1Job(
          {
            sourcePath: source,
            studioId: "selected",
            prompt: "Gör den svart och dubbelt så stor.",
          },
          options,
        ),
      );
      expect(job.state).toBe("FAILED");
      expect(controls.imports).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });
  it("does not treat import success as objective color success", async () => {
    controls.badRobloxColor = true;
    const { root, source } = await fixture();
    const runtime = makeV1Runtime(root, broker);
    try {
      const job = await runtime.runPromise(
        runV1Job(
          {
            sourcePath: source,
            studioId: "selected",
            prompt: "Gör den svart och dubbelt så stor.",
          },
          options,
        ),
      );
      expect(job.state).toBe("FAILED");
      expect(job.requirements.find((r) => r.type === "material.base_color")?.status).toBe("FAILED");
    } finally {
      await runtime.dispose();
    }
  });
  it("records inspection failure without claiming Gate 2", async () => {
    controls.inspectionFails = true;
    const { root, source } = await fixture();
    const runtime = makeV1Runtime(root, broker);
    try {
      const job = await runtime.runPromise(
        runV1Job(
          {
            sourcePath: source,
            studioId: "selected",
            prompt: "Gör den svart och dubbelt så stor.",
          },
          options,
        ),
      );
      expect(job.state).toBe("FAILED");
      expect(job.executionPlan?.operations.some((op) => op.status === "FAILED")).toBe(true);
      expect(JSON.stringify(job.report)).not.toContain('"gate":"GATE_2"');
    } finally {
      await runtime.dispose();
    }
  });
});
