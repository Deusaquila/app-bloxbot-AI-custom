const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { spawnSync } = require("node:child_process");
function findBlender() {
  const configured = process.env.BLOXBOT_TEST_BLENDER || process.env.BLOXBOT_BLENDER;
  if (configured) return existsSync(configured) ? configured : undefined;
  const root = "C:/Program Files/Blender Foundation";
  const candidates =
    process.platform === "win32" && existsSync(root)
      ? readdirSync(root)
          .sort()
          .reverse()
          .map((name) => join(root, name, "blender.exe"))
      : [];
  candidates.push("/Applications/Blender.app/Contents/MacOS/Blender", "/usr/bin/blender");
  return candidates.find((path) => existsSync(path));
}
function version(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}
module.exports = { findBlender, version };
if (require.main === module) {
  const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
  const blender = findBlender();
  const credential = join(homedir(), ".config/bloxbot/roblox-open-cloud-api-key");
  const keyReady =
    existsSync(credential) && statSync(credential).isFile() && statSync(credential).size > 0;
  const pnpm = (process.env.npm_config_user_agent || "").match(/pnpm\/([^ ]+)/)?.[1];
  const studio =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "@(Get-Process RobloxStudioBeta -ErrorAction SilentlyContinue).Count",
          ],
          { encoding: "utf8", timeout: 10000, windowsHide: true },
        )
      : null;
  const checks = {
    node22: process.versions.node.startsWith("22."),
    pnpmPinned: pkg.packageManager === `pnpm@${pnpm}`,
    blender: !!blender && !!version(blender),
    studioMcpLauncher: existsSync(join(process.env.LOCALAPPDATA || "", "Roblox/mcp.bat")),
    studioRunning: !!studio && Number(studio.stdout?.trim()) > 0,
    credentialFileNonEmpty: keyReady,
    git: !!version("git"),
  };
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        pnpm: pnpm || null,
        blender: blender ? version(blender) : null,
        checks,
        ghOptional: !!version("gh"),
      },
      null,
      2,
    ),
  );
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
}
