# Corpus V1 implementation plan

## Purpose and boundary

Build a headless, reproducible Poly Haven 3D asset corpus for BloxBot. The corpus owns discovery, downloads, provenance, immutable raw files, inspection records, technical classification, queries, and retry state. The production Job pipeline, Requirement IR, Roblox execution, and production Asset Inspector contracts remain owned by the concurrent BloxBot work.

Corpus development began on `feature/corpus-v1-polyhaven` in a separate checkout, based on committed BloxBot revision `788f350f598696fc2a5ca5d96f24a928ca637a40`. Before publication, the five Corpus commits were rebased onto the then-current GitHub `feature/v1-job-core` revision `a7118e9b6b21e4fbd2bc1e314eec81d73d608e02`; the published branch therefore contains only Corpus changes beyond that remote base. Any later production contract update requires a deliberate comparison. Do not merge this branch to main as part of Corpus V1.

## Sequence and release gates

| Step | Owner | Deliverable | Gate |
| --- | --- | --- | --- |
| 1. Baseline and contracts | Production lead | Repository audit, fixed base revision, inspection/CLI contract map | Corpus checkout is isolated and clean; shared types are identified |
| 2. Source verification | Poly Haven research agent | Official API, format, license and usage evidence | Adapter design reflects current official documentation and small live probes where permitted |
| 3. Corpus foundation | Corpus engine agent | Provider-neutral types, SQLite state, raw/derived layout, source identity, provenance and license policy | Restart preserves assets and rejects disallowed licenses |
| 4. Ingestion | Source and download agent | Poly Haven adapter, bounded streaming download, hash, deduplication, retries, atomic finalization and resume | Interrupted and duplicate runs do not corrupt or redownload valid raw files |
| 5. Inspection and classification | Inspection agent | Compatibility adapter to existing Blender fingerprint semantics, versioned deterministic rules | Unknown values stay unknown; changed inspector version triggers reinspection only |
| 6. Headless access | Corpus engine agent | CLI and programmatic discover, ingest, inspect, status, query and verify operations | Another process can list and hand off usable asset paths without manual file surgery |
| 7. Progressive validation | Production lead | Mocked tests, then live batches of 5, 20, 50 and 100+ where time, network and disk permit | The 20 asset restart acceptance is demonstrated before calling V1 complete |
| 8. Handoff | Production lead | Architecture, commits, tests, live evidence, statistics, limitations and integration instructions | Acceptance evidence is complete; stop before V2 |

## Work allocation and coordination

- The production lead owns the plan, shared-contract decisions, integration, test evidence and final handoff.
- Agents work only in assigned Corpus modules. They must not edit production pipeline files or the concurrent V2 checkout.
- Any shared-contract gap is recorded first; prefer a narrow Corpus adapter. If a production contract change is unavoidable, isolate and document it in its own commit.
- Commit coherent increments and keep raw assets, credentials, generated databases and downloaded files out of Git.

## Data and safety invariants

- Logical identity is `(source, sourceAssetId)`; filenames are artifact metadata, never identity.
- License is stored per asset and checked against an explicit allowlist, initially CC0.
- Each immutable raw artifact has a cryptographic hash and source provenance. Derived artifacts retain parent hash and conversion version.
- A download is final only after streamed hashing and atomic rename. Incomplete files are recoverable and cannot appear as verified assets.
- Batch failures record stage, class, message, count and time without stopping other assets.
- Provider categories and deterministic technical labels are stored separately. Classification and inspection versions are persisted.

## Verified Poly Haven V1 source choice

The current official API lists models through `GET /assets?type=models` and per-model file manifests through `GET /files/{id}`. A live manifest probe for `dirty_football` exposed 1k FBX plus an `include` map for texture dependencies. V1 prefers an original 1k FBX and downloads its declared dependencies into the raw package. Every declared file is hashed and attributed separately; the FBX remains the primary artifact for the existing BloxBot inspector. Models without an acceptable FBX option are recorded as unsupported for this V1 path.

Poly Haven says its assets are CC0. Its current live API terms separately require a distinctive `User-Agent` and clear Poly Haven credit to users of an API-backed product. The source adapter must satisfy those service conditions and persist the source/license URLs and attribution. References checked 2026-09-27: https://polyhaven.com/our-api and https://polyhaven.com/license.

## Acceptance evidence

Starting with an empty corpus, select and ingest 20 diverse Poly Haven models, download and hash them, store provenance/license, inspect and classify them, then restart the process. Show that all 20 logical assets remain, verified downloads are skipped, inspection persists, technical subset queries work, originals are immutable, every asset has provenance and hash, failures are isolated, reruns are idempotent, and several asset paths can be passed to the current BloxBot processing boundary directly. Record actual commands and results; do not label mocked tests as live Poly Haven evidence.
