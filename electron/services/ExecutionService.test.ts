import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { CapabilityRouter, CapabilityRouterError } from "../control/CapabilityRouter";
import { ExecutionService, ExecutionServiceLive } from "./ExecutionService";
import type { ExecutionOperation } from "../../src/types/job";
const op = (id: string, dependsOn: string[] = []): ExecutionOperation => ({
  id,
  dependsOn,
  capability: "test",
  input: {},
  requirementIds: [],
  executor: "SYSTEM",
  status: "PENDING",
  attempts: 0,
});
describe("ExecutionService", () => {
  it("validates the whole graph before any side effect", async () => {
    let calls = 0;
    const layer = ExecutionServiceLive.pipe(
      Layer.provide(
        Layer.succeed(CapabilityRouter, {
          execute: () => {
            calls++;
            return Effect.succeed({});
          },
        }),
      ),
    );
    for (const operations of [
      [op("a"), op("b", ["missing"])],
      [op("a", ["b"]), op("b", ["a"])],
      [op("a"), op("a")],
    ]) {
      await expect(
        Effect.runPromise(
          Effect.flatMap(ExecutionService, (engine) => engine.execute({ operations })).pipe(
            Effect.provide(layer),
          ),
        ),
      ).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it("persists running and failed states and prevents dependent execution", async () => {
    const recorded: ExecutionOperation[] = [];
    const layer = ExecutionServiceLive.pipe(
      Layer.provide(
        Layer.succeed(CapabilityRouter, {
          execute: () => Effect.fail(new CapabilityRouterError({ message: "failure" })),
        }),
      ),
    );
    await expect(
      Effect.runPromise(
        Effect.flatMap(ExecutionService, (engine) =>
          engine.execute({ operations: [op("a"), op("b", ["a"])] }, (item) =>
            Effect.sync(() => {
              recorded.push(item);
            }),
          ),
        ).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow();
    expect(recorded.map((item) => [item.id, item.status, item.attempts])).toEqual([
      ["a", "RUNNING", 1],
      ["a", "FAILED", 1],
    ]);
  });
  it("persists results and waits for both branches before their dependent", async () => {
    const states: string[] = [];
    const layer = ExecutionServiceLive.pipe(
      Layer.provide(
        Layer.succeed(CapabilityRouter, { execute: () => Effect.succeed({ value: 42 }) }),
      ),
    );
    const result = await Effect.runPromise(
      Effect.flatMap(ExecutionService, (engine) =>
        engine.execute({ operations: [op("a"), op("b"), op("c", ["a", "b"])] }, (item) =>
          Effect.sync(() => {
            states.push(item.id + item.status);
          }),
        ),
      ).pipe(Effect.provide(layer)),
    );
    expect(states.indexOf("cRUNNING")).toBeGreaterThan(states.indexOf("aSUCCEEDED"));
    expect(states.indexOf("cRUNNING")).toBeGreaterThan(states.indexOf("bSUCCEEDED"));
    expect(result[2].result).toEqual({ value: 42 });
  });
});
