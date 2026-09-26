# V1 local smoke test

Read WINDOWS_V1_ENVIRONMENT.md first. The locked scenario is the supplied horse FBX
and `Gör den svart och dubbelt så stor.`. Upload/import success alone is not success.

```powershell
pnpm typecheck
pnpm test
pnpm test:blender
pnpm check:v1-environment
node scripts/inspect-studio-contract.cjs
$env:BLOXBOT_WORKSPACE = 'C:\Users\JM\BloxBot-v1-acceptance'
pnpm v1 run 'C:\path\horse.fbx' '<explicit-discovered-studio-id>' 'C:\Program Files\Blender Foundation\Blender 4.2\blender.exe' '4974439157'
```

`test:blender` requires a real Blender executable and fails if none is found; the
ordinary test suite may skip this external integration when not configured.

The run uploads two models (source reference and transformed FBX) and retains them
in the selected disposable place. The output material is projected from verified
Blender evidence because the live Open Cloud importer dropped FBX diffuse color.
This operation is recorded and followed by independent Studio reinspection.

Inspect the persisted control-plane.json: Gate 1 must pass before export, Gate 2
must pass after exact-instance inspection, every mandatory requirement must pass,
and only then may state be COMPLETED. Every operation must have a durable result;
artifacts must have hashes and lineage, uploads must have receipts, and Studio
operations must identify the selected instance and unique imported model name.

Restart and reinspect a completed run without uploading again:

```powershell
node scripts/verify-v1-acceptance.cjs 'C:\Users\JM\BloxBot-v1-acceptance' '<completed-job-id>'
```

Retain its evidence directory and the job's Blender logs/artifacts. A failed run
must remain failed; inspect receipts before rerunning to avoid ambiguous duplicate
uploads. Restart does not automatically resume interrupted work.

Desktop path: build/start BloxBot, select Studio, choose Asset job, pick the FBX,
enter creator ID, and run. Its Job list shows persisted state and requirement counts.
The confirmed real acceptance was executed through the CLI application-service path;
see V1_INTEGRATION.md for measured results and remaining UI validation limitations.

Keep PR #1 in draft and do not merge into main.
