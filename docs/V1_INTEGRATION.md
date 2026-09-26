# V1 integration status and acceptance run

## Implemented

The V1 job path now runs inspection, deterministic compilation, a validated DAG,
Gate 1, export, Open Cloud upload, explicitly targeted Studio import/inspection,
Gate 2 and objective requirement evaluation. The supported prompt is
`Gör den svart och dubbelt så stor.` (with equivalent explicit English forms).
Unsupported or partially understood instructions fail rather than being guessed.

Each job snapshots its FBX input, saves derived Blender scenes, hashes artifacts,
and persists operations, evidence, requirements and reports in
`~/BloxBot/control-plane.json`. This is separate from legacy chat settings.
Existing version-1 snapshots remain readable. Interrupted jobs become failed or
cancelled on startup; uploads/imports are not replayed automatically. Saved upload
operation paths and import intents support inspecting uncertain remote outcomes.
Run only one controller (desktop or CLI) against a workspace at a time; the JSON
store does not implement cross-process locking.

The graph permits parallel branches; scene access is serialized inside each job's
Blender adapter to prevent lost edits. Independent jobs use separate workspaces.
All mandatory color and per-axis size checks must pass before completion.

## Verified on the shared Windows host, 2026-09-26

- Target branch started at `1f11b61`, 35 commits ahead and zero behind fetched main.
- Existing baseline: typecheck, 202 application tests and 8 release tests passed.
- Electron/control tests were excluded by the old test command; `test:control` now
  includes them in `pnpm test`.
- New automated coverage includes invalid DAGs, operation failure persistence,
  multipart upload/poll contracts, malformed evidence, failed gates, and restart.
- A real headless Blender 4.2 test generated two separated cubes and verified black
  material plus doubled bounding-box dimensions through FBX export and re-import.
  This fixture is **not** the horse acceptance asset.
- Production build and CLI list smoke test passed.
- Live Studio MCP initialize/tools/list inspected. `insert_asset` accepts assetId,
  assetName, assetType, parentPath and studio_id. `execute_luau` requires code,
  datamodel_type and studio_id; returning JSON provides evidence, printing does not.
- Place1.rbxl was discovered and its Edit-mode Workspace inspected using Studio ID
  `152406f7-cc28-40c6-92bf-91225c71326a`; its Place ID was 0 (local place).

**Gate 2 and the horse acceptance test have not passed.** No asset was uploaded or
inserted by this implementation during development. The credential file was absent
at the supplied path and horse.fbx was unavailable. Adapter-fake tests are not live
Roblox evidence. Re-discover Studio IDs before a later run.

## Run the real acceptance test

1. Place the Open Cloud credential at
   `~/.config/bloxbot/roblox-open-cloud-api-key`. Do not commit or paste it into logs.
   Creator type is `user`, creator ID `4974439157` for this integration host.
2. Open Place1 in Studio, enable MCP, and select it in BloxBot. Leave it in Edit mode.
3. Build/start the updated app and choose **Asset job** next to the Studio selector.
   Choose horse.fbx, enter creator user ID 4974439157, and run the job.
   Blender is detected at standard locations; use `BLOXBOT_BLENDER` to override.
4. The run uploads and inserts **two** uniquely named models: the untouched source
   reference and transformed output. Both remain for inspection. The reference
   permits comparing dimensions in studs without assuming FBX import unit settings.
   The job does not publish the place or change existing game objects.
5. Inspect the completed job in `control-plane.json`: both gate reports must pass,
   every mandatory requirement must be PASSED, and Roblox evidence must reference
   the selected Studio and the imported instance. Texture-covered color evidence
   is conservatively rejected. Review failed evidence instead of declaring success.

CLI alternative, from the repository (replace paths and re-discovered Studio ID):

```powershell
pnpm install --frozen-lockfile
pnpm v1 run 'C:\path\horse.fbx' '<studio-id>' 'C:\Program Files\Blender Foundation\Blender 4.2\blender.exe' '4974439157'
pnpm v1 list
```

Use `BLOXBOT_WORKSPACE` for an isolated CLI data directory. CLI errors return a
nonzero exit code; read the saved report and receipts before rerunning. No automatic
retry is made for non-idempotent upload/import operations.

To repeat the real Blender-only regression:

```powershell
$env:BLOXBOT_TEST_BLENDER = 'C:\Program Files\Blender Foundation\Blender 4.2\blender.exe'
pnpm test:control
```

Open Cloud upload contract:
https://create.roblox.com/docs/cloud/guides/usage-assets

The existing draft PR remains open; do not merge to main as part of this work.
