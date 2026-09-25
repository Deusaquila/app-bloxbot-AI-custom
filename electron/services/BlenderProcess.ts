import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Data, Effect } from "effect";

export class BlenderProcessError extends Data.TaggedError("BlenderProcessError")<{
  message: string;
  exitCode?: number;
  stderr?: string;
  cause?: unknown;
}> {}

export interface BlenderProcessOptions {
  executable: string;
  timeoutMs?: number;
}

export interface BlenderScriptInput {
  script: string;
  scriptPath: string;
  args?: readonly string[];
}

export interface BlenderProcessResult {
  stdout: string;
  stderr: string;
}

export function runBlenderScript(options: BlenderProcessOptions, input: BlenderScriptInput) {
  return Effect.tryPromise({
    try: async (): Promise<BlenderProcessResult> => {
      await mkdir(dirname(input.scriptPath), { recursive: true });
      await writeFile(input.scriptPath, input.script, { mode: 0o600 });
      return await new Promise((resolve, reject) => {
        const child = spawn(
          options.executable,
          ["--background", "--factory-startup", "--python", input.scriptPath, "--", ...(input.args ?? [])],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error("Blender process timed out"));
        }, options.timeoutMs ?? 120_000);
        child.once("error", (cause) => {
          clearTimeout(timeout);
          reject(cause);
        });
        child.once("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) resolve({ stdout, stderr });
          else reject(new BlenderProcessError({ message: "Blender exited unsuccessfully", exitCode: code ?? undefined, stderr }));
        });
      });
    },
    catch: (cause) =>
      cause instanceof BlenderProcessError
        ? cause
        : new BlenderProcessError({ message: "Failed to execute Blender", cause }),
  });
}
