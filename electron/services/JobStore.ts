import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Context, Data, Effect, Layer, Ref, Schema } from "effect";

import { JobSchema, SystemEventSchema, type Job, type SystemEvent } from "../../src/types/job";

const SnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  jobs: Schema.Array(JobSchema),
  events: Schema.Array(SystemEventSchema),
});

type Snapshot = typeof SnapshotSchema.Type;

export class JobStoreError extends Data.TaggedError("JobStoreError")<{
  message: string;
  cause?: unknown;
}> {}

export interface JobStoreApi {
  readonly loadJobs: Effect.Effect<readonly Job[], JobStoreError>;
  readonly loadEvents: Effect.Effect<readonly SystemEvent[], JobStoreError>;
  readonly saveJob: (job: Job) => Effect.Effect<void, JobStoreError>;
  readonly appendEvent: (event: SystemEvent) => Effect.Effect<void, JobStoreError>;
}

export class JobStore extends Context.Tag("JobStore")<JobStore, JobStoreApi>() {}

const emptySnapshot = (): Snapshot => ({ version: 1, jobs: [], events: [] });

function isMissingFile(cause: unknown): boolean {
  return cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT";
}

export function makeFileJobStoreLayer(path: string) {
  return Layer.effect(
    JobStore,
    Effect.gen(function* () {
      const mutex = Effect.unsafeMakeSemaphore(1);
      const snapshotRef = yield* Ref.make<Snapshot>(emptySnapshot());

      const persist = (snapshot: Snapshot) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.${process.pid}.tmp`;
            try {
              await writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
              await rename(temporary, path);
            } catch (cause) {
              await rm(temporary, { force: true }).catch(() => undefined);
              throw cause;
            }
          },
          catch: (cause) => new JobStoreError({ message: "Failed to persist job store", cause }),
        });

      const initial = yield* Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => new JobStoreError({ message: "Failed to read job store", cause }),
      }).pipe(
        Effect.flatMap((contents) =>
          Effect.try({
            try: () => JSON.parse(contents) as unknown,
            catch: (cause) => new JobStoreError({ message: "Job store contains invalid JSON", cause }),
          }),
        ),
        Effect.flatMap((value) =>
          Schema.decodeUnknown(SnapshotSchema)(value).pipe(
            Effect.mapError((cause) => new JobStoreError({ message: "Job store schema is invalid", cause })),
          ),
        ),
        Effect.catchAll((error) =>
          isMissingFile(error.cause) ? Effect.succeed(emptySnapshot()) : Effect.fail(error),
        ),
      );
      yield* Ref.set(snapshotRef, initial);

      const mutate = (f: (snapshot: Snapshot) => Snapshot) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(snapshotRef);
          const next = f(current);
          yield* persist(next);
          yield* Ref.set(snapshotRef, next);
        }).pipe(mutex.withPermits(1));

      return JobStore.of({
        loadJobs: Ref.get(snapshotRef).pipe(Effect.map((snapshot) => snapshot.jobs)),
        loadEvents: Ref.get(snapshotRef).pipe(Effect.map((snapshot) => snapshot.events)),
        saveJob: (job) =>
          mutate((snapshot) => ({
            ...snapshot,
            jobs: [...snapshot.jobs.filter((candidate) => candidate.id !== job.id), job],
          })),
        appendEvent: (event) =>
          mutate((snapshot) => ({ ...snapshot, events: [...snapshot.events, event] })),
      });
    }),
  );
}
