import { describe, expect, it } from "vitest";

import { allowedJobTransitions, canTransitionJob } from "./jobStateMachine";

describe("jobStateMachine", () => {
  it("allows the V1 happy path", () => {
    expect(canTransitionJob("CREATED", "INSPECTING")).toBe(true);
    expect(canTransitionJob("INSPECTING", "COMPILING")).toBe(true);
    expect(canTransitionJob("COMPILING", "PLANNING")).toBe(true);
    expect(canTransitionJob("PLANNING", "EXECUTING")).toBe(true);
    expect(canTransitionJob("EXECUTING", "VERIFYING_GATE_1")).toBe(true);
    expect(canTransitionJob("VERIFYING_GATE_1", "EXPORTING")).toBe(true);
    expect(canTransitionJob("EXPORTING", "IMPORTING")).toBe(true);
    expect(canTransitionJob("IMPORTING", "VERIFYING_GATE_2")).toBe(true);
    expect(canTransitionJob("VERIFYING_GATE_2", "EVALUATING")).toBe(true);
    expect(canTransitionJob("EVALUATING", "COMPLETED")).toBe(true);
  });

  it("rejects invalid jumps and terminal transitions", () => {
    expect(canTransitionJob("CREATED", "COMPLETED")).toBe(false);
    expect(allowedJobTransitions("COMPLETED")).toEqual([]);
    expect(allowedJobTransitions("FAILED")).toEqual([]);
    expect(allowedJobTransitions("CANCELLED")).toEqual([]);
  });

  it("allows bounded correction re-entry without making it implicit", () => {
    expect(canTransitionJob("VERIFYING_GATE_1", "CORRECTING")).toBe(true);
    expect(canTransitionJob("VERIFYING_GATE_2", "CORRECTING")).toBe(true);
    expect(canTransitionJob("EVALUATING", "CORRECTING")).toBe(true);
    expect(canTransitionJob("CORRECTING", "EXECUTING")).toBe(true);
  });
});
