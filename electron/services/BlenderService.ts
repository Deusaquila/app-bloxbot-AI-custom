import { Context, Data, Effect } from "effect";

import type { AssetFingerprint } from "../../src/types/asset";
import type { Artifact } from "../../src/types/job";

export interface CapabilityResult {
  status: "SUCCEEDED" | "NO_OP_SUCCESS";
  value: unknown;
}

export class BlenderServiceError extends Data.TaggedError("BlenderServiceError")<{
  message: string;
  cause?: unknown;
}> {}

export interface BlenderServiceApi {
  readonly inspectAsset: (
    assetId: string,
    artifact: Artifact,
  ) => Effect.Effect<AssetFingerprint, BlenderServiceError>;
  readonly executeCapability: (
    capability: string,
    input: unknown,
  ) => Effect.Effect<CapabilityResult, BlenderServiceError>;
  readonly exportFbx: (
    assetId: string,
    destination: string,
  ) => Effect.Effect<Artifact, BlenderServiceError>;
}

export class BlenderService extends Context.Tag("BlenderService")<
  BlenderService,
  BlenderServiceApi
>() {}
