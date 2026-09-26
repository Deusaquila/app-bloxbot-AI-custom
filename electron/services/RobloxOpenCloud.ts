import { openAsBlob } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
export interface OpenCloudOptions {
  credentialPath: string;
  creator: { type: "user" | "group"; id: string };
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onOperation?: (path: string) => Promise<void>;
}
/** Never retry creation: a lost POST response has an ambiguous remote outcome. */
export async function uploadFbx(path: string, options: OpenCloudOptions): Promise<string> {
  if (!/^[1-9][0-9]*$/.test(options.creator.id)) throw new Error("Invalid Roblox creator ID");
  const size = (await stat(path)).size;
  if (!path.toLowerCase().endsWith(".fbx") || size === 0 || size > 100 * 1024 * 1024)
    throw new Error("Expected a nonempty FBX smaller than 100 MiB");
  const key = (await readFile(options.credentialPath, "utf8")).trim();
  if (!key) throw new Error("Open Cloud credential file is empty");
  const request = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 180_000);
  const headers = { "x-api-key": key };
  const form = new FormData();
  form.set(
    "request",
    JSON.stringify({
      assetType: "Model",
      displayName: "BloxBot V1 asset",
      description: "Deterministic BloxBot V1 pipeline output",
      creationContext: {
        creator: { [options.creator.type === "user" ? "userId" : "groupId"]: options.creator.id },
      },
    }),
  );
  form.set("fileContent", await openAsBlob(path, { type: "model/fbx" }), basename(path));
  const created = await request("https://apis.roblox.com/assets/v1/assets", {
    method: "POST",
    headers,
    body: form,
    signal,
    redirect: "error",
  });
  if (!created.ok)
    throw new Error("Open Cloud asset creation failed (HTTP " + created.status + ")");
  let operation = (await created.json()) as {
    path?: string;
    done?: boolean;
    error?: unknown;
    response?: { assetId?: string };
  };
  const operationPath = operation.path;
  if (!operationPath || !/^operations\/[a-zA-Z0-9-]+$/.test(operationPath))
    throw new Error("Invalid Open Cloud operation path");
  await options.onOperation?.(operationPath);
  while (!operation.done) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("Open Cloud polling timed out"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, options.pollIntervalMs ?? 2000);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    const response = await request("https://apis.roblox.com/assets/v1/" + operationPath, {
      headers,
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Open Cloud polling failed (HTTP " + response.status + ")");
    operation = (await response.json()) as typeof operation;
  }
  if (
    operation.error ||
    !operation.response?.assetId ||
    !/^[1-9][0-9]*$/.test(operation.response.assetId)
  )
    throw new Error("Open Cloud did not produce a valid asset ID");
  return operation.response.assetId;
}
