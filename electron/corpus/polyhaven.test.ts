import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CorpusDownloadError, download } from "./download";
import { PolyHavenSource } from "./polyhaven";
import type { DownloadFileOption } from "./source";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bloxbot-polyhaven-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const relativeDirectory = relative(resolve(tmpdir()), resolve(directory));
    if (
      relativeDirectory === "" ||
      relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${sep}`) ||
      resolve(directory) === resolve(tmpdir())
    ) {
      throw new Error(`Refusing to remove unsafe test directory '${directory}'`);
    }
    await rm(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetcher(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("User-Agent") });
    const key = new URL(url).pathname + new URL(url).search;
    if (!(key in routes)) return responseJson({ error: "not found" }, 404);
    return responseJson(routes[key]);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function fileOption(overrides: Partial<DownloadFileOption> = {}): DownloadFileOption {
  return {
    url: "https://dl.polyhaven.org/file/test/small.fbx",
    relativePath: "small.fbx",
    filename: "small.fbx",
    format: "fbx",
    size: 5,
    md5: createHash("md5").update("hello").digest("hex"),
    sourceUrl: "https://dl.polyhaven.org/file/test/small.fbx",
    role: "primary",
    ...overrides,
  };
}

describe("Poly Haven source", () => {
  it("discovers the full model list with canonical category, author, CC0, and a unique user agent", async () => {
    const { fetchImpl, calls } = mockFetcher({
      "/assets?type=models": {
        zed: { name: "Zed", type: 2, category: "Props/Tools", authors: { "Zed Artist": "All" }, tags: ["tool"] },
        alpha: { name: "Alpha", type: 2, category: "Nature/Plants", authors: { "A Artist": "Model" } },
        texture: { name: "Texture", type: 1, category: "Materials" },
        invalid: null,
      },
    });
    const source = new PolyHavenSource({ fetchImpl, userAgent: "BloxBotCorpusV1/test" });

    const discovered = await source.discover();

    expect(discovered.map((asset) => asset.sourceAssetId)).toEqual(["alpha", "zed"]);
    expect(discovered[0]).toMatchObject({
      source: "polyhaven",
      name: "Alpha",
      author: "A Artist",
      attribution: "Poly Haven",
      providerCategories: ["Nature", "Plants"],
      license: {
        id: "CC0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        redistributionAllowed: true,
        commercialUseAllowed: true,
      },
    });
    expect(calls[0]).toEqual({
      url: "https://api.polyhaven.com/assets?type=models",
      userAgent: "BloxBotCorpusV1/test",
    });
  });

  it("selects FBX 1k and preserves included textures as safe relative dependencies", async () => {
    const { fetchImpl } = mockFetcher({
      "/files/dirty_football": {
        fbx: {
          "1k": {
            fbx: {
              url: "https://dl.polyhaven.org/file/ph-assets/Models/fbx/1k/dirty_football/dirty_football_1k.fbx",
              size: 2048,
              md5: "a".repeat(32),
              include: {
                "textures/dirty_football_diff_1k.jpg": {
                  url: "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/dirty_football/dirty_football_diff_1k.jpg",
                  size: 1024,
                  md5: "b".repeat(32),
                },
              },
            },
          },
        },
        blend: {
          "1k": {
            blend: {
              url: "https://dl.polyhaven.org/file/ph-assets/Models/blend/1k/dirty_football/dirty_football_1k.blend",
              size: 4096,
              md5: "c".repeat(32),
              include: {},
            },
          },
        },
      },
    });
    const source = new PolyHavenSource({ fetchImpl });

    const options = await source.getDownloadOptions("dirty_football");

    expect(options.primary).toMatchObject({
      filename: "dirty_football_1k.fbx",
      format: "fbx",
      size: 2048,
      relativePath: "dirty_football_1k.fbx",
      role: "primary",
    });
    expect(options.dependencies).toEqual([
      expect.objectContaining({
        filename: "dirty_football_diff_1k.jpg",
        relativePath: "textures/dirty_football_diff_1k.jpg",
        format: "jpg",
        role: "dependency",
      }),
    ]);
    expect(options.alternatives).toHaveLength(1);
    expect(options.alternatives[0].primary.relativePath).toBe("alternatives/blend/dirty_football_1k.blend");
    expect(options.alternatives[0].dependencies).toEqual([]);
  });

  it("rejects unsafe dependency paths before returning a package", async () => {
    const { fetchImpl } = mockFetcher({
      "/files/unsafe": {
        fbx: {
          "1k": {
            fbx: {
              url: "https://dl.polyhaven.org/file/unsafe.fbx",
              size: 1,
              md5: "a".repeat(32),
              include: {
                "../../outside.png": {
                  url: "https://dl.polyhaven.org/file/outside.png",
                  size: 1,
                  md5: "a".repeat(32),
                },
              },
            },
          },
        },
      },
    });

    await expect(new PolyHavenSource({ fetchImpl }).getDownloadOptions("unsafe")).rejects.toThrow(/unsafe path/i);
  });
});

describe("streamed corpus downloads", () => {
  it("streams to a verified file and returns SHA-256 without leaving a partial file", async () => {
    const bytes = Buffer.from("hello");
    const fetchImpl = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
    const root = await temporaryDirectory();
    const output = await download(fileOption(), root, { fetchImpl, retries: 0 });

    expect(await readFile(output.path)).toEqual(bytes);
    expect(output).toMatchObject({
      filename: "small.fbx",
      format: "fbx",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.length,
      skippedExisting: false,
    });
    await expect(stat(`${output.path}.part`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a transient server response before publishing the verified file", async () => {
    const bytes = Buffer.from("hello");
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts === 1 ? new Response("temporarily unavailable", { status: 503 }) : new Response(bytes);
    }) as unknown as typeof fetch;
    const root = await temporaryDirectory();

    const output = await download(fileOption(), root, { fetchImpl, retries: 1 });

    expect(output.skippedExisting).toBe(false);
    expect(await readFile(output.path)).toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts a response that exceeds the declared file size and removes its partial file", async () => {
    const root = await temporaryDirectory();
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("too big"))) as unknown as typeof fetch;

    await expect(download(fileOption(), root, { fetchImpl, retries: 0 })).rejects.toThrow(/unable to download/i);
    await expect(stat(join(root, "small.fbx"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "small.fbx.part"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts an API request when the configured timeout expires", async () => {
    const root = await temporaryDirectory();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    ) as unknown as typeof fetch;

    await expect(download(fileOption(), root, { fetchImpl, timeoutMs: 5, retries: 0 })).rejects.toThrow(/unable to download/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips an existing file only after size and source MD5 verify", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "small.fbx");
    await writeFile(path, "hello");
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const output = await download(fileOption(), root, { fetchImpl, retries: 0 });

    expect(output.skippedExisting).toBe(true);
    expect(output.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when a pre-existing immutable file fails verification", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "small.fbx"), "wrong");
    const fetchImpl = vi.fn(async () => new Response(Buffer.from("hello"))) as unknown as typeof fetch;

    await expect(download(fileOption(), root, { fetchImpl, retries: 0 })).rejects.toThrow(/existing immutable file/i);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(join(root, "small.fbx"), "utf8")).toBe("wrong");
  });

  it("rejects traversal paths before issuing a request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const root = await temporaryDirectory();

    await expect(download(fileOption({ relativePath: "../escape.fbx" }), root, { fetchImpl, retries: 0 })).rejects.toBeInstanceOf(
      CorpusDownloadError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
