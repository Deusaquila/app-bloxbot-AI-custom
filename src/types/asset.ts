import { Schema } from "effect";

const NonNegativeInteger = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const NonNegativeNumber = Schema.Number.pipe(Schema.nonNegative());

export const Vector3Schema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  z: Schema.Number,
});
export type Vector3 = typeof Vector3Schema.Type;

export const MaterialFingerprintSchema = Schema.Struct({
  name: Schema.String,
  baseColor: Schema.optional(Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.Number)),
});
export type MaterialFingerprint = typeof MaterialFingerprintSchema.Type;

export const AssetIssueSchema = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literal("INFO", "WARNING", "ERROR"),
  message: Schema.String,
});
export type AssetIssue = typeof AssetIssueSchema.Type;

export const AssetFingerprintSchema = Schema.Struct({
  assetId: Schema.String.pipe(Schema.minLength(1)),
  format: Schema.Literal("fbx"),
  objects: NonNegativeInteger,
  meshes: NonNegativeInteger,
  vertices: NonNegativeInteger,
  triangles: NonNegativeInteger,
  materials: Schema.Array(MaterialFingerprintSchema),
  dimensions: Vector3Schema,
  transforms: Schema.Struct({
    scale: Schema.Tuple(Schema.Number, Schema.Number, Schema.Number),
    rotation: Schema.Tuple(Schema.Number, Schema.Number, Schema.Number),
  }),
  rig: Schema.Struct({
    exists: Schema.Boolean,
    bones: Schema.optional(NonNegativeInteger),
  }),
  topology: Schema.Struct({
    manifoldRatio: Schema.optional(NonNegativeNumber),
    looseGeometry: Schema.optional(Schema.Boolean),
  }),
  issues: Schema.Array(AssetIssueSchema),
});
export type AssetFingerprint = typeof AssetFingerprintSchema.Type;
