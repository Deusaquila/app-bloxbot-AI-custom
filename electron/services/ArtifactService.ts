import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { Context, Data, Effect, Layer } from "effect";

import type { Artifact, ArtifactType } from "../../src/types/job";

export class ArtifactServiceError extends Data.TaggedError("ArtifactServiceError")<{
  message: string;
  cause?: unknown;
}> {}

export interface RegisterArtifactInput {
  jobId: string;
  type: ArtifactType;
  sourcePath: string;
  destinationDirectory: string;
  parentArtifactId?: string;
  createdByOperationId?: string;
}

export interface ArtifactServiceApi {
  readonly registerFile: (input: RegisterArtifactInput) => Effect.Effect<Artifact, ArtifactServiceError>;
}

export class ArtifactService extends Context.Tag("ArtifactService")<
  ArtifactService,
  ArtifactServiceApi
>() {}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export const ArtifactServiceLive = Layer.succeed(
  ArtifactService,
  ArtifactService.of({
    registerFile: (input) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(input.destinationDirectory, { recursive: true });
          const id = randomUUID();
          const destination = join(input.destinationDirectory, `${id}-${basename(input.sourcePath)}`);
          await copyFile(input.sourcePath, destination);
          return {
            id,
            jobId: input.jobId,
            type: input.type,
            path: destination,
            ...(input.parentArtifactId ? { parentArtifactId: input.parentArtifactId } : {}),
            ...(input.createdByOperationId ? { createdByOperationId: input.createdByOperationId } : {}),
            hash: await hashFile(destination),
            createdAt: new Date().toISOString(),
          };
        },
        catch: (cause) => new ArtifactServiceError({ message: "Failed to register artifact", cause }),
      }),
  }),
);
