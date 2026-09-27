import { describe, expect, it } from "vitest";
import type { Job } from "../../src/types/job";
import { makeBenchmarkObservation } from "./BenchmarkObservation";
import { hasCompletionEvidence } from "./completionEvidence";

const when = "2026-09-27T00:00:00.000Z";
const inputHash = "a".repeat(64);
const outputHash = "b".repeat(64);
const contractHash = "c".repeat(64);
const asset = { id: "99", studioId: "selected", instanceName: "BloxBot_exact" };

function completedJob(): Job {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    state: "COMPLETED",
    prompt: "Gör den svart och dubbelt så stor.",
    inputAssets: [{ assetId: "input-asset", artifactId: "input" }],
    requirements: [
      {
        id: "color",
        type: "material.base_color",
        target: "all_mesh_materials",
        expected: [0, 0, 0, 1],
        mandatory: true,
        status: "PASSED",
      },
    ],
    environment: { studioId: "selected" },
    artifacts: [
      {
        id: "input",
        jobId: "11111111-1111-4111-8111-111111111111",
        type: "INPUT_FBX",
        hash: inputHash,
        bytes: 10,
        createdAt: when,
      },
      {
        id: "output",
        jobId: "11111111-1111-4111-8111-111111111111",
        type: "EXPORTED_FBX",
        hash: outputHash,
        bytes: 20,
        createdByOperationId: "export",
        parentArtifactId: "input",
        createdAt: when,
      },
    ],
    executionPlan: {
      operations: [
        {
          id: "export",
          capability: "asset.export_fbx",
          requirementIds: ["color"],
          dependsOn: [],
          input: {},
          executor: "BLENDER",
          status: "SUCCEEDED",
          attempts: 1,
          procedureId: "blender:asset.export_fbx:v1",
          procedureVersion: 1,
          result: { value: { artifact: { id: "output" } } },
        },
        {
          id: "import",
          capability: "roblox.import_asset",
          requirementIds: ["color"],
          dependsOn: [],
          input: { artifact: { id: "output" }, studioId: "selected" },
          executor: "ROBLOX",
          status: "SUCCEEDED",
          attempts: 1,
          procedureId: "roblox:import_asset:v1",
          procedureVersion: 1,
          result: { value: asset },
        },
        {
          id: "inspect",
          capability: "roblox.inspect_asset",
          requirementIds: ["color"],
          dependsOn: [],
          input: { asset },
          executor: "ROBLOX",
          status: "SUCCEEDED",
          attempts: 1,
          procedureId: "roblox:inspect_asset:v1",
          procedureVersion: 1,
          result: { value: { objects: 1 } },
        },
      ],
    },
    evidence: [
      {
        id: "input-proof",
        jobId: "11111111-1111-4111-8111-111111111111",
        source: "INPUT",
        type: "asset.inspection",
        value: { meshes: 1 },
        capturedAt: when,
      },
      {
        id: "gate1-proof",
        jobId: "11111111-1111-4111-8111-111111111111",
        source: "BLENDER",
        type: "gate1.observed",
        value: { valid: true },
        capturedAt: when,
      },
      {
        id: "gate2-proof",
        jobId: "11111111-1111-4111-8111-111111111111",
        source: "ROBLOX",
        type: "asset.inspection",
        value: { imported: asset, observed: { hierarchyValid: true } },
        capturedAt: when,
      },
      {
        id: "contract",
        jobId: "11111111-1111-4111-8111-111111111111",
        source: "ROBLOX",
        type: "mcp.contract",
        value: { sha256: contractHash },
        capturedAt: when,
      },
      {
        id: "receipt",
        jobId: "11111111-1111-4111-8111-111111111111",
        source: "ROBLOX",
        type: "upload.receipt",
        value: { artifactId: "output", sha256: outputHash, status: "SUCCEEDED", assetId: "99" },
        capturedAt: when,
      },
      {
        id: "inserted",
        jobId: "11111111-1111-4111-8111-111111111111",
        source: "ROBLOX",
        type: "import.inserted",
        value: { asset },
        capturedAt: when,
      },
    ],
    report: {
      gate1: {
        gate: "GATE_1",
        passed: true,
        checks: [
          { id: "material", passed: true, message: "Material valid", evidenceIds: ["gate1-proof"] },
        ],
        evidenceIds: ["gate1-proof"],
      },
      gate2: {
        gate: "GATE_2",
        passed: true,
        checks: [{ id: "import", passed: true, message: "Imported", evidenceIds: ["gate2-proof"] }],
        evidenceIds: ["gate2-proof"],
      },
      evaluations: [
        {
          requirementId: "color",
          status: "PASS",
          expected: [0, 0, 0, 1],
          observed: [0, 0, 0, 1],
          confidence: 1,
          evidenceIds: ["gate2-proof"],
        },
      ],
    },
    createdAt: when,
    updatedAt: when,
  };
}

