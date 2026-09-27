import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, link, mkdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { DEFAULT_CORPUS_USER_AGENT, type DownloadFileOption, type DownloadedArtifact } from "./source";

export const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

export interface DownloadExecutionOptions {
  /** Per-request timeout covering response headers and the streamed body. */
  timeoutMs?: number;
  /** Number of retries after the initial attempt. */
  retries?: number;
  /** Hard upper bound for a single response body. Defaults to 1 GiB. */
  maxBytes?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class CorpusDownloadError extends Error {
  override name = "CorpusDownloadError";
  readonly retryable: boolean;

  constructor(message: string, options?: ErrorOptions, retryable = true) {
    super(message, options);
    this.retryable = retryable;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function safeSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") return false;
  if (segment.endsWith(".") || segment.endsWith(" ")) return false;
  if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return false;
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
}

/** Validate a provider-supplied path before resolving it on either POSIX or Windows. */
export function assertSafeRelativePath(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\\")) {
    throw new CorpusDownloadError("Download path must be a non-empty relative POSIX path");
  }
  if (isAbsolute(value) || win32.isAbsolute(value) || value.startsWith("//") || /^[A-Za-z]:/.test(value)) {
    throw new CorpusDownloadError("Download path must be relative");
  }
  const segments = value.split("/");
  for (const segment of segments) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch (cause) {
      throw new CorpusDownloadError("Download path contains malformed URL encoding", { cause });
    }
    if (decoded.includes("/") || decoded.includes("\\") || !safeSegment(decoded)) {
      throw new CorpusDownloadError("Download path contains an unsafe path segment");
    }
  }
  return segments.join("/");
}

function safeUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("HTTPS URL required");
    return url;
  } catch (cause) {
    throw new CorpusDownloadError("Download URL must be a valid HTTPS URL", { cause });
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function ensureSafeParent(root: string, relativePath: string): Promise<string> {
  const parts = assertSafeRelativePath(relativePath).split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    const next = join(parent, part);
    const current = await lstatOrNull(next);
    if (current?.isSymbolicLink()) throw new CorpusDownloadError(`Refusing to write through symbolic link '${next}'`);
    if (current && !current.isDirectory()) throw new CorpusDownloadError(`Download directory '${next}' is not a directory`);
    if (!current) {
      try {
        await mkdir(next);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      const created = await lstat(next);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new CorpusDownloadError(`Download directory '${next}' is not a safe directory`);
      }
    }
    parent = next;
  }
  const target = resolve(parent, parts[parts.length - 1]);
  const relativeTarget = relative(root, target);
  if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new CorpusDownloadError("Resolved download path escaped its destination root");
  }
  return target;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

interface Digests {
  sha256: string;
  md5: string;
  byteSize: number;
}

async function hashExistingFile(path: string): Promise<Digests> {
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += buffer.length;
    sha256.update(buffer);
    md5.update(buffer);
  }
  return { sha256: sha256.digest("hex"), md5: md5.digest("hex"), byteSize };
}

class HashingLimitTransform extends Transform {
  private readonly sha256 = createHash("sha256");
  private readonly md5 = createHash("md5");
  private byteSize = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.byteSize += buffer.length;
    if (this.byteSize > this.maxBytes) {
      callback(new CorpusDownloadError(`Download exceeded the ${this.maxBytes}-byte limit`));
      return;
    }
    this.sha256.update(buffer);
    this.md5.update(buffer);
    callback(null, buffer);
  }

  digests(): Digests {
    return {
      sha256: this.sha256.digest("hex"),
      md5: this.md5.digest("hex"),
      byteSize: this.byteSize,
    };
  }
}

async function removePartialFile(path: string): Promise<void> {
  const file = await lstatOrNull(path);
  if (!file) return;
  if (file.isDirectory()) throw new CorpusDownloadError(`Refusing to remove partial download directory '${path}'`);
  await unlink(path);
}

function validateFileOption(option: DownloadFileOption, maxBytes: number): URL {
  if (!Number.isSafeInteger(option.size) || option.size < 0) {
    throw new CorpusDownloadError("Expected file size must be a non-negative safe integer");
  }
  if (option.size > maxBytes) {
    throw new CorpusDownloadError(`Expected file size ${option.size} exceeds the ${maxBytes}-byte limit`);
  }
  if (option.md5 !== null && !/^[a-f0-9]{32}$/i.test(option.md5)) {
    throw new CorpusDownloadError("Expected MD5 must contain 32 hexadecimal characters");
  }
  if (option.sha256 != null && !/^[a-f0-9]{64}$/i.test(option.sha256)) {
    throw new CorpusDownloadError("Expected SHA-256 must contain 64 hexadecimal characters");
  }
  return safeUrl(option.url);
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof CorpusDownloadError) || error.retryable;
}

