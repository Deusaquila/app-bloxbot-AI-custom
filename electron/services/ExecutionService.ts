import { Context, Data, Effect, Layer } from "effect";
import type { ExecutionOperation, ExecutionPlan } from "../../src/types/job";
import { CapabilityRouter } from "../control/CapabilityRouter";
import { V1_PROCEDURE_REGISTRY } from "../control/procedureRegistry";
import { OpenCloudError } from "./RobloxOpenCloudAssetService";
export class ExecutionServiceError extends Data.TaggedError("ExecutionServiceError")<{
  message: string;
  operationId?: string;
  cause?: unknown;
}> {}
export interface ExecutionServiceApi {
  readonly execute: (
    plan: ExecutionPlan,
    onOperation?: (operation: ExecutionOperation) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<readonly ExecutionOperation[], ExecutionServiceError>;
}
export class ExecutionService extends Context.Tag("ExecutionService")<
  ExecutionService,
  ExecutionServiceApi
>() {}
export function validateExecutionPlan(plan: ExecutionPlan): void {
  const ids = new Set(plan.operations.map((op) => op.id));
  if (!ids.size || ids.size !== plan.operations.length)
    throw new Error("Empty graph or duplicate operation IDs");
  if (plan.operations.some((op) => op.dependsOn.some((id) => !ids.has(id))))
    throw new Error("Missing dependency");
  const visited = new Set<string>();
  while (visited.size < ids.size) {
    const ready = plan.operations.filter(
      (op) => !visited.has(op.id) && op.dependsOn.every((id) => visited.has(id)),
    );
    if (!ready.length) throw new Error("Cyclic execution graph");
    for (const operation of ready) visited.add(operation.id);
  }
  for (const operation of plan.operations) {
    const procedure = V1_PROCEDURE_REGISTRY.resolve(operation.capability);
    if (!procedure) throw new Error(`No procedure registered for ${operation.capability}`);
    if (procedure.executor !== operation.executor)
      throw new Error(`Executor mismatch for ${operation.capability}`);
  }
}
function safeFailure(capability: string, error: unknown): string {
  let cursor = error;
  for (let depth = 0; depth < 8 && cursor && typeof cursor === "object"; depth++) {
    if (cursor instanceof OpenCloudError)
      return (
        "Open Cloud " +
        cursor.code +
        (cursor.httpStatus ? ` HTTP ${cursor.httpStatus}` : "") +
        ": " +
        cursor.message
      );
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return `Capability failed: ${capability}`;
}
export const ExecutionServiceLive = Layer.effect(
  ExecutionService,
  Effect.gen(function* () {
    const router = yield* CapabilityRouter;
    return ExecutionService.of({
      execute: (plan, onOperation = () => Effect.void) =>
        Effect.gen(function* () {
          yield* Effect.try(() => validateExecutionPlan(plan));
          const completed = new Map<string, ExecutionOperation>();
          while (completed.size < plan.operations.length) {
            const ready = plan.operations.filter(
              (op) =>
                !completed.has(op.id) &&
                op.dependsOn.every((id) => completed.get(id)?.status === "SUCCEEDED"),
            );
            const results = yield* Effect.all(
              ready.map((op) =>
                Effect.gen(function* () {
                  const procedure = V1_PROCEDURE_REGISTRY.resolve(op.capability);
                  if (!procedure)
                    return yield* Effect.fail(
                      new ExecutionServiceError({
                        message: `No procedure registered for ${op.capability}`,
                        operationId: op.id,
                      }),
                    );
                  const running = {
                    ...op,
                    procedureId: procedure.id,
                    procedureVersion: procedure.version,
                    status: "RUNNING" as const,
                    attempts: op.attempts + 1,
                  };
                  yield* onOperation(running);
                  const outcome = yield* router
                    .execute(op.capability, {
                      ...(op.input as Record<string, unknown>),
                      operationId: op.id,
                    })
                    .pipe(Effect.either);
                  const result: ExecutionOperation =
                    outcome._tag === "Right"
                      ? { ...running, status: "SUCCEEDED", result: outcome.right }
                      : {
                          ...running,
                          status: "FAILED",
                          error: safeFailure(op.capability, outcome.left),
                        };
                  yield* onOperation(result);
                  return result;
                }),
              ),
              { concurrency: 4 },
            );
            for (const result of results) completed.set(result.id, result);
            const failed = results.find((op) => op.status === "FAILED");
            if (failed)
              return yield* Effect.fail(
                new ExecutionServiceError({
                  message: failed.error ?? `Capability failed: ${failed.capability}`,
                  operationId: failed.id,
                }),
              );
          }
          const orderedResults = plan.operations.flatMap((op) => {
            const result = completed.get(op.id);
            return result ? [result] : [];
          });
          if (orderedResults.length !== plan.operations.length)
            return yield* Effect.fail(
              new ExecutionServiceError({ message: "Execution completed with a missing result" }),
            );
          return orderedResults;
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof ExecutionServiceError
              ? cause
              : new ExecutionServiceError({ message: "Execution failed", cause }),
          ),
        ),
    });
  }),
);
