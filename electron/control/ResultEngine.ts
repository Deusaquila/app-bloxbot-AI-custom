import type { GateResult, RequirementEvaluation } from "../../src/types/evaluation";

export interface JobOutcome {
  completed: boolean;
  reason?: string;
}

export function determineJobOutcome(
  gate1: GateResult,
  gate2: GateResult,
  evaluations: readonly RequirementEvaluation[],
): JobOutcome {
  if (!gate1.passed) return { completed: false, reason: "GATE_1_FAILED" };
  if (!gate2.passed) return { completed: false, reason: "GATE_2_FAILED" };
  if (evaluations.some((evaluation) => evaluation.status !== "PASS")) {
    return { completed: false, reason: "REQUIREMENT_FAILED" };
  }
  return { completed: true };
}
