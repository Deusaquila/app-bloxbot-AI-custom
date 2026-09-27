import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

export const EvaluationMethodSchema = Schema.Literal(
  "material_property",
  "relative_bounding_box",
  "import_integrity",
  "structure_property",
);
export type EvaluationMethod = typeof EvaluationMethodSchema.Type;

export const EvaluationSpecSchema = Schema.Struct({
  requirementId: NonEmptyString,
  method: EvaluationMethodSchema,
  expected: Schema.Unknown,
  tolerance: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
});
export type EvaluationSpec = typeof EvaluationSpecSchema.Type;

export const CheckResultSchema = Schema.Struct({
  id: NonEmptyString,
  passed: Schema.Boolean,
  message: NonEmptyString,
  evidenceIds: Schema.Array(NonEmptyString),
});
export type CheckResult = typeof CheckResultSchema.Type;

export const GateResultSchema = Schema.Struct({
  gate: Schema.Literal("GATE_1", "GATE_2"),
  passed: Schema.Boolean,
  checks: Schema.Array(CheckResultSchema),
  evidenceIds: Schema.Array(NonEmptyString),
});
export type GateResult = typeof GateResultSchema.Type;

export const RequirementEvaluationSchema = Schema.Struct({
  requirementId: NonEmptyString,
  status: Schema.Literal("PASS", "FAIL"),
  expected: Schema.Unknown,
  observed: Schema.Unknown,
  confidence: Schema.Number.pipe(Schema.between(0, 1)),
  evidenceIds: Schema.Array(NonEmptyString),
});
export type RequirementEvaluation = typeof RequirementEvaluationSchema.Type;
