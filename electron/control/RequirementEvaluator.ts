import type { Evidence } from "../../src/types/job";
import type { EvaluationSpec, RequirementEvaluation } from "../../src/types/evaluation";

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function evaluateRequirement(
  spec: EvaluationSpec,
  evidence: readonly Evidence[],
): RequirementEvaluation {
  const relevant = evidence.filter((item) => item.requirementId === spec.requirementId);
  const latest = relevant.at(-1);
  const observed = latest?.value;
  let passed = false;

  if (spec.method === "relative_bounding_box") {
    const expected = numeric(spec.expected);
    const actual = numeric(observed);
    const tolerance = spec.tolerance ?? 0.01;
    passed = expected !== undefined && actual !== undefined && Math.abs(expected - actual) <= tolerance;
  } else {
    passed = JSON.stringify(observed) === JSON.stringify(spec.expected);
  }

  return {
    requirementId: spec.requirementId,
    status: passed ? "PASS" : "FAIL",
    expected: spec.expected,
    observed,
    confidence: latest ? 1 : 0,
    evidenceIds: relevant.map((item) => item.id),
  };
}
