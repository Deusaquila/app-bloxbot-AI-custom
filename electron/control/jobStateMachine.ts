import type { JobState } from "../../src/types/job";

const transitions: Readonly<Record<JobState, readonly JobState[]>> = {
  CREATED: ["INSPECTING", "CANCELLED"],
  INSPECTING: ["COMPILING", "FAILED", "CANCELLED"],
  COMPILING: ["PLANNING", "FAILED", "CANCELLED"],
  PLANNING: ["EXECUTING", "FAILED", "CANCELLED"],
  EXECUTING: ["VERIFYING_GATE_1", "FAILED", "CANCELLED"],
  VERIFYING_GATE_1: ["EXPORTING", "CORRECTING", "FAILED", "CANCELLED"],
  EXPORTING: ["IMPORTING", "FAILED", "CANCELLED"],
  IMPORTING: ["VERIFYING_GATE_2", "FAILED", "CANCELLED"],
  VERIFYING_GATE_2: ["EVALUATING", "CORRECTING", "FAILED", "CANCELLED"],
  EVALUATING: ["COMPLETED", "CORRECTING", "FAILED", "CANCELLED"],
  CORRECTING: ["EXECUTING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return transitions[from].includes(to);
}

export function allowedJobTransitions(from: JobState): readonly JobState[] {
  return transitions[from];
}
