import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { makeFileJobStoreLayer } from "./JobStore";
import { EventStoreLive } from "./EventStore";
import { JobServiceLive } from "./JobService";
import { ArtifactServiceLive } from "./ArtifactService";
import { makeWorkspaceServiceLayer } from "./WorkspaceService";
import { makeStudioMcpBrokerLayer, StudioMcpBroker } from "./StudioMcpBroker";

export function makeV1Runtime(root: string, broker?: Layer.Layer<StudioMcpBroker, unknown>) {
  const store = makeFileJobStoreLayer(join(root, "control-plane.json"));
  const workspace = makeWorkspaceServiceLayer(root);
  const jobs = JobServiceLive.pipe(
    Layer.provide(Layer.mergeAll(store, workspace, EventStoreLive.pipe(Layer.provide(store)))),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(
      jobs,
      workspace,
      ArtifactServiceLive,
      broker ??
        makeStudioMcpBrokerLayer({
          workspace: root,
          localAppData: process.env.LOCALAPPDATA,
          comSpec: process.env.ComSpec,
          systemRoot: process.env.SystemRoot,
        }),
    ),
  );
}