async function verifyExisting(
  path: string,
  expectedSize: number,
  expectedMd5: string | null,
  expectedSha256: string | undefined,
): Promise<Digests | null> {
  const existing = await lstatOrNull(path);
  if (!existing) return null;
  if (existing.isSymbolicLink()) throw new CorpusDownloadError(`Refusing to overwrite symbolic link '${path}'`);
  if (!existing.isFile()) throw new CorpusDownloadError(`Existing download path '${path}' is not a regular file`);
  if (existing.size !== expectedSize) {
    throw new CorpusDownloadError(`Existing immutable file '${path}' has size ${existing.size}; expected ${expectedSize}`, undefined, false);
  }
  if (!expectedMd5 && !expectedSha256) {
    throw new CorpusDownloadError(`Existing immutable file '${path}' cannot be verified because no source checksum was supplied`, undefined, false);
  }
  const digest = await hashExistingFile(path);
  const sizeMatches = digest.byteSize === expectedSize;
  const checksumMatches = expectedMd5
    ? digest.md5.toLowerCase() === expectedMd5.toLowerCase()
    : expectedSha256
      ? digest.sha256.toLowerCase() === expectedSha256.toLowerCase()
      : false;
  if (!sizeMatches || !checksumMatches) {
    throw new CorpusDownloadError(`Existing immutable file '${path}' does not match the source checksum`, undefined, false);
  }
  return digest;
}

/** Stream one file to a sibling .part file and atomically publish it after verification. */
export async function download(
  option: DownloadFileOption,
  destinationRoot: string,
  options: DownloadExecutionOptions = {},
): Promise<DownloadedArtifact> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const retries = options.retries ?? 2;
  const userAgent = options.userAgent ?? DEFAULT_CORPUS_USER_AGENT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new CorpusDownloadError("maxBytes must be a positive integer");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new CorpusDownloadError("timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) throw new CorpusDownloadError("retries must be an integer from 0 through 5");
  if (!userAgent.trim()) throw new CorpusDownloadError("A unique User-Agent is required for Poly Haven downloads");
  const url = validateFileOption(option, maxBytes);
  const normalizedPath = assertSafeRelativePath(option.relativePath);
  if (normalizedPath.split("/").at(-1) !== option.filename) {
    throw new CorpusDownloadError("Download filename must match the final relative path segment", undefined, false);
  }

  await mkdir(destinationRoot, { recursive: true });
  const root = await realpath(destinationRoot);
  const targetPath = await ensureSafeParent(root, normalizedPath);
  const expectedSha256 = option.sha256 ?? undefined;
  const existing = await verifyExisting(targetPath, option.size, option.md5, expectedSha256);
  if (existing) {
    return {
      path: targetPath,
      filename: option.filename,
      format: option.format,
      sourceUrl: option.sourceUrl,
      sha256: existing.sha256,
      byteSize: existing.byteSize,
      downloadedAt: now().toISOString(),
      skippedExisting: true,
    };
  }

  const partPath = `${targetPath}.part`;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const priorPart = await lstatOrNull(partPath);
      if (priorPart?.isDirectory()) throw new CorpusDownloadError(`Refusing to write partial download directory '${partPath}'`);
      if (priorPart) await unlink(partPath);

      const response = await fetchImpl(url, {
        method: "GET",
        headers: { "User-Agent": userAgent },
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new CorpusDownloadError(
          `Download failed with HTTP ${response.status}`,
          retryableStatus ? { cause: new Error("retryable HTTP status") } : undefined,
          retryableStatus,
        );
      }
      if (!response.body) throw new CorpusDownloadError("Download response did not include a body");

      const hashing = new HashingLimitTransform(Math.min(maxBytes, option.size));
      const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
      await pipeline(body, hashing, createWriteStream(partPath, { flags: "wx" }));
      const digest = hashing.digests();
      if (digest.byteSize !== option.size) {
        throw new CorpusDownloadError(`Downloaded ${digest.byteSize} bytes; expected ${option.size}`);
      }
      if (option.md5 && digest.md5.toLowerCase() !== option.md5.toLowerCase()) {
        throw new CorpusDownloadError("Downloaded file did not match the source MD5 checksum");
      }
      if (expectedSha256 && digest.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
        throw new CorpusDownloadError("Downloaded file did not match the expected SHA-256 checksum");
      }

      let publishedDigest = digest;
      let skippedExisting = false;
      try {
        // link() creates the final name atomically and fails with EEXIST
        // instead of replacing an immutable artifact from a competing run.
        await link(partPath, targetPath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const concurrent = await verifyExisting(targetPath, option.size, option.md5, expectedSha256);
        if (!concurrent) throw new CorpusDownloadError(`Download target '${targetPath}' changed during finalization`, undefined, false);
        publishedDigest = concurrent;
        skippedExisting = true;
      }
      await unlink(partPath);
      return {
        path: targetPath,
        filename: option.filename,
        format: option.format,
        sourceUrl: option.sourceUrl,
        sha256: publishedDigest.sha256,
        byteSize: publishedDigest.byteSize,
        downloadedAt: now().toISOString(),
        skippedExisting,
      };
    } catch (error) {
      lastError = error;
      await removePartialFile(partPath).catch(() => undefined);
      if (attempt >= retries || !isRetryable(error)) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new CorpusDownloadError(
    `Unable to download '${option.filename}' after ${retries + 1} attempt${retries === 0 ? "" : "s"}`,
    { cause: lastError },
  );
}
