import { describe, expect, it } from "vitest";

import { determineJobOutcome } from "./ResultEngine";

const gate = (name: "GATE_1" | "GATE_2", passed: boolean) => ({
  gate: name,
  passed,
  checks: [],
  evidenceIds: [],
});

describe("determineJobOutcome", () => {
  it("requires both gates and all requirements to pass", () => {
    expect(determineJobOutcome(gate("GATE_1", true), gate("GATE_2", true), [
      { requirementId: "R1", status: "PASS", expected: true, observed: true, confidence: 1, evidenceIds: [] },
    ])).toEqual({ completed: true });
  });

  it("does not confuse successful import with task success", () => {
    expect(determineJobOutcome(gate("GATE_1", true), gate("GATE_2", true), [
      { requirementId: "R1", status: "FAIL", expected: true, observed: false, confidence: 1, evidenceIds: [] },
    ])).toEqual({ completed: false, reason: "REQUIREMENT_FAILED" });
  });
});
