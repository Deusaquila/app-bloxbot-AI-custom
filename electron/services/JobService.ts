import { randomUUID } from "node:crypto";

import { Context, Data, Effect, Layer, Ref } from "effect";

import type { AssetRef, Job, JobState } from "../../src/types/job";
import { canTransitionJob } from "../control/jobStateMachine";

export class JobServiceError extends Data.TaggedError("JobServiceError")<{
  message: string;
  jobId?: string;
}> {}

export interface CreateJobInput {
  prompt: string;
  inputAssets: AssetRef[];
}

export interface JobServiceApi {
  readonly create: (input: CreateJobInput) => Effect.Effect<Job>;
  readonly get: (jobId: string) => Effect.Effect<Job, JobServiceError>;
  readonly transition: (jobId: string, state: JobState) => Effect.Effect<Job, JobServiceError>;
  readonly list: Effect.Effect<readonly Job[]>;
}

export class JobService extends Context.Tag("JobService")<JobService, JobServiceApi>() {}

function now(): string {
  return new Date().toISOString();
}

export const JobServiceLive = Layer.effect(
  JobService,
  Effect.gen(function* () {
    const jobs = yield* Ref.make(new Map<string, Job>());

    const get = (jobId: string) =>
      Ref.get(jobs).pipe(
        Effect.flatMap((state) => {
          const job = state.get(jobId);
          return job
            ? Effect.succeed(job)
            : Effect.fail(new JobServiceError({ message: `Unknown job ${jobId}`, jobId }));
        }),
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
          yield* Ref.update(jobs, (state) => new Map(state).set(job.id, job));
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
          yield* Ref.update(jobs, (jobsState) => new Map(jobsState).set(jobId, next));
          return next;
        }),
      list: Ref.get(jobs).pipe(Effect.map((state) => [...state.values()])),
    });
  }),
);
