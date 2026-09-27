import { Schema } from "effect";
import { JobStateSchema } from "./job";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const Sha256 = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));

export const AssessmentStatusSchema = Schema.Literal("PASS", "FAIL", "UNKNOWN");
export type AssessmentStatus = typeof AssessmentStatusSchema.Type;

export const BenchmarkObservationSchema = Schema.Struct({
  version: Schema.Literal(1),
  jobId: NonEmptyString,
  caseId: Schema.optional(NonEmptyString),
  capturedAt: NonEmptyString,
  prompt: NonEmptyString,
  jobState: JobStateSchema,
  input: Schema.Struct({
    sha256: Schema.optional(Sha256),
    bytes: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
  output: Schema.Struct({
    sha256: Schema.optional(Sha256),
    bytes: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  }),
  studio: Schema.Struct({
    id: Schema.optional(NonEmptyString),
    contractSha256: Schema.optional(Sha256),
    importedInstanceName: Schema.optional(NonEmptyString),
  }),
  procedures: Schema.Array(
    Schema.Struct({
      capability: NonEmptyString,
      procedureId: NonEmptyString,
      version: Schema.Number.pipe(Schema.int(), Schema.positive()),
    }),
  ),
  transfer: Schema.Struct({
    blenderInspected: AssessmentStatusSchema,
    gate1: AssessmentStatusSchema,
    exportProduced: AssessmentStatusSchema,
    openCloudUpload: AssessmentStatusSchema,
    studioInserted: AssessmentStatusSchema,
    exactInstanceInspected: AssessmentStatusSchema,
    gate2: AssessmentStatusSchema,
  }),
  promptResult: Schema.Struct({
    mandatory: AssessmentStatusSchema,
    requirements: Schema.Array(
      Schema.Struct({
        id: NonEmptyString,
        type: NonEmptyString,
        mandatory: Schema.Boolean,
        result: AssessmentStatusSchema,
        evidenceIds: Schema.Array(NonEmptyString),
      }),
    ),
  }),
  failure: Schema.optional(
    Schema.Struct({
      phase: Schema.Literal(
        "INTERRUPTED",
        "INSPECT",
        "COMPILE",
        "PLAN",
        "BLENDER",
        "GATE_1",
        "EXPORT",
        "OPEN_CLOUD",
        "STUDIO_IMPORT",
        "STUDIO_INSPECT",
        "GATE_2",
        "REQUIREMENT",
        "UNKNOWN",
      ),
      capability: Schema.optional(NonEmptyString),
      operationId: Schema.optional(NonEmptyString),
    }),
  ),
});
export type BenchmarkObservation = typeof BenchmarkObservationSchema.Type;

/** Human labels remain separate from automated checks and never overwrite them. */
export const UserRequirementFeedbackSchema = Schema.Struct({
  version: Schema.Literal(1),
  jobId: NonEmptyString,
  requirementId: NonEmptyString,
  verdict: Schema.Literal("SATISFIED", "NOT_SATISFIED", "UNSURE"),
  recordedAt: NonEmptyString,
  note: Schema.optional(Schema.String),
});
export type UserRequirementFeedback = typeof UserRequirementFeedbackSchema.Type;
