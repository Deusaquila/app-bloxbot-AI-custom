import type { GateResult } from "../../src/types/evaluation";

export interface Gate2Input {
  imported: boolean;
  expectedObjectsPresent: boolean;
  expectedMaterialsPresent: boolean;
  dimensionsPreserved: boolean;
  hierarchyValid: boolean;
  evidenceIds: string[];
}

export function evaluateGate2(input: Gate2Input): GateResult {
  const checks = [
    { id: "imported", passed: input.imported, message: "Asset imported into Roblox", evidenceIds: input.evidenceIds },
    { id: "objects-present", passed: input.expectedObjectsPresent, message: "Expected objects are present", evidenceIds: input.evidenceIds },
    { id: "materials-present", passed: input.expectedMaterialsPresent, message: "Expected materials are present", evidenceIds: input.evidenceIds },
    { id: "dimensions-preserved", passed: input.dimensionsPreserved, message: "Expected dimensions survived import", evidenceIds: input.evidenceIds },
    { id: "hierarchy-valid", passed: input.hierarchyValid, message: "Imported hierarchy is valid", evidenceIds: input.evidenceIds },
  ];
  return {
    gate: "GATE_2",
    passed: checks.every((check) => check.passed),
    checks,
    evidenceIds: [...new Set(input.evidenceIds)],
  };
}
