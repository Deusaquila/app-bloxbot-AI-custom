import { randomUUID } from "node:crypto";

import { Context, Data, Effect, Layer, Ref } from "effect";

import type { AssetRef, Job, JobState } from "../../src/types/job";
import { canTransitionJob } from "../control/jobStateMachine";
import { EventStore } from "./EventStore";
import { JobStore } from "./JobStore";
import { WorkspaceService } from "./WorkspaceService";

export class JobServiceError extends Data.TaggedError("JobServiceError")<{
  message: string;
  jobId?: string;
  cause?: unknown;
}> {}

export interface CreateJobInput {
  prompt: string;
  inputAssets: AssetRef[];
}

export interface JobServiceApi {
  readonly create: (input: CreateJobInput) => Effect.Effect<Job, JobServiceError>;
  readonly get: (jobId: string) => Effect.Effect<Job, JobServiceError>;
  readonly transition: (jobId: string, state: JobState) => Effect.Effect<Job, JobServiceError>;
  readonly list: Effect.Effect<readonly Job[], JobServiceError>;
}

export class JobService extends Context.Tag("JobService")<JobService, JobServiceApi>() {}

function now(): string {
  return new Date().toISOString();
}

export const JobServiceLive = Layer.effect(
  JobService,
  Effect.gen(function* () {
    const store = yield* JobStore;
    const events = yield* EventStore;
    const workspaces = yield* WorkspaceService;
    const persisted = yield* store.loadJobs.pipe(
      Effect.mapError((cause) => new JobServiceError({ message: "Failed to restore jobs", cause })),
    );
    const jobs = yield* Ref.make(new Map(persisted.map((job) => [job.id, job])));

    const get = (jobId: string) =>
      Ref.get(jobs).pipe(
        Effect.flatMap((state) => {
          const job = state.get(jobId);
          return job
            ? Effect.succeed(job)
            : Effect.fail(new JobServiceError({ message: `Unknown job ${jobId}`, jobId }));
        }),
      );

    const persist = (job: Job) =>
      store.saveJob(job).pipe(
        Effect.mapError((cause) =>
          new JobServiceError({ message: `Failed to persist job ${job.id}`, jobId: job.id, cause }),
        ),
      );

    return JobService.of({
      create: (input) =>
        Effect.gen(function* () {
          const timestamp = now();
          const job: Job = {
            id: randomUUID(),
            state: "CREATED",
            prompt: input.prompt,
            inputAssets: [...input.inputAssets],
            requirements: [],
            environment: {},
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          yield* workspaces.ensureJob(job.id).pipe(
            Effect.mapError((cause) =>
              new JobServiceError({ message: "Failed to initialize job workspace", jobId: job.id, cause }),
            ),
          );
          yield* persist(job);
          yield* Ref.update(jobs, (state) => new Map(state).set(job.id, job));
          yield* events.emit({ jobId: job.id, type: "job.created", entityType: "job", entityId: job.id });
          return job;
        }),
      get,
      transition: (jobId, state) =>
        Effect.gen(function* () {
          const current = yield* get(jobId);
          if (!canTransitionJob(current.state, state)) {
            return yield* Effect.fail(
              new JobServiceError({
                message: `Invalid job transition ${current.state} -> ${state}`,
                jobId,
              }),
            );
          }
          const next: Job = { ...current, state, updatedAt: now() };
          yield* persist(next);
          yield* Ref.update(jobs, (jobsState) => new Map(jobsState).set(jobId, next));
          yield* events.emit({
            jobId,
            type: "job.state_changed",
            entityType: "job",
            entityId: jobId,
            data: { from: current.state, to: state },
          });
          return next;
        }),
      list: Ref.get(jobs).pipe(
        Effect.map((state) => [...state.values()]),
        Effect.mapError((cause) => new JobServiceError({ message: "Failed to list jobs", cause })),
      ),
    });
  }),
);
