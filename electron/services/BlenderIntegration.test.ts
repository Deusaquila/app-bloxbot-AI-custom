import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ArtifactService, ArtifactServiceLive } from "./ArtifactService";
import { makeWorkspaceServiceLayer, WorkspaceService } from "./WorkspaceService";
import { BlenderService } from "./BlenderService";
import { makeBlenderServiceLayer } from "./BlenderServiceLive";
import { runBlenderScript } from "./BlenderProcess";
import { matchesScale } from "./V1JobRunner";
import type { AssetFingerprint } from "../../src/types/asset";
const executable = process.env.BLOXBOT_TEST_BLENDER;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe.skipIf(!executable)("Real Blender round trip", () => {
  it.each([
    "multi-root",
    "rotated-multi-material",
    "centimeter-units",
    "textured-material",
    "rigged",
    "non-manifold",
    "loose-geometry",
    "disconnected-components",
    "degenerate-face",
  ])(
    "preserves black material and absolute 2x scale through the %s FBX fixture",
    async (fixture) => {
    const root = await mkdtemp(join(tmpdir(), "bloxbot-blender-"));
    dirs.push(root);
    const source = join(root, "source.fbx");
    const script = await readFile("electron/blender/create_test_fbx.py", "utf8");
    await Effect.runPromise(
      runBlenderScript(
        { executable: executable! },
        { script, scriptPath: join(root, "fixture.py"), args: [fixture, source] },
      ),
    );
    const services = Layer.merge(ArtifactServiceLive, makeWorkspaceServiceLayer(root));
    const runtime = ManagedRuntime.make(services);
    const workspace = await runtime.runPromise(
      Effect.flatMap(WorkspaceService, (w) => w.ensureJob("test")),
    );
    const artifact = await runtime.runPromise(
      Effect.flatMap(ArtifactService, (a) =>
        a.registerFile({
          jobId: "test",
          type: "INPUT_FBX",
          sourcePath: source,
          destinationDirectory: workspace.input,
        }),
      ),
    );
    const code = await readFile("electron/blender/v1_pipeline.py", "utf8");
    const blender = ManagedRuntime.make(
      makeBlenderServiceLayer({
        executable: executable!,
        assetId: "asset",
        inputArtifact: artifact,
        workspace,
        script: code,
      }).pipe(Layer.provide(ArtifactServiceLive)),
    );
    try {
      const invoke = (name: string, input: unknown = {}) =>
        blender.runPromise(Effect.flatMap(BlenderService, (b) => b.executeCapability(name, input)));
      const initial = (await invoke("asset.inspect")).value as AssetFingerprint;
      expect(initial.meshes).toBeGreaterThan(0);
      expect(initial.geometry?.meshes).toHaveLength(initial.meshes);
      expect(initial.geometry?.omittedMeshes).toBe(0);
      expect(initial.structure?.omittedObjects).toBe(0);
      expect(initial.structure?.objectNodes.length).toBe(initial.objects);
      expect(
        initial.geometry?.meshes?.every((mesh) =>
          mesh.materialSlots.every((slot) => slot.objectId === mesh.objectId),
        ),
      ).toBe(true);
      if (fixture === "multi-root") {
        expect(initial.geometry?.meshes?.every((mesh) => mesh.unmappedFaces === mesh.faces)).toBe(true);
      } else {
        expect(initial.geometry?.meshes?.every((mesh) => mesh.unmappedFaces === 0)).toBe(true);
      }
      if (["multi-root", "rotated-multi-material", "centimeter-units"].includes(fixture)) {
        expect(initial.meshes).toBeGreaterThanOrEqual(2);
      }
      expect(initial.triangles).toBeGreaterThan(0);
      if (fixture === "multi-root") {
        expect(initial.structure?.rootObjects).toBeGreaterThanOrEqual(2);
        expect(initial.geometry?.meshes?.map((mesh) => mesh.objectId).join(" ")).toMatch(/LeftCube/);
        expect(initial.geometry?.meshes?.map((mesh) => mesh.objectId).join(" ")).toMatch(/RightCube/);
      }
      if (fixture === "rotated-multi-material") {
        expect(initial.structure?.parentedObjects).toBeGreaterThan(0);
        expect(initial.structure?.objectNodes.some((node) => node.parentId !== undefined)).toBe(true);
        expect(initial.geometry?.meshes?.some((mesh) =>
          mesh.materialSlots.some((slot) => slot.assignedFaces > 0 && slot.materialName !== undefined),
        )).toBe(true);
        expect(initial.materials.every((m) => m.hasTextures === false && m.alpha === 1)).toBe(true);
      }
      if (fixture === "textured-material") {
        expect(initial.materials.some((m) => m.baseColor === undefined)).toBe(true);
        expect(initial.materials.some((m) =>
          m.hasTextures === true && m.textureImages?.some((name) => name.includes("GeneratedColorGrid")),
        )).toBe(true);
      }
      if (fixture === "rigged") {
        expect(initial.rig.exists).toBe(true);
        expect(initial.rig.bones).toBeGreaterThan(0);
        expect(initial.rig.deformBones).toBeGreaterThan(0);
        expect(initial.rig.skinnedMeshes).toBeGreaterThan(0);
        expect(initial.rig.weightedVertices).toBeGreaterThan(0);
        expect(initial.rig.unweightedVertices).toBe(0);
      }
      if (fixture === "non-manifold") {
        expect(initial.topology.manifoldRatio).toBeLessThan(1);
        expect(initial.topology.boundaryEdges).toBeGreaterThan(0);
        expect(initial.issues.map((issue) => issue.code)).toContain("NON_MANIFOLD_EDGES");
      }
      if (fixture === "loose-geometry") {
        expect(initial.topology.looseGeometry).toBe(true);
        expect(initial.topology.looseVertices).toBeGreaterThan(0);
        expect(initial.issues.map((issue) => issue.code)).toContain("LOOSE_GEOMETRY");
      }
      if (fixture === "disconnected-components") {
        expect(initial.geometry?.disconnectedComponents).toBe(1);
        expect(initial.geometry?.meshes?.[0].vertices).toBeGreaterThan(8);
      }
      if (fixture === "degenerate-face") {
        expect(initial.topology.degenerateFaces).toBeGreaterThan(0);
      }
      await Promise.all([
        invoke("material.set_base_color", { expected: [0, 0, 0, 1] }),
        invoke("transform.scale_uniform", { expected: 2 }),
      ]);
      expect(
        (await invoke("asset.verify_material", { expected: [0, 0, 0, 1] })).value,
      ).toMatchObject({ valid: true });
      const final = (await invoke("asset.inspect")).value as AssetFingerprint;
      expect(
        matchesScale(initial.dimensions, final.dimensions, 2),
        `${fixture}: ${JSON.stringify({ initial: initial.dimensions, final: final.dimensions })}`,
      ).toBe(true);
      await invoke("transform.scale_uniform", { expected: 2 });
      const retry = (await invoke("asset.inspect")).value as AssetFingerprint;
      expect(matchesScale(initial.dimensions, retry.dimensions, 2)).toBe(true);
      const output = (await invoke("asset.export_fbx")).value as { artifact: typeof artifact };
      const verify = ManagedRuntime.make(
        makeBlenderServiceLayer({
          executable: executable!,
          assetId: "export",
          inputArtifact: output.artifact,
          workspace,
          script: code,
        }).pipe(Layer.provide(ArtifactServiceLive)),
      );
      try {
        const roundtrip = await verify.runPromise(
          Effect.flatMap(BlenderService, (b) => b.inspectAsset("export", output.artifact)),
        );
        expect(matchesScale(initial.dimensions, roundtrip.dimensions, 2)).toBe(true);
        if (fixture === "rigged") {
          expect(roundtrip.rig.exists).toBe(true);
          expect(roundtrip.rig.bones).toBeGreaterThan(0);
        }
        if (fixture === "non-manifold") {
          expect(roundtrip.topology.manifoldRatio).toBeLessThan(1);
        }
        expect(
          roundtrip.materials.every((m) =>
            m.baseColor?.every((v, i) => Math.abs(v - [0, 0, 0, 1][i]) < 1e-5),
          ),
        ).toBe(true);
      } finally {
        await verify.dispose();
      }
      expect(artifact.hash).toBeDefined();
      expect(output.artifact.parentArtifactId).not.toBe(artifact.id);
    } finally {
      await blender.dispose();
      await runtime.dispose();
    }
    },
    180_000,
  );

  it("reports animation clip names on an animated rigged FBX", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloxbot-blender-animation-"));
    dirs.push(root);
    const source = join(root, "source.fbx");
    const fixtureScript = await readFile("electron/blender/create_test_fbx.py", "utf8");
    await Effect.runPromise(
      runBlenderScript(
        { executable: executable! },
        {
          script: fixtureScript,
          scriptPath: join(root, "fixture.py"),
          args: ["animated-rigged", source],
        },
      ),
    );
    const services = Layer.merge(ArtifactServiceLive, makeWorkspaceServiceLayer(root));
    const runtime = ManagedRuntime.make(services);
    const workspace = await runtime.runPromise(
      Effect.flatMap(WorkspaceService, (service) => service.ensureJob("animation-test")),
    );
    const artifact = await runtime.runPromise(
      Effect.flatMap(ArtifactService, (service) =>
        service.registerFile({
          jobId: "animation-test",
          type: "INPUT_FBX",
          sourcePath: source,
          destinationDirectory: workspace.input,
        }),
      ),
    );
    const pipeline = await readFile("electron/blender/v1_pipeline.py", "utf8");
    const blender = ManagedRuntime.make(
      makeBlenderServiceLayer({
        executable: executable!,
        assetId: "animated-asset",
        inputArtifact: artifact,
        workspace,
        script: pipeline,
      }).pipe(Layer.provide(ArtifactServiceLive)),
    );
    try {
      const inspected = await blender.runPromise(
        Effect.flatMap(BlenderService, (service) => service.inspectAsset("animated-asset", artifact)),
      );
      expect(inspected.rig.animationClips?.some((name) => name.includes("TestWalkCycle"))).toBe(true);
      expect(inspected.rig.exists).toBe(true);
    } finally {
      await blender.dispose();
      await runtime.dispose();
    }
  }, 60_000);

  it("rejects an FBX with no mesh before it can be treated as an asset", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloxbot-blender-empty-"));
    dirs.push(root);
    const source = join(root, "empty.fbx");
    const fixtureScript = await readFile("electron/blender/create_test_fbx.py", "utf8");
    const pipelineScript = await readFile("electron/blender/v1_pipeline.py", "utf8");
    await Effect.runPromise(
      runBlenderScript(
        { executable: executable! },
        { script: fixtureScript, scriptPath: join(root, "fixture.py"), args: ["empty", source] },
      ),
    );
    const request = join(root, "inspect.request.json");
    const response = join(root, "inspect.response.json");
    await writeFile(
      request,
      JSON.stringify({ assetId: "empty", assetPath: source, capability: "asset.inspect", input: {} }),
    );

    const failure = await Effect.runPromise(
      Effect.flip(
        runBlenderScript(
          { executable: executable! },
          { script: pipelineScript, scriptPath: join(root, "pipeline.py"), args: [request, response] },
        ),
      ),
    );
    expect(failure).toMatchObject({ _tag: "BlenderProcessError", exitCode: 1 });
    expect(failure.stderr).toContain("Asset contains no meshes");
  }, 60_000);
});
