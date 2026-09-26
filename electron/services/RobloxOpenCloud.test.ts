import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { RobloxOpenCloudAssetService, type OpenCloudReceipt } from "./RobloxOpenCloudAssetService";
import { uploadFbx } from "./RobloxOpenCloud";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bloxbot-cloud-"));
  directories.push(dir);
  await writeFile(join(dir, "test.fbx"), "fixture");
  await writeFile(join(dir, "credential"), "test-only-key");
  return { path: join(dir, "test.fbx"), credentialPath: join(dir, "credential") };
}
describe("Open Cloud transport", () => {
  it("uploads multipart data, checkpoints the operation, and polls only the pinned origin", async () => {
    const f = await fixture();
    const receipts: string[] = [];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ path: "operations/test-1", done: false }))
      .mockResolvedValueOnce(Response.json({ done: true, response: { assetId: "123" } }));
    expect(
      await uploadFbx(f.path, {
        credentialPath: f.credentialPath,
        creator: { type: "user", id: "42" },
        fetch: request,
        pollIntervalMs: 1,
        onOperation: async (path) => {
          receipts.push(path);
        },
      }),
    ).toBe("123");
    expect(receipts).toEqual(["operations/test-1"]);
    expect(request.mock.calls[1][0]).toBe("https://apis.roblox.com/assets/v1/operations/test-1");
    const form = request.mock.calls[0][1]!.body as FormData;
    expect(JSON.parse(form.get("request") as string).creationContext.creator).toEqual({
      userId: "42",
    });
  });
  it("never retries creation and excludes server bodies from errors", async () => {
    const f = await fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("sensitive body", { status: 403 }));
    await expect(
      uploadFbx(f.path, {
        credentialPath: f.credentialPath,
        creator: { type: "user", id: "42" },
        fetch: request,
      }),
    ).rejects.toThrow("HTTP 403");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects untrusted operation URLs before sending a credential to them", async () => {
    const f = await fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ path: "https://attacker.example/operations/1" }));
    await expect(
      uploadFbx(f.path, {
        credentialPath: f.credentialPath,
        creator: { type: "user", id: "42" },
        fetch: request,
      }),
    ).rejects.toThrow("operation path");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("Open Cloud failure and provenance boundaries", () => {
  it("rejects changed file content before any network request", async () => {
    const f = await fixture();
    const request = vi.fn<typeof fetch>();
    const service = new RobloxOpenCloudAssetService({
      credentialPath: f.credentialPath,
      creator: { type: "user", id: "42" },
      fetch: request,
    });
    await expect(
      service.upload({ id: "artifact", path: f.path, hash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "INPUT" });
    expect(request).not.toHaveBeenCalled();
  });
  it("retries transient polling and persists exact content provenance", async () => {
    const f = await fixture();
    const receipts: OpenCloudReceipt[] = [];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ path: "operations/test", done: false }))
      .mockResolvedValueOnce(new Response("private body", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          done: true,
          response: {
            assetId: "123",
            revisionId: "1",
            moderationResult: { moderationState: "MODERATION_STATE_APPROVED" },
          },
        }),
      );
    const service = new RobloxOpenCloudAssetService({
      credentialPath: f.credentialPath,
      creator: { type: "user", id: "42" },
      fetch: request,
      pollIntervalMs: 1,
      onReceipt: async (receipt) => {
        receipts.push(receipt);
      },
    });
    const result = await service.upload({
      id: "artifact",
      path: f.path,
      hash: createHash("sha256").update("fixture").digest("hex"),
    });
    expect(result).toMatchObject({
      artifactId: "artifact",
      bytes: 7,
      assetId: "123",
      revisionId: "1",
      status: "SUCCEEDED",
    });
    expect(receipts).toEqual([result]);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it.each(["true", 1, null])("rejects a malformed done value %s", async (done) => {
    const f = await fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ path: "operations/test", done, response: { assetId: "123" } }),
      );
    await expect(
      uploadFbx(f.path, {
        credentialPath: f.credentialPath,
        creator: { type: "user", id: "42" },
        fetch: request,
      }),
    ).rejects.toMatchObject({ code: "RESPONSE" });
  });
  it("retains a receipt but blocks moderated assets from insertion", async () => {
    const f = await fixture();
    const receipts: OpenCloudReceipt[] = [];
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          path: "operations/test",
          done: true,
          response: {
            assetId: "123",
            moderationResult: { moderationState: "MODERATION_STATE_REJECTED" },
          },
        }),
      );
    await expect(
      uploadFbx(f.path, {
        credentialPath: f.credentialPath,
        creator: { type: "user", id: "42" },
        fetch: request,
        onReceipt: async (receipt) => {
          receipts.push(receipt);
        },
      }),
    ).rejects.toMatchObject({ code: "MODERATION" });
    expect(receipts[0].assetId).toBe("123");
  });
  it("bounds polling by timeout", async () => {
    const f = await fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ path: "operations/test", done: false }));
    await expect(
      uploadFbx(f.path, {
        credentialPath: f.credentialPath,
        creator: { type: "user", id: "42" },
        fetch: request,
        timeoutMs: 20,
        pollIntervalMs: 5,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
