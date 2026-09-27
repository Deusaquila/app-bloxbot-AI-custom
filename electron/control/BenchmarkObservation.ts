import { Schema } from "effect";
import {
  type AssessmentStatus,
  type BenchmarkObservation,
  BenchmarkObservationSchema,
} from "../../src/types/benchmark";
import type { GateResult, RequirementEvaluation } from "../../src/types/evaluation";
import { GateResultSchema, RequirementEvaluationSchema } from "../../src/types/evaluation";
import type { Artifact, ExecutionOperation, Job, JobState } from "../../src/types/job";
import { hasCompletionEvidence } from "./completionEvidence";

type Report = {
  gate1?: GateResult;
  gate2?: GateResult;
  evaluations: readonly RequirementEvaluation[];
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function report(value: unknown): Report {
  let cursor = value;
  for (let depth = 0; depth < 4; depth++) {
    const current = object(cursor);
    if (!current) break;
    const first = Schema.decodeUnknownEither(GateResultSchema)(current.gate1);
    const second = Schema.decodeUnknownEither(GateResultSchema)(current.gate2);
    const checks = Schema.decodeUnknownEither(Schema.Array(RequirementEvaluationSchema))(
      current.evaluations,
    );
    if (first._tag === "Right" || second._tag === "Right" || checks._tag === "Right") {
      return {
        ...(first._tag === "Right" && first.right.gate === "GATE_1" ? { gate1: first.right } : {}),
        ...(second._tag === "Right" && second.right.gate === "GATE_2"
          ? { gate2: second.right }
          : {}),
        evaluations: checks._tag === "Right" ? checks.right : [],
      };
    }
    cursor = current.previous;
  }
  return { evaluations: [] };
}

function gateStatus(job: Job, gate: GateResult | undefined): AssessmentStatus {
  if (!gate) return "UNKNOWN";
  if (!gate.passed) return "FAIL";
  const source = gate.gate === "GATE_1" ? "BLENDER" : "ROBLOX";
  const backed = (ids: readonly string[]) =>
    ids.length > 0 &&
    ids.every((id) =>
      job.evidence?.some(
        (item) => item.id === id && item.jobId === job.id && item.source === source,
      ),
    );
  return gate.checks.length > 0 &&
    backed(gate.evidenceIds) &&
    gate.checks.every((check) => check.passed && backed(check.evidenceIds))
    ? "PASS"
    : "UNKNOWN";
}

function artifactForOperation(
  job: Job,
  capability: string,
  type: Artifact["type"],
): Artifact | undefined {
  const operations = job.executionPlan?.operations ?? [];
  const operation = [...operations]
    .reverse()
    .find((candidate) => candidate.capability === capability && candidate.status === "SUCCEEDED");
  if (!operation) return undefined;
  return job.artifacts?.find(
    (artifact) =>
      artifact.jobId === job.id &&
      artifact.type === type &&
      artifact.createdByOperationId === operation.id,
  );
}

function evidenceValue(job: Job, type: string): Record<string, unknown>[] {
  return (job.evidence ?? [])
    .filter((item) => item.jobId === job.id && item.type === type && item.source === "ROBLOX")
    .flatMap((item) => {
      const value = object(item.value);
      return value ? [value] : [];
    });
}

function sameAsset(value: unknown, expected: Record<string, unknown>): boolean {
  const asset = object(value);
  return (
    asset?.id === expected.id &&
    asset?.studioId === expected.studioId &&
    asset?.instanceName === expected.instanceName
  );
}

function failurePhase(job: Job, gates: Report): BenchmarkObservation["failure"] {
  if (job.state !== "FAILED") return undefined;
  const failed = job.executionPlan?.operations.find((operation) => operation.status === "FAILED");
  if (failed) {
    const phase = failed.error?.includes("Process interrupted")
      ? "INTERRUPTED"
      : failed.capability === "roblox.import_asset"
        ? failed.error?.startsWith("Open Cloud ")
          ? "OPEN_CLOUD"
          : "STUDIO_IMPORT"
        : failed.capability === "roblox.inspect_asset" ||
            failed.capability === "roblox.apply_verified_material"
          ? "STUDIO_INSPECT"
          : failed.capability === "asset.export_fbx"
            ? "EXPORT"
            : "BLENDER";
    return { phase, capability: failed.capability, operationId: failed.id };
  }
  if (gates.gate1?.passed === false) return { phase: "GATE_1" };
  if (gates.gate2?.passed === false) return { phase: "GATE_2" };
  if (gates.evaluations.some((evaluation) => evaluation.status === "FAIL"))
    return { phase: "REQUIREMENT" };
  const message = object(job.report)?.error;
  const stopped =
    typeof message === "string" ? /V1 stopped in ([A-Z_]+)/.exec(message)?.[1] : undefined;
  const byState: Partial<Record<JobState, NonNullable<BenchmarkObservation["failure"]>["phase"]>> =
    {
      INSPECTING: "INSPECT",
      COMPILING: "COMPILE",
      PLANNING: "PLAN",
      EXECUTING: "BLENDER",
      VERIFYING_GATE_1: "GATE_1",
      EXPORTING: "EXPORT",
      IMPORTING: "STUDIO_IMPORT",
      VERIFYING_GATE_2: "GATE_2",
      EVALUATING: "REQUIREMENT",
    };
  return { phase: stopped ? (byState[stopped as JobState] ?? "UNKNOWN") : "UNKNOWN" };
}

/** Derive a compact local measurement record from persisted facts, without replaying a Job. */
export function makeBenchmarkObservation(
  job: Job,
  options: { caseId?: string; capturedAt?: string } = {},
): BenchmarkObservation {
  const gates = report(job.report);
  const input = job.artifacts?.find(
    (artifact) =>
      artifact.jobId === job.id &&
      artifact.type === "INPUT_FBX" &&
      job.inputAssets.some((reference) => reference.artifactId === artifact.id),
  );
  const output = artifactForOperation(job, "asset.export_fbx", "EXPORTED_FBX");
  const exported = !!output?.hash && !!output.bytes && output.bytes > 0;
  const outputImport = job.executionPlan?.operations.find((operation) => {
    if (operation.capability !== "roblox.import_asset" || operation.status !== "SUCCEEDED")
      return false;
    return object(object(operation.input)?.artifact)?.id === output?.id;
  });
  const failedOutputImport = job.executionPlan?.operations.find(
    (operation) =>
      operation.capability === "roblox.import_asset" &&
      operation.status === "FAILED" &&
      object(object(operation.input)?.artifact)?.id === output?.id,
  );
  const imported = object(object(outputImport?.result)?.value);
  const uploaded =
    !!output?.hash &&
    evidenceValue(job, "upload.receipt").some(
      (receipt) =>
        receipt.artifactId === output.id &&
        receipt.sha256 === output.hash &&
        receipt.status === "SUCCEEDED" &&
        typeof receipt.assetId === "string" &&
        /^[1-9][0-9]*$/.test(receipt.assetId),
    );
  const inserted =
    !!imported &&
    evidenceValue(job, "import.inserted").some((entry) => sameAsset(entry.asset, imported));
  const exactInspectionEvidenceIds = new Set(
    (job.evidence ?? []).flatMap((entry) => {
      if (
        !imported ||
        entry.jobId !== job.id ||
        entry.source !== "ROBLOX" ||
        entry.type !== "asset.inspection"
      )
        return [];
      const value = object(entry.value);
      return sameAsset(value?.imported, imported) && !!object(value?.observed) ? [entry.id] : [];
    }),
  );
  const inspected = exactInspectionEvidenceIds.size > 0;
  const observedInput = (job.evidence ?? []).some((entry) => {
    const value = object(entry.value);
    return (
      entry.jobId === job.id &&
      entry.source === "INPUT" &&
      entry.type === "asset.inspection" &&
      typeof value?.meshes === "number" &&
      value.meshes > 0
    );
  });
  const contract = evidenceValue(job, "mcp.contract")
    .map((value) => value.sha256)
    .find((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
  const requirements = job.requirements.map((requirement) => {
    const evaluation = gates.evaluations.find((item) => item.requirementId === requirement.id);
    const backed =
      !!evaluation?.evidenceIds.length &&
      evaluation.evidenceIds.every((id) => exactInspectionEvidenceIds.has(id));
    const result: AssessmentStatus =
      requirement.status === "PASSED" && evaluation?.status === "PASS" && backed
        ? "PASS"
        : requirement.status === "FAILED" || evaluation?.status === "FAIL"
          ? "FAIL"
          : "UNKNOWN";
    return {
      id: requirement.id,
      type: requirement.type,
      mandatory: requirement.mandatory,
      result,
      evidenceIds: evaluation?.evidenceIds ?? [],
    };
  });
  const mandatory = requirements.filter((requirement) => requirement.mandatory);
  const gate2Status =
    gates.gate2?.passed === false
      ? "FAIL"
      : inserted &&
          inspected &&
          gates.gate2?.evidenceIds.some((id) => exactInspectionEvidenceIds.has(id))
        ? gateStatus(job, gates.gate2)
        : "UNKNOWN";
  const mandatoryStatus: AssessmentStatus =
    job.state === "COMPLETED" &&
    hasCompletionEvidence(job) &&
    gate2Status === "PASS" &&
    mandatory.length > 0 &&
    mandatory.every((requirement) => requirement.result === "PASS")
      ? "PASS"
      : job.state === "FAILED" ||
          gate2Status === "FAIL" ||
          mandatory.some((requirement) => requirement.result === "FAIL")
        ? "FAIL"
        : "UNKNOWN";
  const failed = job.executionPlan?.operations.find((operation) => operation.status === "FAILED");
  const failedOutputInspection =
    !!imported &&
    job.executionPlan?.operations.some(
      (operation) =>
        operation.capability === "roblox.inspect_asset" &&
        operation.status === "FAILED" &&
        sameAsset(object(operation.input)?.asset, imported),
    );
  const stage = (verified: boolean, capability?: string): AssessmentStatus =>
    verified ? "PASS" : failed?.capability === capability ? "FAIL" : "UNKNOWN";
  return Schema.decodeUnknownSync(BenchmarkObservationSchema)({
    version: 1,
    jobId: job.id,
    ...(options.caseId ? { caseId: options.caseId } : {}),
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    prompt: job.prompt,
    jobState: job.state,
    input: {
      ...(input?.hash ? { sha256: input.hash } : {}),
      ...(input?.bytes ? { bytes: input.bytes } : {}),
    },
    output: {
      ...(output?.hash ? { sha256: output.hash } : {}),
      ...(output?.bytes ? { bytes: output.bytes } : {}),
    },
    studio: {
      ...(job.environment.studioId ? { id: job.environment.studioId } : {}),
      ...(contract ? { contractSha256: contract } : {}),
      ...(imported && typeof imported.instanceName === "string"
        ? { importedInstanceName: imported.instanceName }
        : {}),
    },
    procedures: (job.executionPlan?.operations ?? []).flatMap((operation: ExecutionOperation) =>
      operation.procedureId && operation.procedureVersion
        ? [
            {
              capability: operation.capability,
              procedureId: operation.procedureId,
              version: operation.procedureVersion,
            },
          ]
        : [],
    ),
    transfer: {
      blenderInspected: stage(observedInput, "asset.inspect"),
      gate1: gateStatus(job, gates.gate1),
      exportProduced: stage(exported, "asset.export_fbx"),
      openCloudUpload: uploaded
        ? "PASS"
        : failedOutputImport?.error?.startsWith("Open Cloud ")
          ? "FAIL"
          : "UNKNOWN",
      studioInserted: inserted ? "PASS" : failedOutputImport && uploaded ? "FAIL" : "UNKNOWN",
      exactInstanceInspected: inspected ? "PASS" : failedOutputInspection ? "FAIL" : "UNKNOWN",
      gate2: gate2Status,
    },
    promptResult: { mandatory: mandatoryStatus, requirements },
    ...(failurePhase(job, gates) ? { failure: failurePhase(job, gates) } : {}),
  });
}