describe("benchmark observation from persisted evidence", () => {
  it("separates transfer and requirement success for a complete selected-Studio Job", () => {
    const job = completedJob();
    expect(hasCompletionEvidence(job)).toBe(true);
    const observed = makeBenchmarkObservation(job, { caseId: "horse_black_2x", capturedAt: when });
    expect(Object.values(observed.transfer).every((value) => value === "PASS")).toBe(true);
    expect(observed.promptResult.mandatory).toBe("PASS");
    expect(observed.studio).toEqual({
      id: "selected",
      contractSha256: contractHash,
      importedInstanceName: "BloxBot_exact",
    });
    expect(observed.procedures).toHaveLength(3);
    expect(JSON.stringify(observed)).not.toContain("credential");
  });

  it("does not count a cloud receipt as Studio import or prompt success", () => {
    const job = completedJob();
    const partial: Job = {
      ...job,
      state: "FAILED",
      executionPlan: {
        operations: (job.executionPlan?.operations ?? []).filter((op) => op.id === "export"),
      },
      evidence: (job.evidence ?? []).filter(
        (item) => !["inserted", "gate2-proof"].includes(item.id),
      ),
      report: {
        previous: { gate1: (job.report as { gate1: unknown }).gate1 },
        error: "V1 stopped in IMPORTING",
      },
    };
    const observed = makeBenchmarkObservation(partial, { capturedAt: when });
    expect(observed.transfer.openCloudUpload).toBe("PASS");
    expect(observed.transfer.studioInserted).toBe("UNKNOWN");
    expect(observed.transfer.gate2).toBe("UNKNOWN");
    expect(observed.promptResult.mandatory).toBe("FAIL");
    expect(observed.failure?.phase).toBe("STUDIO_IMPORT");
  });

  it("refuses to count an unbacked Gate 2 or requirement as passing", () => {
    const job = completedJob();
    const observed = makeBenchmarkObservation(
      { ...job, evidence: (job.evidence ?? []).filter((item) => item.id !== "gate2-proof") },
      { capturedAt: when },
    );
    expect(observed.transfer.gate2).toBe("UNKNOWN");
    expect(observed.promptResult.requirements[0].result).toBe("UNKNOWN");
    expect(observed.promptResult.mandatory).toBe("UNKNOWN");
  });

  it("does not use inspection evidence from a different imported instance", () => {
    const job = completedJob();
    const observed = makeBenchmarkObservation(
      {
        ...job,
        evidence: (job.evidence ?? []).map((item) =>
          item.id === "gate2-proof"
            ? {
                ...item,
                value: {
                  imported: { ...asset, instanceName: "BloxBot_other" },
                  observed: { hierarchyValid: true },
                },
              }
            : item,
        ),
      },
      { capturedAt: when },
    );
    expect(observed.transfer.exactInstanceInspected).toBe("UNKNOWN");
    expect(observed.transfer.gate2).toBe("UNKNOWN");
    expect(observed.promptResult.requirements[0].result).toBe("UNKNOWN");
    expect(observed.promptResult.mandatory).toBe("UNKNOWN");
  });

  it("attributes an output upload failure without implying Studio insertion", () => {
    const job = completedJob();
    const failed: Job = {
      ...job,
      state: "FAILED",
      executionPlan: {
        operations: (job.executionPlan?.operations ?? []).map((op) =>
          op.id === "import"
            ? { ...op, status: "FAILED" as const, result: undefined, error: "Open Cloud HTTP 500" }
            : op,
        ),
      },
      evidence: (job.evidence ?? []).filter(
        (item) => !["receipt", "inserted", "gate2-proof"].includes(item.id),
      ),
      report: {
        previous: { gate1: (job.report as { gate1: unknown }).gate1 },
        error: "V1 stopped in IMPORTING",
      },
    };
    const observed = makeBenchmarkObservation(failed, { capturedAt: when });
    expect(observed.transfer.openCloudUpload).toBe("FAIL");
    expect(observed.transfer.studioInserted).toBe("UNKNOWN");
    expect(observed.failure?.phase).toBe("OPEN_CLOUD");
  });
});
