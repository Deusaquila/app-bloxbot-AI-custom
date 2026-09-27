import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Artifact } from "../../src/types/job";

export interface OpenCloudOptions {
  credentialPath: string;
  creator: { type: "user" | "group"; id: string };
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onOperation?: (path: string) => Promise<void>;
  onReceipt?: (receipt: OpenCloudReceipt) => Promise<void>;
}
export interface OpenCloudReceipt {
  artifactId?: string;
  sha256: string;
  bytes: number;
  operationPath: string;
  status: "SUCCEEDED";
  assetId: string;
  revisionId?: string;
  moderationState?: string;
}
export class OpenCloudError extends Error {
  readonly name = "OpenCloudError";
  constructor(
    readonly code:
      | "CREDENTIAL"
      | "INPUT"
      | "HTTP"
      | "TIMEOUT"
      | "NETWORK"
      | "RESPONSE"
      | "MODERATION"
      | "REMOTE",
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
type Operation = {
  path?: unknown;
  done?: unknown;
  error?: unknown;
  response?: {
    assetId?: unknown;
    revisionId?: unknown;
    moderationResult?: { moderationState?: unknown };
  };
};
const ORIGIN = "https://apis.roblox.com/assets/v1/";

/** Separate Open Cloud adapter. POST is never retried: its remote outcome may be ambiguous. */
export class RobloxOpenCloudAssetService {
  constructor(private readonly options: OpenCloudOptions) {}
  async upload(artifact: Pick<Artifact, "id" | "path" | "hash">): Promise<OpenCloudReceipt> {
    return this.uploadFile(artifact.path ?? "", artifact.hash, artifact.id);
  }
  async uploadFile(
    path: string,
    expectedHash?: string,
    artifactId?: string,
  ): Promise<OpenCloudReceipt> {
    const options = this.options;
    if (
      !/^[1-9][0-9]*$/.test(options.creator.id) ||
      !["user", "group"].includes(options.creator.type)
    )
      throw new OpenCloudError("INPUT", "Invalid Roblox creator");
    let bytes: Buffer;
    try {
      const size = (await stat(path)).size;
      if (!path.toLowerCase().endsWith(".fbx") || size === 0 || size > 20_000_000)
        throw new Error();
      bytes = await readFile(path);
      if (bytes.length !== size) throw new Error();
    } catch {
      throw new OpenCloudError("INPUT", "Expected a nonempty FBX at most 20 MB");
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expectedHash && expectedHash !== sha256)
      throw new OpenCloudError("INPUT", "Artifact hash changed before upload");
    const timeout = options.timeoutMs ?? 180_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000)
      throw new OpenCloudError("INPUT", "Invalid upload timeout");
    const signal = AbortSignal.timeout(timeout);
    const request = async (suffix: string, init: RequestInit = {}) => {
      // Read only at request time; never persist credentials or attach raw errors.
      let key: string;
      try {
        key = (await readFile(options.credentialPath, "utf8")).trim();
      } catch {
        throw new OpenCloudError("CREDENTIAL", "Open Cloud credential file is unavailable");
      }
      if (!key || /[\r\n]/.test(key))
        throw new OpenCloudError("CREDENTIAL", "Open Cloud credential file is invalid");
      try {
        return await (options.fetch ?? fetch)(ORIGIN + suffix, {
          ...init,
          headers: { "x-api-key": key },
          signal,
          redirect: "error",
        });
      } catch {
        throw new OpenCloudError(
          signal.aborted ? "TIMEOUT" : "NETWORK",
          signal.aborted
            ? "Open Cloud request timed out"
            : "Open Cloud transport failed; remote outcome may be unknown",
        );
      }
    };
    const decode = async (response: Response): Promise<Operation> => {
      if (!response.ok)
        throw new OpenCloudError(
          "HTTP",
          "Open Cloud request failed (HTTP " + response.status + ")",
          response.status,
        );
      let value: Operation;
      try {
        value = (await response.json()) as Operation;
      } catch {
        throw new OpenCloudError("RESPONSE", "Invalid Open Cloud response JSON");
      }
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value.done !== undefined && typeof value.done !== "boolean")
      )
        throw new OpenCloudError("RESPONSE", "Malformed Open Cloud operation");
      return value;
    };
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
    // The immutable in-memory snapshot is the exact content hashed above.
    form.set(
      "fileContent",
      new Blob([new Uint8Array(bytes)], { type: "model/fbx" }),
      basename(path),
    );
    let operation = await decode(await request("assets", { method: "POST", body: form }));
    const operationPath = operation.path;
    if (typeof operationPath !== "string" || !/^operations\/[a-zA-Z0-9-]+$/.test(operationPath))
      throw new OpenCloudError("RESPONSE", "Invalid Open Cloud operation path");
    await options.onOperation?.(operationPath);
    let failures = 0;
    while (operation.done !== true) {
      try {
        await delay(Math.max(1, Math.min(options.pollIntervalMs ?? 2000, 10_000)), undefined, {
          signal,
        });
      } catch {
        throw new OpenCloudError("TIMEOUT", "Open Cloud polling timed out");
      }
      try {
        operation = await decode(await request(operationPath));
        failures = 0;
      } catch (error) {
        if (
          error instanceof OpenCloudError &&
          (error.code === "NETWORK" ||
            (error.code === "HTTP" &&
              (error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500))) &&
          ++failures <= 3
        )
          continue;
        throw error;
      }
      if (operation.path !== undefined && operation.path !== operationPath)
        throw new OpenCloudError("RESPONSE", "Open Cloud operation path changed");
    }
    if (operation.error) throw new OpenCloudError("REMOTE", "Open Cloud operation failed");
    const response = operation.response;
    if (typeof response?.assetId !== "string" || !/^[1-9][0-9]*$/.test(response.assetId))
      throw new OpenCloudError("RESPONSE", "Open Cloud did not produce a valid asset ID");
    const state = response.moderationResult?.moderationState;
    const receipt: OpenCloudReceipt = {
      artifactId,
      sha256,
      bytes: bytes.length,
      operationPath,
      status: "SUCCEEDED",
      assetId: response.assetId,
      ...(typeof response.revisionId === "string" && /^[0-9]+$/.test(response.revisionId)
        ? { revisionId: response.revisionId }
        : {}),
      ...(typeof state === "string" && /^MODERATION_STATE_[A-Z_]+$/.test(state)
        ? { moderationState: state }
        : {}),
    };
    await options.onReceipt?.(receipt);
    if (receipt.moderationState && receipt.moderationState !== "MODERATION_STATE_APPROVED")
      throw new OpenCloudError("MODERATION", "Open Cloud asset is not approved for insertion");
    return receipt;
  }
}
