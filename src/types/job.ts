import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

export const JobStateSchema = Schema.Literal(
  "CREATED",
  "INSPECTING",
  "COMPILING",
  "PLANNING",
  "EXECUTING",
  "VERIFYING_GATE_1",
  "EXPORTING",
  "IMPORTING",
  "VERIFYING_GATE_2",
  "EVALUATING",
  "CORRECTING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
);
export type JobState = typeof JobStateSchema.Type;

export const ArtifactTypeSchema = Schema.Literal(
  "INPUT_FBX",
  "BLENDER_SCENE",
  "EXPORTED_FBX",
  "ROBLOX_ASSET",
  "RENDER",
  "REPORT",
);
export type ArtifactType = typeof ArtifactTypeSchema.Type;

export const ArtifactSchema = Schema.Struct({
  id: NonEmptyString,
  jobId: NonEmptyString,
  type: ArtifactTypeSchema,
  path: Schema.optional(NonEmptyString),
  parentArtifactId: Schema.optional(NonEmptyString),
  createdByOperationId: Schema.optional(NonEmptyString),
  hash: Schema.optional(NonEmptyString),
  createdAt: NonEmptyString,
});
export type Artifact = typeof ArtifactSchema.Type;

export const RequirementStatusSchema = Schema.Literal(
  "PENDING",
  "PLANNED",
  "EXECUTED",
  "GATE_1_VERIFIED",
  "GATE_2_VERIFIED",
  "PASSED",
  "FAILED",
);
export type RequirementStatus = typeof RequirementStatusSchema.Type;

export const RequirementSchema = Schema.Struct({
  id: NonEmptyString,
  type: NonEmptyString,
  target: Schema.Unknown,
  expected: Schema.Unknown,
  mandatory: Schema.Boolean,
  status: RequirementStatusSchema,
});
export type Requirement = typeof RequirementSchema.Type;

export const OperationStatusSchema = Schema.Literal(
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
);
export type OperationStatus = typeof OperationStatusSchema.Type;

export const ExecutorSchema = Schema.Literal("BLENDER", "ROBLOX", "SYSTEM");
export type Executor = typeof ExecutorSchema.Type;

export const ExecutionOperationSchema = Schema.Struct({
  id: NonEmptyString,
  capability: NonEmptyString,
  requirementIds: Schema.Array(NonEmptyString),
  dependsOn: Schema.Array(NonEmptyString),
  input: Schema.Unknown,
  executor: ExecutorSchema,
  status: OperationStatusSchema,
  attempts: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export type ExecutionOperation = typeof ExecutionOperationSchema.Type;

export const EvidenceSourceSchema = Schema.Literal("INPUT", "BLENDER", "EXPORT", "ROBLOX");
export type EvidenceSource = typeof EvidenceSourceSchema.Type;

export const EvidenceSchema = Schema.Struct({
  id: NonEmptyString,
  jobId: NonEmptyString,
  requirementId: Schema.optional(NonEmptyString),
  source: EvidenceSourceSchema,
  type: NonEmptyString,
  value: Schema.Unknown,
  capturedAt: NonEmptyString,
});
export type Evidence = typeof EvidenceSchema.Type;

export const SystemEventSchema = Schema.Struct({
  id: NonEmptyString,
  jobId: NonEmptyString,
  type: NonEmptyString,
  entityType: Schema.optional(NonEmptyString),
  entityId: Schema.optional(NonEmptyString),
  data: Schema.Unknown,
  timestamp: NonEmptyString,
});
export type SystemEvent = typeof SystemEventSchema.Type;

export const AssetRefSchema = Schema.Struct({
  assetId: NonEmptyString,
  artifactId: NonEmptyString,
});
export type AssetRef = typeof AssetRefSchema.Type;

export const ExecutionPlanSchema = Schema.Struct({
  operations: Schema.Array(ExecutionOperationSchema),
});
export type ExecutionPlan = typeof ExecutionPlanSchema.Type;

export const JobSchema = Schema.Struct({
  id: NonEmptyString,
  state: JobStateSchema,
  prompt: NonEmptyString,
  inputAssets: Schema.Array(AssetRefSchema),
  requirements: Schema.Array(RequirementSchema),
  executionPlan: Schema.optional(ExecutionPlanSchema),
  environment: Schema.Struct({
    blenderInstanceId: Schema.optional(NonEmptyString),
    studioId: Schema.optional(NonEmptyString),
  }),
  artifacts: Schema.optional(Schema.Array(ArtifactSchema)),
  evidence: Schema.optional(Schema.Array(EvidenceSchema)),
  report: Schema.optional(Schema.Unknown),
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
});
export type Job = typeof JobSchema.Type;
