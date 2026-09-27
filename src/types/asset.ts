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
  baseColor: Schema.optional(
    Schema.Tuple(Schema.Number, Schema.Number, Schema.Number, Schema.Number),
  ),
  /** Missing on older persisted fingerprints means the texture state is unknown. */
  hasTextures: Schema.optional(Schema.Boolean),
  textureImages: Schema.optional(Schema.Array(Schema.String)),
  omittedTextureImages: Schema.optional(NonNegativeInteger),
  alpha: Schema.optional(Schema.Number),
});
export type MaterialFingerprint = typeof MaterialFingerprintSchema.Type;

export const MaterialSlotFingerprintSchema = Schema.Struct({
  objectId: Schema.String,
  index: NonNegativeInteger,
  materialName: Schema.optional(Schema.String),
  assignedFaces: NonNegativeInteger,
});
export type MaterialSlotFingerprint = typeof MaterialSlotFingerprintSchema.Type;

export const MeshFingerprintSchema = Schema.Struct({
  objectId: Schema.String,
  vertices: NonNegativeInteger,
  edges: NonNegativeInteger,
  faces: NonNegativeInteger,
  triangles: NonNegativeInteger,
  unmappedFaces: NonNegativeInteger,
  dimensions: Vector3Schema,
  materialSlots: Schema.Array(MaterialSlotFingerprintSchema),
});
export type MeshFingerprint = typeof MeshFingerprintSchema.Type;

export const AssetObjectNodeSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  parentId: Schema.optional(Schema.String),
  depth: NonNegativeInteger,
  location: Vector3Schema,
  rotation: Vector3Schema,
  scale: Vector3Schema,
  hiddenViewport: Schema.Boolean,
  hiddenRender: Schema.Boolean,
});
export type AssetObjectNode = typeof AssetObjectNodeSchema.Type;

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
    armatureIds: Schema.optional(Schema.Array(Schema.String)),
    deformBones: Schema.optional(NonNegativeInteger),
    skinnedMeshes: Schema.optional(NonNegativeInteger),
    weightedVertices: Schema.optional(NonNegativeInteger),
    unweightedVertices: Schema.optional(NonNegativeInteger),
    animationClips: Schema.optional(Schema.Array(Schema.String)),
  }),
  topology: Schema.Struct({
    manifoldRatio: Schema.optional(NonNegativeNumber),
    looseGeometry: Schema.optional(Schema.Boolean),
    edges: Schema.optional(NonNegativeInteger),
    manifoldEdges: Schema.optional(NonNegativeInteger),
    boundaryEdges: Schema.optional(NonNegativeInteger),
    nonManifoldEdges: Schema.optional(NonNegativeInteger),
    wireEdges: Schema.optional(NonNegativeInteger),
    looseVertices: Schema.optional(NonNegativeInteger),
    degenerateFaces: Schema.optional(NonNegativeInteger),
  }),
  /** Optional so fingerprints persisted before the V2 inspector remain valid. */
  geometry: Schema.optional(
    Schema.Struct({
      disconnectedComponents: Schema.optional(NonNegativeInteger),
      meshes: Schema.optional(Schema.Array(MeshFingerprintSchema)),
      omittedMeshes: Schema.optional(NonNegativeInteger),
    }),
  ),
  /** Object graph and local transforms, bounded by the inspector's node limit. */
  structure: Schema.optional(
    Schema.Struct({
      rootObjects: NonNegativeInteger,
      parentedObjects: NonNegativeInteger,
      emptyObjects: NonNegativeInteger,
      maximumDepth: NonNegativeInteger,
      omittedObjects: NonNegativeInteger,
      objectTypes: Schema.Array(Schema.Struct({ type: Schema.String, count: NonNegativeInteger })),
      objectNodes: Schema.Array(AssetObjectNodeSchema),
    }),
  ),
  issues: Schema.Array(AssetIssueSchema),
});
export type AssetFingerprint = typeof AssetFingerprintSchema.Type;
