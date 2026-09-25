import { randomUUID } from "node:crypto";

import type { ExecutionOperation, ExecutionPlan, Requirement } from "../../src/types/job";

function operation(
  capability: string,
  requirementIds: string[],
  dependsOn: string[],
  input: unknown,
  executor: "BLENDER" | "ROBLOX" | "SYSTEM",
): ExecutionOperation {
  return {
    id: randomUUID(),
    capability,
    requirementIds,
    dependsOn,
    input,
    executor,
    status: "PENDING",
    attempts: 0,
  };
}

export function buildV1ExecutionPlan(requirements: readonly Requirement[]): ExecutionPlan {
  const inspect = operation("asset.inspect", [], [], {}, "BLENDER");
  const mutations = requirements.flatMap((requirement) => {
    if (requirement.type === "material.base_color") {
      return [operation("material.set_base_color", [requirement.id], [inspect.id], { expected: requirement.expected }, "BLENDER")];
    }
    if (requirement.type === "geometry.relative_size") {
      return [operation("transform.scale_uniform", [requirement.id], [inspect.id], { expected: requirement.expected }, "BLENDER")];
    }
    return [];
  });
  const verify = requirements.flatMap((requirement) => {
    const dependency = mutations.find((candidate) => candidate.requirementIds.includes(requirement.id));
    if (!dependency) return [];
    const capability =
      requirement.type === "material.base_color" ? "asset.verify_material" : "asset.verify_dimensions";
    return [operation(capability, [requirement.id], [dependency.id], { expected: requirement.expected }, "BLENDER")];
  });
  const exportFbx = operation("asset.export_fbx", requirements.map((r) => r.id), verify.map((v) => v.id), {}, "BLENDER");
  return { operations: [inspect, ...mutations, ...verify, exportFbx] };
}
