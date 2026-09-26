import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
