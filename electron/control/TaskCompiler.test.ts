import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { JobSchema } from "../../src/types/job";
import {
  compileKnownV1Task,
  compileRequirementOutput,
  compileTask,
  type RequirementIRCompiler,
} from "./TaskCompiler";
import { InvalidRequirementCompilerOutput } from "./RequirementIR";

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
  it.each([
    "Gör den svart och dubbelt så stor.",
    "MAKE IT BLACK AND TWICE AS LARGE!",
    "make it black and double the size",
  ])("compiles only the enumerated complete objective prompt: %s", (prompt) => {
    const result = compileKnownV1Task(prompt, asset);
    expect(result?.requirements.map((r) => r.type)).toEqual([
      "material.base_color",
      "geometry.relative_size",
    ]);
    expect(result?.requirements.map((r) => [r.target, r.expected, r.mandatory, r.status])).toEqual([
      ["all_mesh_materials", [0, 0, 0, 1], true, "PENDING"],
      ["asset_bounding_box", 2, true, "PENDING"],
    ]);
    expect(result?.evaluations).toHaveLength(2);
    expect(result?.evaluations[1]).toMatchObject({
      method: "relative_bounding_box",
      expected: 2,
      tolerance: 0.01,
    });
    expect(result?.requirementIR).toHaveLength(2);
  });

  it("returns undefined for tasks that require reasoning", () => {
    expect(compileKnownV1Task("Gör stoet till en hingst.", asset)).toBeUndefined();
  });

  it.each([
    "Gör den inte svart och dubbelt så stor.",
    "Gör bara sadeln svart.",
    "Gör den svart, men gör den inte större.",
    "Gör den svart, dubbelt så stor och vrid 90 grader.",
  ])("does not guess at unsupported negated or scoped prompt: %s", (prompt) => {
    expect(compileKnownV1Task(prompt, asset)).toBeUndefined();
  });

  it("uses the deterministic path without calling a configured reasoning fallback", async () => {
    const fallback: RequirementIRCompiler = { compile: async () => { throw new Error("must not run"); } };
    const result = await compileTask("Gör den svart och dubbelt så stor.", asset, fallback);
    expect(result?.requirements).toHaveLength(2);
  });

  it("compiles validated typed fallback output into the existing V1 requirement contract", async () => {
    const fallback: RequirementIRCompiler = {
      compile: async ({ maxRequirements }) => {
        expect(maxRequirements).toBe(32);
        return {
          requirements: [
            {
              id: "R_color",
              type: "material.base_color",
              target: "all_mesh_materials",
              expected: [0.1, 0.2, 0.3, 1],
              verification: "objective",
              mandatory: true,
            },
          ],
        };
      },
    };
    const result = await compileTask("Make the whole asset blue-gray.", asset, fallback);
    expect(result?.requirements).toEqual([
      {
        id: "R_color",
        type: "material.base_color",
        target: "all_mesh_materials",
        expected: [0.1, 0.2, 0.3, 1],
        mandatory: true,
        status: "PENDING",
      },
    ]);
    expect(result?.evaluations).toEqual([
      {
        requirementId: "R_color",
        method: "material_property",
        expected: [0.1, 0.2, 0.3, 1],
      },
    ]);
  });

  it.each([
    { requirements: [] },
    { requirements: [{ id: "R1", type: "geometry.relative_size", target: "asset_bounding_box", expected: 0, verification: "objective", mandatory: true }] },
    { requirements: [{ id: "R1", type: "material.base_color", target: "all_mesh_materials", expected: [0, 0, 0], verification: "objective", mandatory: true }] },
    { requirements: [{ id: "R1", type: "material.base_color", target: "all_mesh_materials", expected: [0, 0, 0, 1], verification: "objective", mandatory: true, script: "arbitrary code" }] },
    { requirements: [{ id: "R1", type: "unknown.capability", target: "asset", expected: {}, verification: "objective", mandatory: true }] },
    { requirements: [{ id: "R1", type: "geometry.relative_size", target: "asset_bounding_box", expected: 2, verification: "objective", mandatory: true }, { id: "R1", type: "geometry.relative_size", target: "asset_bounding_box", expected: 3, verification: "objective", mandatory: true }] },
    { requirements: [{ id: "R1", type: "geometry.relative_size", target: "asset_bounding_box", expected: 2, verification: "objective", mandatory: false }] },
    { requirements: [{ id: "R1", type: "geometry.relative_size", target: "asset_bounding_box", expected: 2, verification: "semantic", mandatory: true }] },
    { requirements: [{ id: "R1", type: "material.base_color", target: "all_visible_meshes", expected: [0, 0, 0, 1], verification: "objective", mandatory: true }] },
    { requirements: [{ id: "R1", type: "geometry.relative_size", target: "asset_bounding_box", expected: 2, verification: "objective", mandatory: true, arbitrary_script: "print(1)" }] },
    { requirements: [{ id: "R1", type: "material.base_color", target: { kind: "material_ids", ids: ["mat-a", "mat-a"] }, expected: [0, 0, 0, 1], verification: "objective", mandatory: true }] },
    { requirements: [{ id: "R1", type: "material.base_color", target: { kind: "material_ids", ids: ["mat-a"] }, expected: [0, 0, 0, 1], verification: "objective", mandatory: true }] },
    { requirements: [{ id: "R1", type: "geometry.relative_size", target: "asset_bounding_box", expected: 2, verification: "objective", mandatory: true }], script: "run this" },
  ])("rejects malformed or non-executable compiler output", (candidate) => {
    expect(() => compileRequirementOutput(candidate)).toThrow(InvalidRequirementCompilerOutput);
  });

  it("does not invoke fallback for oversized prompts", async () => {
    const fallback: RequirementIRCompiler = { compile: async () => { throw new Error("must not run"); } };
    await expect(compileTask("x".repeat(8_001), asset, fallback)).rejects.toThrow(
      InvalidRequirementCompilerOutput,
    );
  });

  it("keeps the persisted V1 Job requirement shape readable", () => {
    const persistedJob = {
      id: "job-v1",
      state: "COMPLETED",
      prompt: "Gör den svart och dubbelt så stor.",
      inputAssets: [],
      requirements: [
        {
          id: "requirement-v1",
          type: "material.base_color",
          target: "all_mesh_materials",
          expected: [0, 0, 0, 1],
          mandatory: true,
          status: "PASSED",
        },
      ],
      environment: { studioId: "studio-v1" },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    };
    expect(Schema.decodeUnknownEither(JobSchema)(persistedJob)._tag).toBe("Right");
  });
});
