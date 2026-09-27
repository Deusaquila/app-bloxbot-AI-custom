// Export a compact, local measurement from an existing persisted Job. No Job is resumed.
require("sucrase/register/ts");
const { readFile, mkdir, writeFile, rename, rm } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { Schema } = require("effect");
const { JobSchema } = require("../src/types/job.ts");
const { makeBenchmarkObservation } = require("../electron/control/BenchmarkObservation.ts");

async function main() {
  const [workspace, jobId, caseId] = process.argv.slice(2);
  if (!workspace || !/^[a-f0-9-]{36}$/i.test(jobId ?? ""))
    throw new Error("Usage: pnpm benchmark:export <workspace> <job-uuid> [case-id]");
  if (caseId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(caseId))
    throw new Error("Case ID must use lowercase letters, numbers, underscores or hyphens");
  const root = resolve(workspace);
  const snapshot = JSON.parse(await readFile(join(root, "control-plane.json"), "utf8"));
  const candidate = snapshot.jobs?.find((job) => job.id === jobId);
  if (!candidate) throw new Error("Job was not found in the persisted workspace");
  const job = Schema.decodeUnknownSync(JobSchema)(candidate);
  const observation = makeBenchmarkObservation(job, { caseId });
  const directory = join(root, "evaluations");
  const destination = join(directory, `${jobId}-v1.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(observation, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  console.log(JSON.stringify({ jobId, destination, transfer: observation.transfer, promptResult: observation.promptResult.mandatory }));
}

main().catch(() => {
  console.error("Benchmark observation export failed; inspect the workspace and job ID");
  process.exitCode = 1;
});
