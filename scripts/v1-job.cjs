// Repository CLI. Credentials remain in the external file and are never command-line values.
require("sucrase/register/ts");
const { readFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { homedir } = require("node:os");
const { makeV1Runtime } = require("../electron/services/V1Runtime.ts");
const { runV1Job } = require("../electron/services/V1JobRunner.ts");
const { JobService } = require("../electron/services/JobService.ts");
const { Effect } = require("effect");
async function main() {
  const [command, sourcePath, studioId, blenderExecutable, creatorId] = process.argv.slice(2);
  if (
    command !== "list" &&
    (command !== "run" || !sourcePath || !studioId || !blenderExecutable || !creatorId)
  ) {
    throw new Error(
      "Usage: pnpm v1 list OR pnpm v1 run <asset.fbx> <studio-id> <blender.exe> <creator-user-id>",
    );
  }
  const runtime = makeV1Runtime(process.env.BLOXBOT_WORKSPACE || join(homedir(), "BloxBot"));
  try {
    if (command === "list") {
      console.log(
        JSON.stringify(
          await runtime.runPromise(Effect.flatMap(JobService, (jobs) => jobs.list)),
          null,
          2,
        ),
      );
    } else {
      const job = await runtime.runPromise(
        runV1Job(
          {
            sourcePath: resolve(sourcePath),
            studioId,
            prompt: "Gör den svart och dubbelt så stor.",
          },
          {
            blenderExecutable,
            blenderScript: await readFile(
              join(__dirname, "../electron/blender/v1_pipeline.py"),
              "utf8",
            ),
            openCloud: {
              credentialPath: join(homedir(), ".config/bloxbot/roblox-open-cloud-api-key"),
              creator: { type: "user", id: creatorId },
            },
          },
        ),
      );
      console.log(JSON.stringify({ id: job.id, state: job.state, report: job.report }, null, 2));
      if (job.state !== "COMPLETED") process.exitCode = 1;
    }
  } finally {
    await runtime.dispose();
  }
}
main().catch(() => {
  console.error("V1 could not start. Check paths, Studio connection, and configuration.");
  process.exitCode = 1;
});
