// Read-only live acceptance verification after restarting the application runtime.
require("sucrase/register/ts");
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { Effect } = require("effect");
const { makeV1Runtime } = require("../electron/services/V1Runtime.ts");
const { JobService } = require("../electron/services/JobService.ts");
const { StudioMcpBroker } = require("../electron/services/StudioMcpBroker.ts");
const {
  inspectionCode,
  readStudioJson,
  parseRobloxFingerprint,
} = require("../electron/services/RobloxServiceLive.ts");
const { hasCompletionEvidence } = require("../electron/control/completionEvidence.ts");
const { matchesColor, matchesScale } = require("../electron/services/V1JobRunner.ts");
async function main() {
  const [workspace, id] = process.argv.slice(2);
  if (!workspace || !id) throw Error("Usage: verify-v1-acceptance.cjs <workspace> <job-id>");
  const root = resolve(workspace);
  const before = JSON.parse(await fs.readFile(join(root, "control-plane.json"), "utf8")).jobs.find(
    (j) => j.id === id,
  );
  const rt = makeV1Runtime(root);
  try {
    const job = await rt.runPromise(Effect.flatMap(JobService, (j) => j.get(id)));
    if (!isDeepStrictEqual(before, job) || !hasCompletionEvidence(job) || job.state !== "COMPLETED")
      throw Error("Recovery evidence mismatch");
    const broker = await rt.runPromise(StudioMcpBroker);
    const asset = job.report.imported;
    const result = await rt.runPromise(
      broker.callTool("execute_luau", {
        studio_id: asset.studioId,
        datamodel_type: "Edit",
        code: inspectionCode(asset.instanceName),
      }),
    );
    const observed = parseRobloxFingerprint(readStudioJson(result));
    const baseline = job.evidence.find((e) => e.type === "baseline.inspection").value.baseline;
    if (
      !matchesColor(observed, [0, 0, 0, 1]) ||
      !matchesScale(baseline.dimensions, observed.dimensions, 2)
    )
      throw Error("Studio reinspection mismatch");
    const destination = join(root, "evidence", id);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(
      join(destination, "restart-verification.json"),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          jobId: id,
          state: job.state,
          persistedResultUnchanged: true,
          completionEvidenceValid: true,
          studio: asset,
          reinspection: observed,
        },
        null,
        2,
      ),
    );
    await fs.writeFile(join(destination, "completed-job.json"), JSON.stringify(job, null, 2));
    const contract = job.evidence.find((e) => e.type === "mcp.contract").value;
    await fs.writeFile(
      join(destination, "studio-contract.json"),
      JSON.stringify(contract, null, 2),
    );
    const view = readStudioJson(
      await rt.runPromise(
        broker.callTool("execute_luau", {
          studio_id: asset.studioId,
          datamodel_type: "Edit",
          code: `local r=workspace:FindFirstChild("${asset.instanceName}") assert(r) local cf,s=r:GetBoundingBox() local d=math.max(s.X,s.Y,s.Z)*2 return game:GetService("HttpService"):JSONEncode({center={cf.X,cf.Y,cf.Z},camera={cf.X+d,cf.Y+d*0.6,cf.Z+d}})`,
        }),
      ),
    );
    const shot = await rt.runPromise(
      broker.callTool("screen_capture", {
        studio_id: asset.studioId,
        capture_id: "BloxBot_V1_Acceptance",
        camera_position: view.camera,
        look_at_position: view.center,
      }),
    );
    let screenshotSaved = false;
    for (const c of shot.content)
      if (c.type === "image") {
        await fs.writeFile(
          join(destination, "horse-studio." + (c.mimeType === "image/png" ? "png" : "jpg")),
          Buffer.from(c.data, "base64"),
        );
        screenshotSaved = true;
      }
    console.log(
      JSON.stringify({
        jobId: id,
        state: job.state,
        restartVerified: true,
        dimensions: observed.dimensions,
        screenshotSaved,
        evidenceDirectory: destination,
        screenshotNotes: shot.content.filter((c) => c.type === "text").map((c) => c.text),
      }),
    );
  } finally {
    await rt.dispose();
  }
}
main().catch(() => {
  console.error("Acceptance evidence verification failed");
  process.exitCode = 1;
});
