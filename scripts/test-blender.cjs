const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { findBlender, version } = require("./check-v1-environment.cjs");
const blender = findBlender();
if (!blender) {
  console.error("Real Blender is required. Set BLOXBOT_TEST_BLENDER to its executable.");
  process.exit(1);
}
console.log("Real Blender integration:", version(blender));
const result = spawnSync(
  process.execPath,
  [
    join(__dirname, "../node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.control.config.ts",
    "electron/services/BlenderIntegration.test.ts",
  ],
  { stdio: "inherit", windowsHide: true, env: { ...process.env, BLOXBOT_TEST_BLENDER: blender } },
);
process.exitCode = result.status ?? 1;
