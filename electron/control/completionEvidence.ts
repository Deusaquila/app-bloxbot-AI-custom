import { Schema } from "effect";
import type { Job } from "../../src/types/job";
import { GateResultSchema, RequirementEvaluationSchema } from "../../src/types/evaluation";
const Report = Schema.Struct({
  gate1: GateResultSchema,
  gate2: GateResultSchema,
  evaluations: Schema.Array(RequirementEvaluationSchema),
});
/** Validate persisted facts at the state boundary, not a caller's in-memory outcome. */
export function hasCompletionEvidence(job: Job): boolean {
  const parsed = Schema.decodeUnknownEither(Report)(job.report);
  if (parsed._tag === "Left" || !job.environment.studioId) return false;
  const { gate1, gate2, evaluations } = parsed.right;
  const evidence = new Map((job.evidence ?? []).map((item) => [item.id, item]));
  const backed = (ids: readonly string[], source: string) =>
    ids.length > 0 &&
    ids.every((id) => evidence.get(id)?.source === source && evidence.get(id)?.jobId === job.id);
  if (gate1.gate !== "GATE_1" || gate2.gate !== "GATE_2") return false;
  for (const gate of [gate1, gate2]) {
    const source = gate.gate === "GATE_1" ? "BLENDER" : "ROBLOX";
    if (
      !gate.passed ||
      !gate.checks.length ||
      !backed(gate.evidenceIds, source) ||
      gate.checks.some((check) => !check.passed || !backed(check.evidenceIds, source))
    )
      return false;
  }
  const mandatory = job.requirements.filter((requirement) => requirement.mandatory);
  if (
    !mandatory.length ||
    mandatory.some(
      (requirement) =>
        requirement.status !== "PASSED" ||
        evaluations.filter(
          (evaluation) =>
            evaluation.requirementId === requirement.id &&
            evaluation.status === "PASS" &&
            backed(evaluation.evidenceIds, "ROBLOX"),
        ).length !== 1,
    )
  )
    return false;
  const operations = job.executionPlan?.operations ?? [];
  return (
    operations.length > 0 &&
    operations.every((op) => op.status === "SUCCEEDED" && op.result !== undefined) &&
    ["asset.export_fbx", "roblox.import_asset", "roblox.inspect_asset"].every((capability) =>
      operations.some((op) => op.capability === capability),
    )
  );
}
