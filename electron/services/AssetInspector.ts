import { Context, Data, Effect } from "effect";

import type { AssetFingerprint } from "../../src/types/asset";
import type { Artifact } from "../../src/types/job";

export class AssetInspectorError extends Data.TaggedError("AssetInspectorError")<{
  message: string;
  cause?: unknown;
}> {}

export interface AssetInspectorApi {
  readonly inspect: (
    assetId: string,
    artifact: Artifact,
  ) => Effect.Effect<AssetFingerprint, AssetInspectorError>;
}

export class AssetInspector extends Context.Tag("AssetInspector")<
  AssetInspector,
  AssetInspectorApi
>() {}
