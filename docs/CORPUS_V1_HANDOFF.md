# Corpus V1 handoff — Poly Haven

## Scope and ownership

This work lives on `feature/corpus-v1-polyhaven` in a separate checkout. Corpus development began against BloxBot commit `788f350f598696fc2a5ca5d96f24a928ca637a40`. Before publication, the five Corpus commits were rebased onto the then-current GitHub `feature/v1-job-core` commit `a7118e9b6b21e4fbd2bc1e314eec81d73d608e02`, leaving only Corpus changes beyond that base. The production Job, Requirement IR, Roblox execution and V2 checkout were not changed by Corpus. The production lead coordinated three workstreams: the source/API and download adapter; the provider-neutral SQLite model; and the shared Blender inspection/verification boundary. The lead integrated the engine, CLI, classification, selection, tests and live acceptance.

The implementation sequence and release gates are in [CORPUS_V1_PLAN.md](CORPUS_V1_PLAN.md). Operational commands are in [CORPUS_V1_USAGE.md](CORPUS_V1_USAGE.md).

## Delivered boundary

- `electron/corpus/source.ts` defines the source adapter; `polyhaven.ts` implements live Poly Haven model discovery and the 1k FBX package manifest.
- `download.ts` streams bounded downloads to a `.part` file, checks size and provider checksum, computes SHA-256, and publishes a verified file without replacing an existing final path. Existing files are rehashed and reused.
- `domain.ts` and `store.ts` persist stable `(source, sourceAssetId)` identity, source and file provenance, CC0 rights checks, author, raw and derived artifact lineage, staged failures, inspection and classification versions in SQLite.
- `inspection.ts` uses the production `electron/blender/v1_pipeline.py` inspection command and production `AssetFingerprint` semantics without creating a Job. `classification.ts` creates deterministic, versioned technical labels and leaves unknown values as `null`.
- `engine.ts` isolates per-asset failures, bounds concurrency, retries stored failures, avoids repeated inspection when input and script hashes match, and exposes queries and status.
- `verify.ts` reads every recorded file and checks its bytes, SHA-256, provenance, license, lineage and inspection input. `scripts/corpus.cjs` exposes discover, ingest, retry, inspect, status, query and verify commands.

## Live validation on 2026-09-27

Using Node 22.23.3, Blender 5.2 and the official live Poly Haven API, the same local corpus was expanded in stages:

| Gate | Result | Verification |
| --- | --- | --- |
| 5 models | 5 ingested | 24 of 24 files verified; 0 issues |
| 20 models | 20 ingested | 111 of 111 files, 85,770,487 bytes verified; 0 issues |
| Restart at 20 | 20 of 20 reused | Same 20 assets and 111 artifacts; SHA-256 digests over inspection timestamps and raw file modification times unchanged |
| 50 models | 50 ingested | 317 of 317 files verified; 0 issues |
| 100 models | 100 ingested | 746 of 746 files, 808,074,121 bytes verified; 0 issues |

Final `status`: 100 total, 100 complete, 0 failed, 0 blocked, 0 pending, 100 with verified raw files, 100 with inspection records. The selection spans 15 top-level source categories. The versioned classification contains 5 rigged, 96 textured and 6 complex-geometry models, so technical subset queries return real results. `inspect --pending` reports 0.

The locked 20-model restart comparison used these digests before and after an independent CLI process reran `ingest polyhaven --limit 20`:

```text
inspectionDigest: b3dcec0300bebfe4660827df13de862dcebea14ab0b3330708bbcdfaf095058f
fileMtimeDigest: 1d957b213fcdcd1b3f5af2ee2aea35acf2625ef25ee5e525d35719bfe139223d
```

The corpus data is local, under `.local-evaluation/evaluation/`, and is excluded from Git. Recreate it in another checkout with:

```text
pnpm corpus ingest polyhaven --limit 100 --root .local-evaluation
pnpm corpus verify --root .local-evaluation
pnpm corpus status --root .local-evaluation
pnpm corpus query --status succeeded --label rig=rigged --root .local-evaluation
```

Run `query` to obtain a completed model's `primaryPath`. The existing `scripts/v1-job.cjs` takes that path directly as its `<asset.fbx>` argument. The FBX and manifest-declared textures remain together in the raw package. The local live validation ran the same production Blender inspector against all 100 FBX files. No Studio or Open Cloud Job was submitted in this acceptance run.

## Tests and operational limits

- TypeScript typechecks passed for the app, Electron and scripts configurations.
- Control suite: 128 passed, 11 skipped. App suite: 207 passed. Release suite: 8 passed.
- Live Poly Haven evidence is separate from mocked source, store, download, inspection and failure-isolation tests.
- Node 22's built-in SQLite API emits an experimental warning. The project already requires Node 22; this implementation was exercised with 22.23.3.
- V1 selects original 1k FBX packages from the source manifest. A source model without a suitable FBX is recorded as a failure for this route. No format conversion is claimed.
- The adapter observes Poly Haven's live API `User-Agent` and visible credit terms and records each asset's CC0 license, author and provenance. Current source references: https://polyhaven.com/our-api, https://polyhaven.com/license, https://github.com/Poly-Haven/Public-API/blob/master/ToS.md.

The next integration action is to consume `primaryPath` and `primarySha256` from a completed query result in the BloxBot processing run, then record Job and Roblox outcome evidence there. Corpus V1 is ready for that handoff; this branch should be reviewed independently before any merge.
