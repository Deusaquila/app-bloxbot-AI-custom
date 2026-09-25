import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Effect, Layer, Schema } from "effect";

import type { AssetFingerprint } from "../../src/types/asset";
import type { Artifact } from "../../src/types/job";
import { AssetFingerprintSchema } from "../../src/types/asset";
import { runBlenderScript } from "./BlenderProcess";

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

const WorkerResponseSchema = Schema.Struct({
  ok: Schema.Literal(true),
  capability: Schema.String,
  value: Schema.Unknown,
});

export interface BlenderServiceOptions {
  executable: string;
  workerScript: string;
  workspace: string;
  assetPath: string;
  scenePath?: string;
  timeoutMs?: number;
}

/** A deterministic adapter around the bundled bpy worker. */
export function makeBlenderServiceLayer(options: BlenderServiceOptions) {
  const scenePath = options.scenePath ?? join(options.workspace, "asset.blend");
  const invoke = (capability: string, input: unknown) =>
    Effect.gen(function* () {
      const invocationId = randomUUID();
      const requestPath = join(options.workspace, `${invocationId}.request.json`);
      const responsePath = join(options.workspace, `${invocationId}.response.json`);
      const script = yield* Effect.tryPromise({
        try: () => readFile(options.workerScript, "utf8"),
        catch: (cause) => new BlenderServiceError({ message: "Failed to read Blender worker", cause }),
      });
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(options.workspace, { recursive: true });
          await writeFile(requestPath, JSON.stringify({ capability, input, assetPath: options.assetPath, scenePath }));
        },
        catch: (cause) => new BlenderServiceError({ message: "Failed to write Blender request", cause }),
      });
      yield* runBlenderScript(
        { executable: options.executable, timeoutMs: options.timeoutMs },
        { script, scriptPath: join(options.workspace, "v1_pipeline.py"), args: [requestPath, responsePath] },
      ).pipe(Effect.mapError((cause) => new BlenderServiceError({ message: `${capability} failed`, cause })));
      const raw = yield* Effect.tryPromise({
        try: () => readFile(responsePath, "utf8"),
        catch: (cause) => new BlenderServiceError({ message: "Blender did not produce a response", cause }),
      });
      const decoded = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => new BlenderServiceError({ message: "Blender response is not JSON", cause }),
      });
      const response = yield* Schema.decodeUnknown(WorkerResponseSchema)(decoded).pipe(
        Effect.mapError((cause) => new BlenderServiceError({ message: "Blender response is invalid", cause })),
      );
      if (response.capability !== capability) {
        return yield* Effect.fail(new BlenderServiceError({ message: "Blender response capability mismatch" }));
      }
      yield* Effect.promise(() => Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })])).pipe(Effect.asVoid);
      return response.value;
    });

  return Layer.succeed(
    BlenderService,
    BlenderService.of({
      inspectAsset: (assetId) =>
        invoke("asset.inspect", {}).pipe(
          Effect.flatMap((value) => Schema.decodeUnknown(AssetFingerprintSchema)({ ...(value as object), assetId })),
          Effect.mapError((cause) => new BlenderServiceError({ message: "Asset inspection failed", cause })),
        ),
      executeCapability: (capability, input) =>
        invoke(capability, input).pipe(Effect.map((value) => ({ status: "SUCCEEDED" as const, value }))),
      exportFbx: (assetId, destination) =>
        invoke("asset.export_fbx", { destination }).pipe(
          Effect.map(() => ({
            id: randomUUID(), jobId: assetId, type: "EXPORTED_FBX" as const, path: destination,
            createdAt: new Date().toISOString(),
          })),
        ),
    }),
  );
}
