import { Context, Data, Effect, Layer } from "effect";
import { BlenderService } from "../services/BlenderService";
import { RobloxService } from "../services/RobloxService";
import { V1_PROCEDURE_REGISTRY } from "./procedureRegistry";

export class CapabilityRouterError extends Data.TaggedError("CapabilityRouterError")<{
  message: string;
  cause?: unknown;
}> {}

export interface CapabilityRouterApi {
  readonly execute: (
    capability: string,
    input: unknown,
  ) => Effect.Effect<unknown, CapabilityRouterError>;
}

export class CapabilityRouter extends Context.Tag("CapabilityRouter")<
  CapabilityRouter,
  CapabilityRouterApi
>() {}

export const CapabilityRouterLive = Layer.effect(
  CapabilityRouter,
  Effect.gen(function* () {
    const blender = yield* BlenderService;
    const roblox = yield* RobloxService;
    return CapabilityRouter.of({
      execute: (capability, input) => {
        const procedure = V1_PROCEDURE_REGISTRY.resolve(capability);
        if (!procedure) {
          return Effect.fail(
            new CapabilityRouterError({ message: `Unknown capability: ${capability}` }),
          );
        }
        return procedure.invoke({ blender, roblox }, input).pipe(
          Effect.map((value) =>
            procedure.executor === "ROBLOX" ? { status: "SUCCEEDED", value } : value,
          ),
          Effect.mapError(
            (cause) =>
              new CapabilityRouterError({ message: `Capability ${capability} failed`, cause }),
          ),
        );
      },
    });
  }),
);
