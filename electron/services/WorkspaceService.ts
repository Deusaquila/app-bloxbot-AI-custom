import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Effect, Layer } from "effect";

export interface JobWorkspace {
  root: string;
  input: string;
  blender: string;
  export: string;
  roblox: string;
  renders: string;
  reports: string;
}

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  message: string;
  cause?: unknown;
}> {}

export interface WorkspaceServiceApi {
  readonly ensureJob: (jobId: string) => Effect.Effect<JobWorkspace, WorkspaceError>;
}

export class WorkspaceService extends Context.Tag("WorkspaceService")<
  WorkspaceService,
  WorkspaceServiceApi
>() {}

export function makeWorkspaceServiceLayer(root: string) {
  return Layer.succeed(
    WorkspaceService,
    WorkspaceService.of({
      ensureJob: (jobId) =>
        Effect.tryPromise({
          try: async () => {
            const jobRoot = join(root, "jobs", jobId);
            const workspace: JobWorkspace = {
              root: jobRoot,
              input: join(jobRoot, "input"),
              blender: join(jobRoot, "blender"),
              export: join(jobRoot, "export"),
              roblox: join(jobRoot, "roblox"),
              renders: join(jobRoot, "renders"),
              reports: join(jobRoot, "reports"),
            };
            await Promise.all(Object.values(workspace).map((path) => mkdir(path, { recursive: true })));
            return workspace;
          },
          catch: (cause) => new WorkspaceError({ message: "Failed to create job workspace", cause }),
        }),
    }),
  );
}
