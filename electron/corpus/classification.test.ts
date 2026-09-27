import { describe, expect, it } from "vitest";
import type { AssetFingerprint } from "../../src/types/asset";
import { classifyFingerprint } from "./classification";

const base: AssetFingerprint = {
  assetId: "sample",
  format: "fbx",
  objects: 1,
  meshes: 1,
  vertices: 8,
  triangles: 12,
  materials: [{ name: "mat", hasTextures: false }],
  dimensions: { x: 1, y: 1, z: 1 },
  transforms: { scale: [1, 1, 1], rotation: [0, 0, 0] },
  rig: { exists: false },
  topology: { manifoldRatio: 1, looseGeometry: false },
  structure: {
    rootObjects: 1,
    parentedObjects: 0,
    emptyObjects: 0,
    maximumDepth: 0,
    omittedObjects: 0,
    objectTypes: [{ type: "MESH", count: 1 }],
    objectNodes: [],
  },
  issues: [],
};

describe("Corpus technical classification", () => {
  it("labels measured properties and preserves unknown properties", () => {
    expect(classifyFingerprint(base).labels).toEqual({
      meshCount: "single_mesh",
      materialCount: "single_material",
      texture: "untextured",
      rig: "unrigged",
      roots: "single_root",
      geometry: "simple_geometry",
      topology: "clean_topology",
    });
    const older: AssetFingerprint = {
      ...base,
      materials: [{ name: "legacy" }],
      topology: {},
      structure: undefined,
    };
    expect(classifyFingerprint(older).labels).toMatchObject({
      texture: null,
      roots: null,
      topology: null,
    });
  });

  it("marks complex and warning cases using the measured fingerprint", () => {
    const result = classifyFingerprint({
      ...base,
      meshes: 2,
      triangles: 100_001,
      materials: [{ name: "a", hasTextures: false }, { name: "b", hasTextures: true }],
      rig: { exists: true },
      topology: { manifoldRatio: 0.9, looseGeometry: true },
      structure: { ...base.structure!, rootObjects: 2 },
    });
    expect(result.labels).toMatchObject({
      meshCount: "multi_mesh",
      materialCount: "multi_material",
      texture: "textured",
      rig: "rigged",
      roots: "multi_root",
      geometry: "complex_geometry",
      topology: "topology_warning",
    });
  });
});
