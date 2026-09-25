import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import type { SystemEvent } from "../../src/types/job";
import { JobStore } from "./JobStore";

export interface EmitEventInput {
  jobId: string;
  type: string;
  entityType?: string;
  entityId?: string;
  data?: unknown;
}

export interface EventStoreApi {
  readonly emit: (input: EmitEventInput) => Effect.Effect<SystemEvent, unknown>;
  readonly list: Effect.Effect<readonly SystemEvent[], unknown>;
}

export class EventStore extends Context.Tag("EventStore")<EventStore, EventStoreApi>() {}

export const EventStoreLive = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const store = yield* JobStore;
    return EventStore.of({
      emit: (input) =>
        Effect.gen(function* () {
          const event: SystemEvent = {
            id: randomUUID(),
            jobId: input.jobId,
            type: input.type,
            ...(input.entityType ? { entityType: input.entityType } : {}),
            ...(input.entityId ? { entityId: input.entityId } : {}),
            data: input.data ?? {},
            timestamp: new Date().toISOString(),
          };
          yield* store.appendEvent(event);
          return event;
        }),
      list: store.loadEvents,
    });
  }),
);
