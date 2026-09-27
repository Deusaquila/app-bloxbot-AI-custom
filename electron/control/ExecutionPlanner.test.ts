import { describe, expect, it } from "vitest";

import type { ExecutionPlan, Requirement } from "../../src/types/job";
import { buildV1ExecutionPlan } from "./ExecutionPlanner";
import { InvalidV1ExecutionPlan, validateV1ExecutionPlan } from "./V1ExecutionPlanValidator";

function horseRequirements(): Requirement[] {
  return [
    {
      id: "R1",
      type: "material.base_color",
      target: "all_mesh_materials",
      expected: [0, 0, 0, 1],
      mandatory: true,
      status: "PENDING",
    },
    {
      id: "R2",
      type: "geometry.relative_size",
      target: "asset_bounding_box",
      expected: 2,
      mandatory: true,
      status: "PENDING",
    },
  ];
}

describe("buildV1ExecutionPlan", () => {
  it("parallelizes independent mutations and joins every verifier before export", () => {
    const plan = buildV1ExecutionPlan(horseRequirements());
    const inspect = plan.operations.find((op) => op.capability === "asset.inspect")!;
    const color = plan.operations.find((op) => op.capability === "material.set_base_color")!;
    const scale = plan.operations.find((op) => op.capability === "transform.scale_uniform")!;
    const colorVerify = plan.operations.find((op) => op.capability === "asset.verify_material")!;
    const scaleVerify = plan.operations.find((op) => op.capability === "asset.verify_dimensions")!;
    const exportFbx = plan.operations.find((op) => op.capability === "asset.export_fbx")!;

    expect(color.dependsOn).toEqual([inspect.id]);
    expect(scale.dependsOn).toEqual([inspect.id]);
    expect(colorVerify.dependsOn).toEqual([color.id]);
    expect(scaleVerify.dependsOn).toEqual([scale.id]);
    expect(exportFbx.dependsOn).toEqual([colorVerify.id, scaleVerify.id]);
    expect(exportFbx.requirementIds).toEqual(["R1", "R2"]);
  });

  it.each([
    {
      id: "R3",
      type: "rig.auto",
      target: "asset",
      expected: true,
      mandatory: true,
      status: "PENDING",
    },
    {
      id: "R3",
      type: "material.base_color",
      target: "all_visible_meshes",
      expected: [1, 1, 1, 1],
      mandatory: true,
      status: "PENDING",
    },
    {
      id: "R3",
      type: "material.base_color",
      target: "all_mesh_materials",
      expected: [1, 1, 1],
      mandatory: true,
      status: "PENDING",
    },
    {
      id: "R3",
      type: "geometry.relative_size",
      target: "asset_bounding_box",
      expected: 0,
      mandatory: true,
      status: "PENDING",
    },
  ] satisfies Requirement[])("rejects unsupported or ill-typed requirements", (requirement) => {
    expect(() => buildV1ExecutionPlan([requirement])).toThrow(InvalidV1ExecutionPlan);
  });

  it("rejects empty requirement sets and duplicate requirement IDs", () => {
    expect(() => buildV1ExecutionPlan([])).toThrow(InvalidV1ExecutionPlan);
    const [color, scale] = horseRequirements();
    expect(() => buildV1ExecutionPlan([{ ...color }, { ...scale, id: color.id }])).toThrow(
      InvalidV1ExecutionPlan,
    );
  });

  it("rejects a plan that omits a requirement verifier", () => {
    const requirements = horseRequirements();
    const plan = buildV1ExecutionPlan(requirements);
    const withoutScaleVerifier: ExecutionPlan = {
      operations: plan.operations.filter((operation) => operation.capability !== "asset.verify_dimensions"),
    };
    expect(() => validateV1ExecutionPlan(requirements, withoutScaleVerifier)).toThrow(
      InvalidV1ExecutionPlan,
    );
  });

  it("rejects unknown requirement links and missing dependencies", () => {
    const requirements = horseRequirements();
    const plan = buildV1ExecutionPlan(requirements);
    const unknownRequirementLink: ExecutionPlan = {
      operations: plan.operations.map((operation) =>
        operation.capability === "material.set_base_color"
          ? { ...operation, requirementIds: [...operation.requirementIds, "R_UNKNOWN"] }
          : operation,
      ),
    };
    expect(() => validateV1ExecutionPlan(requirements, unknownRequirementLink)).toThrow(
      InvalidV1ExecutionPlan,
    );

    const missingDependency: ExecutionPlan = {
      operations: plan.operations.map((operation) =>
        operation.capability === "transform.scale_uniform"
          ? { ...operation, dependsOn: ["missing-operation"] }
          : operation,
      ),
    };
    expect(() => validateV1ExecutionPlan(requirements, missingDependency)).toThrow(
      InvalidV1ExecutionPlan,
    );
  });

  it("rejects dependency cycles and executor mismatches", () => {
    const requirements = horseRequirements();
    const plan = buildV1ExecutionPlan(requirements);
    const exportId = plan.operations.find((operation) => operation.capability === "asset.export_fbx")!.id;
    const cyclic: ExecutionPlan = {
      operations: plan.operations.map((operation) =>
        operation.capability === "asset.inspect" ? { ...operation, dependsOn: [exportId] } : operation,
      ),
    };
    expect(() => validateV1ExecutionPlan(requirements, cyclic)).toThrow(/cycle/u);

    const wrongExecutor: ExecutionPlan = {
      operations: plan.operations.map((operation) =>
        operation.capability === "material.set_base_color"
          ? { ...operation, executor: "ROBLOX" as const }
          : operation,
      ),
    };
    expect(() => validateV1ExecutionPlan(requirements, wrongExecutor)).toThrow(/Executor/u);
  });
});
