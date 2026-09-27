// Headless Corpus V1 CLI. Generated asset data lives in a dedicated evaluation root.
require("sucrase/register/ts");
const { readFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");
const { CorpusEngine } = require("../electron/corpus/engine.ts");
const { PolyHavenSource } = require("../electron/corpus/polyhaven.ts");
const { CorpusStore } = require("../electron/corpus/store.ts");
const { verifyCorpus } = require("../electron/corpus/verify.ts");

const CREDIT = "Assets from Poly Haven (CC0) — https://polyhaven.com";
const USAGE = [
  "Usage: pnpm corpus <command> [polyhaven] [options]",
  "Commands: discover, ingest, retry, inspect --pending, status, query, verify",
  "Options: --limit N, --root PATH, --blender PATH, --label key=value, --status STATUS",
].join("\n");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error(USAGE);
  const options = { command, source: null, labels: {} };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "polyhaven") options.source = item;
    else if (item === "--pending") options.pending = true;
    else if (["--limit", "--root", "--blender", "--label", "--status"].includes(item)) {
      const value = rest[++index];
      if (!value) throw new Error(`Missing value for ${item}\n${USAGE}`);
      if (item === "--limit") {
        options.limit = Number(value);
        if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 10000)
          throw new Error("--limit must be an integer from 1 through 10000");
      } else if (item === "--root") options.root = resolve(value);
      else if (item === "--blender") options.blender = resolve(value);
      else if (item === "--status") options.status = value;
      else {
        const equal = value.indexOf("=");
        if (equal < 1) throw new Error("--label must use key=value");
        const key = value.slice(0, equal);
        const raw = value.slice(equal + 1);
        options.labels[key] = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
      }
    } else throw new Error(`Unknown argument: ${item}\n${USAGE}`);
  }
  return options;
}

function defaultBlender() {
  const candidates = [
    process.env.BLOXBOT_BLENDER_EXECUTABLE,
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

function summarizeAsset(asset, store) {
  const primary = store.listArtifacts(asset).filter((file) => file.kind === "raw" && file.format === "fbx").at(-1);
  return {
    source: asset.source,
    sourceAssetId: asset.sourceAssetId,
    name: asset.name,
    author: asset.author,
    category: asset.providerCategories?.join("/") || null,
    sourceUrl: asset.sourceUrl,
    license: asset.license.id,
    status: asset.status,
    stage: asset.stage,
    primaryPath: primary?.path || null,
    primarySha256: primary?.sha256 || null,
    inspectedAt: asset.inspection?.inspectedAt || null,
    inspectorVersion: asset.inspection?.inspectorVersion || null,
    technicalClassification: asset.classification?.labels || null,
    failure: asset.failure,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = args.root || process.env.BLOXBOT_WORKSPACE || join(homedir(), "BloxBot");
  const evaluationRoot = join(workspace, "evaluation");
  const store = new CorpusStore(join(evaluationRoot, "evaluation.db"));
  const blenderScript = await readFile(join(__dirname, "../electron/blender/v1_pipeline.py"), "utf8");
  const engine = new CorpusEngine({
    store,
    source: new PolyHavenSource(),
    evaluationRoot,
    blenderExecutable: args.blender || defaultBlender(),
    blenderScript,
  });
  try {
    let output;
    switch (args.command) {
      case "discover":
        if (args.source !== "polyhaven") throw new Error(USAGE);
        output = { sourceCredit: CREDIT, assets: (await engine.discover(args.limit || 20)).map((asset) => summarizeAsset(asset, store)) };
        break;
      case "ingest":
        if (args.source !== "polyhaven") throw new Error(USAGE);
        if (!(args.blender || defaultBlender())) throw new Error("Blender executable is required for ingestion");
        output = { sourceCredit: CREDIT, result: await engine.ingest(args.limit || 20) };
        output.result.assets = output.result.assets.map((asset) => summarizeAsset(asset, store));
        if (output.result.failed) process.exitCode = 1;
        break;
      case "retry":
        if (!(args.blender || defaultBlender())) throw new Error("Blender executable is required for retry");
        output = { sourceCredit: CREDIT, result: await engine.retry(args.limit || 20) };
        output.result.assets = output.result.assets.map((asset) => summarizeAsset(asset, store));
        if (output.result.failed) process.exitCode = 1;
        break;
      case "inspect":
        if (!args.pending) throw new Error(USAGE);
        if (!(args.blender || defaultBlender())) throw new Error("Blender executable is required for inspection");
        output = { result: await engine.inspectPending(args.limit || 100) };
        output.result.assets = output.result.assets.map((asset) => summarizeAsset(asset, store));
        if (output.result.failed) process.exitCode = 1;
        break;
      case "status":
        output = engine.status();
        break;
      case "query":
        output = engine.query({
          limit: args.limit || 100,
          ...(args.status ? { status: args.status } : {}),
          ...(Object.keys(args.labels).length ? { classificationLabels: args.labels } : {}),
        }).map((asset) => summarizeAsset(asset, store));
        break;
      case "verify":
        output = await verifyCorpus(store, args.status ? { status: args.status } : undefined);
        if (output.issues?.length) process.exitCode = 1;
        break;
      default:
        throw new Error(USAGE);
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
