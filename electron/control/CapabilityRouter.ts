import { Context, Data, Effect, Layer } from "effect";

import { findCapability } from "./capabilityRegistry";
import { BlenderService } from "../services/BlenderService";

export class CapabilityRouterError extends Data.TaggedError("CapabilityRouterError")<{
  message: string;
  cause?: unknown;
}> {}

export interface CapabilityRouterApi {
  readonly execute: (capability: string, input: unknown) => Effect.Effect<unknown, CapabilityRouterError>;
}

export class CapabilityRouter extends Context.Tag("CapabilityRouter")<
  CapabilityRouter,
  CapabilityRouterApi
>() {}

export const CapabilityRouterLive = Layer.effect(
  CapabilityRouter,
  Effect.gen(function* () {
    const blender = yield* BlenderService;
    return CapabilityRouter.of({
      execute: (capability, input) => {
        const definition = findCapability(capability);
        if (!definition) {
          return Effect.fail(new CapabilityRouterError({ message: `Unknown capability: ${capability}` }));
        }
        if (definition.executor !== "BLENDER") {
          return Effect.fail(
            new CapabilityRouterError({ message: `Executor ${definition.executor} is not wired yet` }),
          );
        }
        return blender.executeCapability(capability, input).pipe(
          Effect.mapError((cause) =>
            new CapabilityRouterError({ message: `Capability ${capability} failed`, cause }),
          ),
        );
      },
    });
  }),
);
