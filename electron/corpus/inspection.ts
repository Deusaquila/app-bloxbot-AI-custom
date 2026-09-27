import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import { Effect, Schema } from "effect";

import { AssetFingerprintSchema, type AssetFingerprint } from "../../src/types/asset";
import { runBlenderScript } from "../services/BlenderProcess";

const SUPPORTED_EXTENSIONS = [".fbx", ".blend"] as const;
type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export interface InspectCorpusAssetOptions {
  /** Stable corpus identity; this is copied into the production fingerprint's assetId. */
  assetId: string;
  /** Path to the immutable original asset. Inspection only reads this file. */
  sourcePath: string;
  blenderExecutable: string;
  /** Contents of the repository's existing electron/blender/v1_pipeline.py. */
  blenderScript: string;
  timeoutMs?: number;
}

export type CorpusInspectionOutcome =
  | {
      status: "INSPECTED";
      assetId: string;
      sourcePath: string;
      /** The source file extension, kept separate from the production fingerprint format. */
      sourceFormat: SupportedExtension;
      fingerprint: AssetFingerprint;
      /** SHA-256 of the exact Blender pipeline script used for inspection. */
      inspectorVersion: string;
      /** The existing inspect response omits Blender's version, so this remains explicitly unknown. */
      blenderVersion: null;
    }
  | {
      status: "UNSUPPORTED_FORMAT";
      assetId: string;
      sourcePath: string;
      extension: string;
      supportedExtensions: readonly SupportedExtension[];
    };

export class CorpusInspectionError extends Error {
  override name = "CorpusInspectionError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function supportedExtension(path: string): SupportedExtension | undefined {
  const extension = extname(path).toLowerCase();
  return SUPPORTED_EXTENSIONS.find((candidate) => candidate === extension);
}

async function removeInspectionDirectory(directory: string): Promise<void> {
  try {
    const [temporaryRoot, resolvedDirectory] = await Promise.all([
      realpath(tmpdir()),
      realpath(directory),
    ]);
    const relativeDirectory = relative(temporaryRoot, resolvedDirectory);
    if (
      !relativeDirectory ||
      isAbsolute(relativeDirectory) ||
      relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${sep}`) ||
      dirname(relativeDirectory) !== "." ||
      !basename(relativeDirectory).startsWith("bloxbot-corpus-inspection-")
    ) {
      return;
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
  } catch {
    // Cleanup must not replace the inspection result or its original failure.
  }
}

/**
 * Inspect a corpus file with the production Blender fingerprint pipeline, without creating a
 * Job or registering an Artifact. The only writes are unique request/response/script files in a
 * temporary directory; the source file is passed to Blender as a read-only input path.
 */
export async function inspectCorpusAsset(
  options: InspectCorpusAssetOptions,
): Promise<CorpusInspectionOutcome> {
  const extension = extname(options.sourcePath).toLowerCase();
  const sourceFormat = supportedExtension(options.sourcePath);
  if (!sourceFormat) {
    return {
      status: "UNSUPPORTED_FORMAT",
      assetId: options.assetId,
      sourcePath: options.sourcePath,
      extension: extension || "(none)",
      supportedExtensions: SUPPORTED_EXTENSIONS,
    };
  }

  if (!options.assetId.trim()) throw new CorpusInspectionError("Asset ID must not be empty");
  if (!options.blenderExecutable.trim())
    throw new CorpusInspectionError("Blender executable must not be empty");
  if (!options.blenderScript.trim()) throw new CorpusInspectionError("Blender script must not be empty");

  const directory = await mkdtemp(join(tmpdir(), "bloxbot-corpus-inspection-"));
  const requestPath = join(directory, `${randomUUID()}.request.json`);
  const responsePath = join(directory, `${randomUUID()}.response.json`);
  const scriptPath = join(directory, `${randomUUID()}.py`);

  try {
    await writeFile(
      requestPath,
      JSON.stringify({
        assetId: options.assetId,
        assetPath: options.sourcePath,
        scenePath: join(directory, "unused-inspection-scene.blend"),
        capability: "asset.inspect",
        input: {},
      }),
      { flag: "wx", mode: 0o600 },
    );

    await Effect.runPromise(
      runBlenderScript(
        {
          executable: options.blenderExecutable,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
        {
          script: options.blenderScript,
          scriptPath,
          args: [requestPath, responsePath],
        },
      ),
    );

    let rawFingerprint: unknown;
    try {
      rawFingerprint = JSON.parse(await readFile(responsePath, "utf8"));
    } catch (cause) {
      throw new CorpusInspectionError("Blender did not return a readable inspection response", {
        cause,
      });
    }

    let fingerprint: AssetFingerprint;
    try {
      fingerprint = Schema.decodeUnknownSync(AssetFingerprintSchema)(rawFingerprint);
    } catch (cause) {
      throw new CorpusInspectionError("Blender returned an invalid production asset fingerprint", {
        cause,
      });
    }

    return {
      status: "INSPECTED",
      assetId: options.assetId,
      sourcePath: options.sourcePath,
      sourceFormat,
      fingerprint,
      inspectorVersion: `sha256:${createHash("sha256").update(options.blenderScript).digest("hex")}`,
      blenderVersion: null,
    };
  } catch (cause) {
    if (cause instanceof CorpusInspectionError) throw cause;
    throw new CorpusInspectionError("Corpus asset inspection failed", { cause });
  } finally {
    await removeInspectionDirectory(directory);
  }
}
