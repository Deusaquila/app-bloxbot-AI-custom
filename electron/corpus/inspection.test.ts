import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssetFingerprint } from "../../src/types/asset";
import { inspectCorpusAsset } from "./inspection";

const processMocks = vi.hoisted(() => ({ runBlenderScript: vi.fn() }));
vi.mock("../services/BlenderProcess", () => ({
  runBlenderScript: processMocks.runBlenderScript,
}));

const fingerprint: AssetFingerprint = {
  assetId: "polyhaven:chair",
  format: "fbx",
  objects: 1,
  meshes: 1,
  vertices: 8,
  triangles: 12,
  materials: [],
  dimensions: { x: 1, y: 2, z: 3 },
  transforms: { scale: [1, 1, 1], rotation: [0, 0, 0] },
  rig: { exists: false },
  topology: {},
  issues: [],
};

const createdDirectories: string[] = [];
let capturedRequest: unknown;
afterEach(async () => {
  processMocks.runBlenderScript.mockReset();
  capturedRequest = undefined;
  await Promise.all(
    createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function sourceFile(name: string, contents: string) {
  const directory = await mkdtemp(join(tmpdir(), "bloxbot-corpus-inspection-test-"));
  createdDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, contents, { flag: "wx" });
  return path;
}

function mockInspectionResponse(response: unknown) {
  processMocks.runBlenderScript.mockImplementation((_options, input) =>
    Effect.tryPromise(async () => {
      const responsePath = input.args?.[1];
      if (!responsePath) throw new Error("Inspection response path was not passed to Blender");
      const requestPath = input.args?.[0];
      if (!requestPath) throw new Error("Inspection request path was not passed to Blender");
      capturedRequest = JSON.parse(await readFile(requestPath, "utf8"));
      await writeFile(responsePath, JSON.stringify(response), { flag: "wx" });
      return { stdout: "", stderr: "" };
    }),
  );
}

const commonOptions = {
  assetId: "polyhaven:chair",
  blenderExecutable: "blender",
  blenderScript: "# production v1_pipeline.py",
};

describe("job-independent corpus inspection", () => {
  it("uses the production schema for FBX and leaves the raw source unchanged", async () => {
    const path = await sourceFile("asset.FBX", "raw fbx bytes");
    mockInspectionResponse(fingerprint);

    const result = await inspectCorpusAsset({ ...commonOptions, sourcePath: path, timeoutMs: 45_000 });

    expect(result).toMatchObject({
      status: "INSPECTED",
      assetId: "polyhaven:chair",
      sourcePath: path,
      sourceFormat: ".fbx",
      fingerprint,
      inspectorVersion: `sha256:${createHash("sha256").update(commonOptions.blenderScript).digest("hex")}`,
      blenderVersion: null,
    });
    expect(await readFile(path, "utf8")).toBe("raw fbx bytes");
    expect(processMocks.runBlenderScript).toHaveBeenCalledOnce();
    expect(processMocks.runBlenderScript.mock.calls[0][0]).toEqual({
      executable: "blender",
      timeoutMs: 45_000,
    });
    const [{ scriptPath, args }] = processMocks.runBlenderScript.mock.calls[0].slice(1);
    await expect(readFile(scriptPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(args[0])).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(args[1])).rejects.toMatchObject({ code: "ENOENT" });
    expect(capturedRequest).toMatchObject({
      assetId: "polyhaven:chair",
      assetPath: path,
      capability: "asset.inspect",
      input: {},
    });
  });

  it("preserves .blend as the source format independently of the production fingerprint format", async () => {
    const path = await sourceFile("asset.blend", "raw blend bytes");
    mockInspectionResponse(fingerprint);

    const result = await inspectCorpusAsset({ ...commonOptions, sourcePath: path });

    expect(result.status).toBe("INSPECTED");
    if (result.status !== "INSPECTED") throw new Error("Expected a supported format");
    expect(result.sourceFormat).toBe(".blend");
    expect(result.fingerprint.format).toBe("fbx");
    expect(await readFile(path, "utf8")).toBe("raw blend bytes");
  });

  it("returns an explicit unsupported-format result without starting Blender", async () => {
    const path = await sourceFile("asset.obj", "raw obj bytes");

    const result = await inspectCorpusAsset({ ...commonOptions, sourcePath: path });

    expect(result).toEqual({
      status: "UNSUPPORTED_FORMAT",
      assetId: "polyhaven:chair",
      sourcePath: path,
      extension: ".obj",
      supportedExtensions: [".fbx", ".blend"],
    });
    expect(processMocks.runBlenderScript).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("raw obj bytes");
  });

  it("rejects a Blender response that does not satisfy AssetFingerprintSchema", async () => {
    const path = await sourceFile("asset.fbx", "raw fbx bytes");
    mockInspectionResponse({ ...fingerprint, meshes: -1 });

    await expect(inspectCorpusAsset({ ...commonOptions, sourcePath: path })).rejects.toThrow(
      "invalid production asset fingerprint",
    );
    expect(await readFile(path, "utf8")).toBe("raw fbx bytes");
  });
});
