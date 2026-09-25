import { randomUUID } from "node:crypto";

import type { AssetFingerprint } from "../../src/types/asset";
import type { Requirement } from "../../src/types/job";
import type { EvaluationSpec } from "../../src/types/evaluation";

export interface CompiledTask {
  requirements: Requirement[];
  evaluations: EvaluationSpec[];
}

export function compileKnownV1Task(prompt: string, _asset: AssetFingerprint): CompiledTask | undefined {
  const normalized = prompt.toLocaleLowerCase("sv-SE");
  const requirements: Requirement[] = [];
  const evaluations: EvaluationSpec[] = [];

  if (normalized.includes("svart") || normalized.includes("black")) {
    const id = randomUUID();
    requirements.push({
      id,
      type: "material.base_color",
      target: "all_mesh_materials",
      expected: [0, 0, 0, 1],
      mandatory: true,
      status: "PENDING",
    });
    evaluations.push({ requirementId: id, method: "material_property", expected: [0, 0, 0, 1] });
  }

  if (
    normalized.includes("dubbelt så stor") ||
    normalized.includes("dubbla storleken") ||
    normalized.includes("twice as large") ||
    normalized.includes("double the size")
  ) {
    const id = randomUUID();
    requirements.push({
      id,
      type: "geometry.relative_size",
      target: "asset_bounding_box",
      expected: 2,
      mandatory: true,
      status: "PENDING",
    });
    evaluations.push({
      requirementId: id,
      method: "relative_bounding_box",
      expected: 2,
      tolerance: 0.01,
    });
  }

  return requirements.length > 0 ? { requirements, evaluations } : undefined;
}
