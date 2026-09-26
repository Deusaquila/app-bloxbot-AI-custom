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
  studioId?: string;
}

export interface JobServiceApi {
  readonly create: (input: CreateJobInput) => Effect.Effect<Job, JobServiceError>;
  readonly get: (jobId: string) => Effect.Effect<Job, JobServiceError>;
  readonly transition: (jobId: string, state: JobState) => Effect.Effect<Job, JobServiceError>;
  readonly checkpoint: (jobId: string, update: (job: Job) => Pick<Job, "inputAssets" | "requirements" | "executionPlan" | "artifacts" | "evidence" | "report">) => Effect.Effect<Job, JobServiceError>;
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
    // An interrupted run must never silently repeat uploads or scale a derived scene again.
    const recovered: Job[] = [];
    for (const job of persisted) {
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.state)) { recovered.push(job); continue; }
      const next: Job = { ...job, state: job.state === "CREATED" ? "CANCELLED" : "FAILED", updatedAt: now(),
        executionPlan: job.executionPlan ? { operations: job.executionPlan.operations.map(op => op.status === "RUNNING"
          ? { ...op, status: "FAILED" as const, error: "Process interrupted; remote outcome may require inspection" } : op) } : undefined,
        report: { previous: job.report, error: "Run interrupted. Inspect saved upload/import receipts before creating another job." } };
      yield* store.saveJob(next).pipe(Effect.mapError(cause => new JobServiceError({ message: "Failed to persist recovery", jobId: job.id, cause })));
      recovered.push(next);
    }
    const mutex = yield* Effect.makeSemaphore(1);
    const jobs = yield* Ref.make(new Map(recovered.map((job) => [job.id, job])));

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

    const emit = (jobId: string, input: Parameters<typeof events.emit>[0]) =>
      events.emit(input).pipe(
        Effect.mapError(
          (cause) => new JobServiceError({ message: `Failed to persist event for job ${jobId}`, jobId, cause }),
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
            environment: input.studioId ? { studioId: input.studioId } : {},
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
          yield* emit(job.id, { jobId: job.id, type: "job.created", entityType: "job", entityId: job.id });
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
          yield* emit(jobId, {
            jobId,
            type: "job.state_changed",
            entityType: "job",
            entityId: jobId,
            data: { from: current.state, to: state },
          });
          return next;
        }).pipe(mutex.withPermits(1)),
      checkpoint: (jobId, update) => Effect.gen(function* () {
        const current = yield* get(jobId);
        const patch = update(current);
        const next: Job = { ...current, inputAssets: patch.inputAssets, requirements: patch.requirements, executionPlan: patch.executionPlan,
          artifacts: patch.artifacts, evidence: patch.evidence, report: patch.report, updatedAt: now() };
        yield* persist(next);
        yield* Ref.update(jobs, state => new Map(state).set(jobId, next));
        return next;
      }).pipe(mutex.withPermits(1)),
      list: Ref.get(jobs).pipe(Effect.map((state) => [...state.values()])),
    });
  }),
);
