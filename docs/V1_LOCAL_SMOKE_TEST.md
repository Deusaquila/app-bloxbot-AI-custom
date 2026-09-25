# V1 Blender → Roblox local smoke test

This checklist is the remaining real-environment verification for the locked V1
scenario. Automated adapter tests are not a substitute for this test and no Gate 2
result may be recorded unless it was obtained from the selected Studio instance.

## Prerequisites

- Blender with FBX import/export support is installed and its executable path is configured.
- Roblox Studio is open with **Studio as MCP server** enabled.
- `horse.fbx` is available locally and the selected Studio/place is safe to modify.
- The MCP tool list has been queried from the running Studio version. Do not assume a
  local-file import tool exists: the documented `insert_asset` tool accepts a numeric
  Roblox asset ID, not a local FBX path.

## Procedure

1. Start BloxBot from `feature/v1-job-core` and select the intended Studio by its
   `studio_id` from `list_roblox_studios`.
2. Create a Job with `horse.fbx` and `Gör den svart och dubbelt så stor.`.
3. Confirm the persisted input artifact SHA-256 and record the initial Blender
   fingerprint, including non-zero mesh counts and bounding-box dimensions.
4. Run the deterministic Blender capabilities. Confirm the same persisted `.blend`
   scene is used for mutation, verification, and export (rather than re-importing the
   original FBX for every operation).
5. Confirm Blender material verification observes `[0, 0, 0, 1]`, and dimensions
   verification observes a `2` ratio on every non-zero baseline axis within `0.01`.
6. Confirm Gate 1 passes before export. Confirm the exported FBX exists, is non-empty,
   has a SHA-256, and names the input artifact as its ancestor.
7. Inspect the live MCP tool list and use only the schema returned by that Studio
   version to import/upload the exported FBX. If no tool supports local FBX import,
   stop here: this is an external Studio/MCP capability blocker, not a passing import.
8. Reinspect the imported instance through MCP using the same explicit `studio_id`.
   Record object/material counts, hierarchy validity, black material values, and
   dimensions relative to the initial Blender fingerprint.
9. Confirm Gate 2 and both mandatory requirement evaluations pass. Only then confirm
   the Job transitions from `EVALUATING` to `COMPLETED`.
10. Restart BloxBot and confirm the Job, operations, artifacts, evidence, gate results,
    and final evaluations can still be read from the control-plane store.

Save the Blender log, MCP calls/results, hashes, and final report in the Job workspace.
Import success by itself is not evidence that either prompt requirement passed.
