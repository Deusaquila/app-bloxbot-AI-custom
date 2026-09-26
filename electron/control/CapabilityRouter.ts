import { Context, Data, Effect, Layer } from "effect";

import { findCapability } from "./capabilityRegistry";
import { RobloxService, type RobloxAssetRef } from "../services/RobloxService";
import type { Artifact } from "../../src/types/job";
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
    const roblox = yield* RobloxService;
    return CapabilityRouter.of({
      execute: (capability, input) => {
        const definition = findCapability(capability);
        if (!definition) {
          return Effect.fail(new CapabilityRouterError({ message: `Unknown capability: ${capability}` }));
        }
        if (definition.executor === "ROBLOX") {
          const args = input as { artifact: Artifact; studioId: string; asset: RobloxAssetRef };
          const action: Effect.Effect<unknown, import("../services/RobloxService").RobloxServiceError> = capability === "roblox.import_asset" ? roblox.importAsset(args.artifact, args.studioId)
            : roblox.inspectAsset(args.asset);
          return action.pipe(Effect.map(value => ({ status: "SUCCEEDED", value })),
            Effect.mapError(cause => new CapabilityRouterError({ message: "Roblox capability failed", cause })));
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
