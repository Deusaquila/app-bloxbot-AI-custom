import { Context, Data, Effect, Layer } from "effect";

import type { ExecutionOperation, ExecutionPlan } from "../../src/types/job";
import { CapabilityRouter } from "../control/CapabilityRouter";

export class ExecutionServiceError extends Data.TaggedError("ExecutionServiceError")<{
  message: string;
  operationId?: string;
  cause?: unknown;
}> {}

export interface ExecutionServiceApi {
  readonly execute: (plan: ExecutionPlan) => Effect.Effect<readonly ExecutionOperation[], ExecutionServiceError>;
}

export class ExecutionService extends Context.Tag("ExecutionService")<
  ExecutionService,
  ExecutionServiceApi
>() {}

export const ExecutionServiceLive = Layer.effect(
  ExecutionService,
  Effect.gen(function* () {
    const router = yield* CapabilityRouter;
    return ExecutionService.of({
      execute: (plan) =>
        Effect.gen(function* () {
          const completed = new Map<string, ExecutionOperation>();
          while (completed.size < plan.operations.length) {
            const ready = plan.operations.filter(
              (operation) =>
                !completed.has(operation.id) &&
                operation.dependsOn.every((dependency) => completed.get(dependency)?.status === "SUCCEEDED"),
            );
            if (ready.length === 0) {
              return yield* Effect.fail(
                new ExecutionServiceError({ message: "Execution graph is blocked or cyclic" }),
              );
            }
            const results = yield* Effect.all(
              ready.map((operation) =>
                router.execute(operation.capability, operation.input).pipe(
                  Effect.as({ ...operation, status: "SUCCEEDED" as const, attempts: operation.attempts + 1 }),
                  Effect.mapError(
                    (cause) =>
                      new ExecutionServiceError({
                        message: `Operation ${operation.id} failed`,
                        operationId: operation.id,
                        cause,
                      }),
                  ),
                ),
              ),
              { concurrency: "unbounded" },
            );
            for (const result of results) completed.set(result.id, result);
          }
          return plan.operations.map((operation) => completed.get(operation.id) ?? operation);
        }),
    });
  }),
);
