import type { GateResult } from "../../src/types/evaluation";

export interface Gate1Input {
  materialValid: boolean;
  dimensionsValid: boolean;
  geometryValid: boolean;
  exportReady: boolean;
  evidenceIds: string[];
}

export function evaluateGate1(input: Gate1Input): GateResult {
  const checks = [
    { id: "material-valid", passed: input.materialValid, message: "Materials are valid", evidenceIds: input.evidenceIds },
    { id: "dimensions-valid", passed: input.dimensionsValid, message: "Dimensions are valid", evidenceIds: input.evidenceIds },
    { id: "geometry-valid", passed: input.geometryValid, message: "Geometry is exportable", evidenceIds: input.evidenceIds },
    { id: "export-ready", passed: input.exportReady, message: "Asset is ready for FBX export", evidenceIds: input.evidenceIds },
  ];
  return {
    gate: "GATE_1",
    passed: checks.every((check) => check.passed),
    checks,
    evidenceIds: [...new Set(input.evidenceIds)],
  };
}
