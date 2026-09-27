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
  it.each(["multi-root", "rotated-multi-material", "centimeter-units"])(
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
      expect(initial.meshes).toBeGreaterThanOrEqual(2);
      expect(initial.triangles).toBeGreaterThan(0);
      await Promise.all([
        invoke("material.set_base_color", { expected: [0, 0, 0, 1] }),
        invoke("transform.scale_uniform", { expected: 2 }),
      ]);
      expect(
        (await invoke("asset.verify_material", { expected: [0, 0, 0, 1] })).value,
      ).toMatchObject({ valid: true });
      const final = (await invoke("asset.inspect")).value as AssetFingerprint;
      expect(matchesScale(initial.dimensions, final.dimensions, 2)).toBe(true);
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
