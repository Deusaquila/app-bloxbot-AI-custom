import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { BlenderService, makeBlenderServiceLayer } from "../../electron/services/BlenderService";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("makeBlenderServiceLayer", () => {
  it("uses a persistent scene and validates the worker response envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloxbot-blender-"));
    directories.push(root);
    const executable = join(root, "fake-blender");
    const assetPath = join(root, "horse.fbx");
    const workerScript = join(root, "worker.py");
    await writeFile(assetPath, "fbx");
    await writeFile(workerScript, "# worker");
    await writeFile(
      executable,
      `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
request="$1"
response="$2"
capability=$(node -e 'const r=require(process.argv[1]); process.stdout.write(r.capability)' "$request")
node -e 'const fs=require("fs"); const r=require(process.argv[1]); fs.writeFileSync(r.scenePath,"scene"); fs.appendFileSync(process.argv[3], JSON.stringify(r)+"\\n"); fs.writeFileSync(process.argv[2],JSON.stringify({ok:true,capability:r.capability,value:{changed:true}}))' "$request" "$response" "${join(root, "requests.jsonl")}"
`,
    );
    await chmod(executable, 0o700);

    const layer = makeBlenderServiceLayer({ executable, workerScript, workspace: join(root, "workspace"), assetPath });
    await Effect.runPromise(
      Effect.gen(function* () {
        const blender = yield* BlenderService;
        yield* blender.executeCapability("material.set_base_color", { expected: [0, 0, 0, 1] });
        yield* blender.executeCapability("transform.scale_uniform", { expected: 2 });
      }).pipe(Effect.provide(layer)),
    );

    const requests = (await readFile(join(root, "requests.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { scenePath: string });
    expect(requests).toHaveLength(2);
    expect(requests[0].scenePath).toBe(requests[1].scenePath);
  });
});
