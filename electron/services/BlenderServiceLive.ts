import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { AssetFingerprintSchema } from "../../src/types/asset";
import type { Artifact } from "../../src/types/job";
import { ArtifactService } from "./ArtifactService";
import { BlenderService, BlenderServiceError } from "./BlenderService";
import { runBlenderScript, type BlenderProcessOptions } from "./BlenderProcess";
import type { JobWorkspace } from "./WorkspaceService";

export interface BlenderJobOptions extends BlenderProcessOptions {
  assetId: string;
  inputArtifact: Artifact;
  workspace: JobWorkspace;
  script: string;
}

/** One layer per job. A mutex protects the shared scene while DAG branches run concurrently. */
export function makeBlenderServiceLayer(options: BlenderJobOptions) {
  return Layer.effect(
    BlenderService,
    Effect.gen(function* () {
      const artifacts = yield* ArtifactService;
      const mutex = yield* Effect.makeSemaphore(1);
      let current = options.inputArtifact;
      const execute = (capability: string, input: unknown) =>
        Effect.gen(function* () {
          if (!current.path) return yield* Effect.fail(new Error("Blender input has no file path"));
          const id = randomUUID();
          const requestPath = join(options.workspace.blender, id + ".request.json");
          const responsePath = join(options.workspace.blender, id + ".response.json");
          const scenePath = join(options.workspace.blender, id + ".blend");
          const payload =
            typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
          const operationId =
            typeof payload.operationId === "string" ? payload.operationId : undefined;
          const parameters =
            capability === "asset.export_fbx"
              ? { ...payload, destination: join(options.workspace.export, id + ".fbx") }
              : payload;
          yield* Effect.tryPromise(() =>
            writeFile(
              requestPath,
              JSON.stringify({
                assetId: options.assetId,
                assetPath: current.path,
                scenePath,
                capability,
                input: parameters,
              }),
              { flag: "wx" },
            ),
          );
          yield* runBlenderScript(options, {
            script: options.script,
            scriptPath: join(options.workspace.blender, id + ".py"),
            args: [requestPath, responsePath],
          });
          const value = yield* Effect.tryPromise(
            async () => JSON.parse(await readFile(responsePath, "utf8")) as Record<string, unknown>,
          );
          if (capability === "asset.inspect") {
            return {
              status: "SUCCEEDED" as const,
              value: yield* Schema.decodeUnknown(AssetFingerprintSchema)(value),
            };
          }
          if (
            capability === "material.set_base_color" ||
            capability === "transform.scale_uniform" ||
            capability === "asset.export_fbx"
          ) {
            const fingerprint = yield* Schema.decodeUnknown(AssetFingerprintSchema)(
              value.fingerprint,
            );
            const expectedPath =
              capability === "asset.export_fbx" ? parameters.destination : scenePath;
            if (value.path !== expectedPath)
              return yield* Effect.fail(new Error("Blender returned an unexpected artifact path"));
            const artifact = yield* artifacts.registerFile({
              jobId: current.jobId,
              type: capability === "asset.export_fbx" ? "EXPORTED_FBX" : "BLENDER_SCENE",
              sourcePath: value.path as string,
              destinationDirectory:
                capability === "asset.export_fbx"
                  ? options.workspace.export
                  : options.workspace.blender,
              parentArtifactId: current.id,
              createdByOperationId: operationId,
            });
            if (capability !== "asset.export_fbx") current = artifact;
            return { status: "SUCCEEDED" as const, value: { artifact, fingerprint } };
          }
          if (capability === "asset.verify_material" && typeof value.valid !== "boolean") {
            return yield* Effect.fail(new Error("Malformed material verification"));
          }
          if (capability === "asset.verify_dimensions") {
            const vector = value.dimensions as Record<string, unknown> | undefined;
            if (
              !vector ||
              ![vector.x, vector.y, vector.z].every(
                (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
              )
            ) {
              return yield* Effect.fail(new Error("Malformed dimension verification"));
            }
          }
          return { status: "SUCCEEDED" as const, value };
        }).pipe(
          mutex.withPermits(1),
          Effect.mapError(
            (cause) =>
              new BlenderServiceError({
                message: "Blender capability failed: " + capability,
                cause,
              }),
          ),
        );
      return BlenderService.of({
        executeCapability: execute,
        inspectAsset: (assetId, artifact) =>
          assetId !== options.assetId || artifact.id !== options.inputArtifact.id
            ? Effect.fail(
                new BlenderServiceError({ message: "Asset does not belong to this Blender job" }),
              )
            : execute("asset.inspect", {}).pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknown(AssetFingerprintSchema)(result.value),
                ),
                Effect.mapError(
                  (cause) =>
                    new BlenderServiceError({ message: "Invalid asset fingerprint", cause }),
                ),
              ),
        exportFbx: () =>
          execute("asset.export_fbx", {}).pipe(
            Effect.map((result) => (result.value as { artifact: Artifact }).artifact),
          ),
      });
    }),
  );
}
