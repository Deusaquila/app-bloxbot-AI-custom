import { Context, Data, Effect } from "effect";

import type { Artifact, Evidence } from "../../src/types/job";

export interface RobloxAssetRef {
  id: string;
  studioId: string;
  instanceName: string;
}

export interface RobloxAssetFingerprint {
  objects: number;
  materials: number;
  dimensions: { x: number; y: number; z: number };
  hierarchyValid: boolean;
  colors: readonly (readonly number[])[];
  texturedParts: number;
}

export class RobloxServiceError extends Data.TaggedError("RobloxServiceError")<{
  message: string;
  cause?: unknown;
}> {}

export interface RobloxServiceApi {
  readonly importAsset: (
    artifact: Artifact,
    studioId: string,
  ) => Effect.Effect<RobloxAssetRef, RobloxServiceError>;
  readonly inspectAsset: (
    asset: RobloxAssetRef,
  ) => Effect.Effect<RobloxAssetFingerprint, RobloxServiceError>;
  readonly captureEvidence: (
    jobId: string,
    asset: RobloxAssetRef,
    requirementIds: readonly string[],
  ) => Effect.Effect<readonly Evidence[], RobloxServiceError>;
}

export class RobloxService extends Context.Tag("RobloxService")<
  RobloxService,
  RobloxServiceApi
>() {}
