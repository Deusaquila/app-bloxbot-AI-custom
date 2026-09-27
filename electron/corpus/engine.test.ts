import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetFingerprint } from "../../src/types/asset";
import type { DiscoveredAssetInput } from "./domain";
import type { CorpusSource, DownloadOptions } from "./source";
import { CorpusStore } from "./store";

const mocks = vi.hoisted(() => ({ download: vi.fn(), inspect: vi.fn() }));
vi.mock("./download", () => ({ download: mocks.download }));
vi.mock("./inspection", () => ({ inspectCorpusAsset: mocks.inspect }));

import { CorpusEngine } from "./engine";

const fingerprint: AssetFingerprint = {
  assetId: "fixture",
  format: "fbx",
  objects: 1,
  meshes: 1,
  vertices: 8,
  triangles: 12,
  materials: [{ name: "material", hasTextures: false }],
  dimensions: { x: 1, y: 1, z: 1 },
  transforms: { scale: [1, 1, 1], rotation: [0, 0, 0] },
  rig: { exists: false },
  topology: { manifoldRatio: 1, looseGeometry: false },
  issues: [],
};

const discovered = (id: string): DiscoveredAssetInput => ({
  source: "fixture",
  sourceAssetId: id,
  name: id,
  author: "Fixture Author",
  sourceUrl: `https://example.invalid/a/${id}`,
  license: { id: "CC0", redistributionAllowed: true, commercialUseAllowed: true },
  providerCategories: [id === "a" ? "Furniture" : "Nature"],
});

function downloadOptions(id: string): DownloadOptions {
  const primary = {
    url: `https://example.invalid/files/${id}.fbx`,
    relativePath: `${id}.fbx`,
    filename: `${id}.fbx`,
    format: "fbx",
    size: 10,
    md5: null,
    sourceUrl: `https://example.invalid/files/${id}.fbx`,
    role: "primary" as const,
  };
  return { resolution: "1k", format: "fbx", primary, dependencies: [], alternatives: [] };
}

const tempBase = resolve(tmpdir());
let tempDirectory = "";
let store: CorpusStore;
let source: CorpusSource;

beforeEach(() => {
  tempDirectory = mkdtempSync(join(tempBase, "bloxbot-corpus-engine-test-"));
  store = new CorpusStore(join(tempDirectory, "evaluation.db"));
  source = {
    sourceName: "fixture",
    discover: vi.fn(async () => [discovered("a"), discovered("b")]),
    getMetadata: vi.fn(async (id) => discovered(id)),
    getDownloadOptions: vi.fn(async (id) => downloadOptions(id)),
  };
  mocks.download.mockReset();
  mocks.inspect.mockReset();
  mocks.download.mockImplementation(async (option: DownloadOptions["primary"], root: string) => ({
    path: join(root, option.relativePath),
    filename: option.filename,
    format: option.format,
    sourceUrl: option.sourceUrl,
    sha256: createHash("sha256").update(option.filename).digest("hex"),
    byteSize: option.size,
    downloadedAt: "2026-09-27T12:00:00.000Z",
    skippedExisting: false,
  }));
  mocks.inspect.mockImplementation(async (options: { assetId: string; sourcePath: string; blenderScript: string }) => ({
    status: "INSPECTED",
    assetId: options.assetId,
    sourcePath: options.sourcePath,
    sourceFormat: ".fbx",
    fingerprint: { ...fingerprint, assetId: options.assetId },
    inspectorVersion: `sha256:${createHash("sha256").update(options.blenderScript).digest("hex")}`,
    blenderVersion: null,
  }));
});

afterEach(() => {
  store?.close();
  const target = resolve(tempDirectory);
  const rel = relative(tempBase, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || !rel.startsWith("bloxbot-corpus-engine-test-")) {
    throw new Error("Unsafe corpus test cleanup path");
  }
  rmSync(target, { recursive: true, force: true });
});

function engine() {
  return new CorpusEngine({
    store,
    source,
    evaluationRoot: tempDirectory,
    blenderExecutable: "mock-blender",
    blenderScript: "mock production inspector script",
    concurrency: 2,
  });
}

describe("Corpus engine restart behavior", () => {
  it("keeps logical assets and inspection across restart and supports technical subset queries", async () => {
    expect((await engine().ingest(2)).succeeded).toBe(2);
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    store.close();
    store = new CorpusStore(join(tempDirectory, "evaluation.db"));

    expect((await engine().ingest(2)).succeeded).toBe(2);
    expect(mocks.inspect).toHaveBeenCalledTimes(2);
    expect(engine().status()).toMatchObject({ total: 2, complete: 2, withInspection: 2 });
    expect(engine().query({ classificationLabels: { meshCount: "single_mesh" } })).toHaveLength(2);
    expect(store.listArtifacts({ source: "fixture", sourceAssetId: "a" })).toHaveLength(1);
  });

  it("isolates one metadata failure without ending the batch", async () => {
    source.getDownloadOptions = vi.fn(async (id) => {
      if (id === "b") throw new Error("fixture metadata failure");
      return downloadOptions(id);
    });
    const result = await engine().ingest(2);
    expect(result).toMatchObject({ selected: 2, succeeded: 1, failed: 1 });
    expect(store.getAsset({ source: "fixture", sourceAssetId: "a" })?.status).toBe("succeeded");
    expect(store.getAsset({ source: "fixture", sourceAssetId: "b" })?.failure?.stage).toBe("metadata");
  });
});
