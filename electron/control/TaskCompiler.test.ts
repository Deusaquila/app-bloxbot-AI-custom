import { describe, expect, it } from "vitest";

import { compileKnownV1Task } from "./TaskCompiler";

const asset = {
  assetId: "asset-1",
  format: "fbx" as const,
  objects: 1,
  meshes: 1,
  vertices: 4,
  triangles: 2,
  materials: [],
  dimensions: { x: 1, y: 1, z: 1 },
  transforms: { scale: [1, 1, 1] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] },
  rig: { exists: false },
  topology: {},
  issues: [],
};

describe("compileKnownV1Task", () => {
  it("compiles the first Swedish acceptance prompt without an LLM", () => {
    const result = compileKnownV1Task("Gör den svart och dubbelt så stor.", asset);
    expect(result?.requirements.map((r) => r.type)).toEqual([
      "material.base_color",
      "geometry.relative_size",
    ]);
    expect(result?.evaluations).toHaveLength(2);
  });

  it("returns undefined for tasks that require reasoning", () => {
    expect(compileKnownV1Task("Gör stoet till en hingst.", asset)).toBeUndefined();
  });
});
