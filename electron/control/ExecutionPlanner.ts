import { randomUUID } from "node:crypto";

import type { ExecutionOperation, ExecutionPlan, Requirement } from "../../src/types/job";
import { mapV1Requirement, validateV1ExecutionPlan } from "./V1ExecutionPlanValidator";

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
  const mappings = requirements.map(mapV1Requirement);
  const inspect = operation("asset.inspect", [], [], {}, "BLENDER");
  const mutations = requirements.map((requirement, index) =>
    operation(
      mappings[index].mutationCapability,
      [requirement.id],
      [inspect.id],
      { expected: requirement.expected },
      "BLENDER",
    ),
  );
  const verify = requirements.map((requirement, index) => {
    const mutation = mutations[index];
    return operation(
      mappings[index].verificationCapability,
      [requirement.id],
      [mutation.id],
      { expected: requirement.expected },
      "BLENDER",
    );
  });
  const exportFbx = operation(
    "asset.export_fbx",
    requirements.map((requirement) => requirement.id),
    verify.map((verification) => verification.id),
    {},
    "BLENDER",
  );
  const candidate: ExecutionPlan = { operations: [inspect, ...mutations, ...verify, exportFbx] };
  return validateV1ExecutionPlan(requirements, candidate);
}
