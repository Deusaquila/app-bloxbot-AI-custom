# Corpus V1 headless usage

Corpus V1 ingests Poly Haven models into a separate evaluation datastore. It uses the production Blender fingerprint script and can run without Electron or a Roblox Studio connection. Assets obtained through the live API are credited to Poly Haven; the per-asset records preserve author, source URL, CC0 license, file URLs and hashes.

Use Node 22.12 or later within major version 22 and install the repository dependencies before running `pnpm corpus`. The current store uses Node's built-in SQLite API, which is marked experimental in Node 22.

## Commands

```text
pnpm corpus discover polyhaven --limit 5
pnpm corpus ingest polyhaven --limit 20 --blender "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
pnpm corpus inspect --pending
pnpm corpus status
pnpm corpus query --label meshCount=multi_mesh --label texture=textured
pnpm corpus retry --limit 20
pnpm corpus verify --status succeeded
```

Add `--root <workspace>` to choose a corpus workspace. Otherwise the CLI uses `BLOXBOT_WORKSPACE`, then `~/BloxBot`. The SQLite database is at `<workspace>/evaluation/evaluation.db`; original files are under `<workspace>/evaluation/corpus/raw`. Generated evaluation data is ignored by Git.

`discover` uses a deterministic, category-balanced selection before applying `--limit`. `ingest` requests the original 1k FBX package and all dependencies declared in Poly Haven's file manifest, verifies sizes and provider MD5 checksums, computes SHA-256, and records immutable raw files. A verified existing file is rehashed and reused. A mismatched existing final file is reported as a failure without overwriting it. A failed asset does not stop the batch.

`query` returns concise asset records, including the recorded `primaryPath` for an FBX. Run `verify` before handing it to the existing BloxBot asset input boundary; Corpus does not create a production Job. `verify` streams hashes from disk and reports missing or changed files and incomplete provenance, inspection or classification. The command exits unsuccessfully if verification finds issues. `--status succeeded` restricts verification to completed assets when a workspace also contains retryable failures.

The existing `pnpm v1 run` command accepts the returned `primaryPath` directly as `<asset.fbx>`. For example, in PowerShell:

```powershell
$asset = pnpm corpus query --status succeeded --limit 1 | ConvertFrom-Json | Select-Object -First 1
pnpm corpus verify --status succeeded
pnpm v1 run $asset.primaryPath <studio-id> <blender.exe> <creator-user-id>
```

The last command runs the production Job and needs its normal Studio and Open Cloud configuration. Corpus V1 acceptance verifies that the FBX package and input path are ready; it does not claim a Roblox run.

The inspection record includes the SHA-256 of its raw input and the SHA-256 of the exact production Blender script. A changed inspector script causes reinspection without redownloading a verified source file. A newly verified raw input hash also causes reinspection. The classification rules use a separate version. `null` labels mean the production fingerprint did not provide enough evidence to classify that property.

Source and API terms were checked on 2026-09-27: https://polyhaven.com/our-api, https://polyhaven.com/license and https://github.com/Poly-Haven/Public-API/blob/master/ToS.md. Poly Haven's CC0 asset license and live API credit/User-Agent requirements are separate obligations.
