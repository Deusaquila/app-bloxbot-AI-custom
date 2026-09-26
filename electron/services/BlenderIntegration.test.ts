import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  it("preserves color and multi-root scaling through derived scenes and exported FBX", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloxbot-blender-"));
    dirs.push(root);
    const source = join(root, "source.fbx");
    const script = `import bpy,sys\nbpy.ops.wm.read_factory_settings(use_empty=True)\nfor x in (0,4):\n bpy.ops.mesh.primitive_cube_add(location=(x,0,0))\nbpy.ops.export_scene.fbx(filepath=sys.argv[-1],bake_anim=False)\n`;
    await Effect.runPromise(
      runBlenderScript(
        { executable: executable! },
        { script, scriptPath: join(root, "fixture.py"), args: [source] },
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
      expect(initial.triangles).toBe(24);
      await Promise.all([
        invoke("material.set_base_color", { expected: [0, 0, 0, 1] }),
        invoke("transform.scale_uniform", { expected: 2 }),
      ]);
      expect(
        (await invoke("asset.verify_material", { expected: [0, 0, 0, 1] })).value,
      ).toMatchObject({ valid: true });
      const final = (await invoke("asset.inspect")).value as AssetFingerprint;
      expect(matchesScale(initial.dimensions, final.dimensions, 2)).toBe(true);
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
  }, 180_000);
});
