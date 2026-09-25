import { describe, expect, it } from "vitest";

import { buildV1ExecutionPlan } from "./ExecutionPlanner";

describe("buildV1ExecutionPlan", () => {
  it("parallelizes independent mutations and joins before export", () => {
    const plan = buildV1ExecutionPlan([
      { id: "R1", type: "material.base_color", target: "all", expected: [0,0,0,1], mandatory: true, status: "PENDING" },
      { id: "R2", type: "geometry.relative_size", target: "bbox", expected: 2, mandatory: true, status: "PENDING" },
    ]);
    const inspect = plan.operations.find((op) => op.capability === "asset.inspect")!;
    const color = plan.operations.find((op) => op.capability === "material.set_base_color")!;
    const scale = plan.operations.find((op) => op.capability === "transform.scale_uniform")!;
    const exportFbx = plan.operations.find((op) => op.capability === "asset.export_fbx")!;
    expect(color.dependsOn).toEqual([inspect.id]);
    expect(scale.dependsOn).toEqual([inspect.id]);
    expect(exportFbx.dependsOn).toHaveLength(2);
  });
});
