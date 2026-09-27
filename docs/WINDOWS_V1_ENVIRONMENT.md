# Windows V1 environment

Use Node 22 (validated with 22.23.3) and the packageManager version in package.json
(pnpm 12.6.0). Run from this repository:

```powershell
node --version
corepack enable
corepack prepare pnpm@12.6.0 --activate
pnpm install --frozen-lockfile
$env:BLOXBOT_TEST_BLENDER = 'C:\Program Files\Blender Foundation\Blender 4.2\blender.exe'
pnpm check:v1-environment
```

The environment checker prints only credential existence/nonempty status. It checks
Node, pnpm, Blender, Git, Studio process and the Roblox MCP launcher. gh is optional
when the connected GitHub tools handle PR publishing. Node/Blender need not be
installed globally if their explicit paths are configured.

If the credential is absent, run in an interactive desktop PowerShell window:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\set-roblox-open-cloud-key.ps1
```

Enter the key only at the hidden prompt. The script writes it outside the repository
at `%USERPROFILE%\.config\bloxbot\roblox-open-cloud-api-key`, restricted to the current
Windows user. It does not replace an existing nonempty file. Never pass the key as
an argument, paste it in chat, read it with Get-Content, or put it in a tracked env file.
Safe verification:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\set-roblox-open-cloud-key.ps1 -VerifyOnly
```

Open a dedicated disposable Studio place and enable Studio as MCP server. Discover
the live contract and instance IDs through the application broker:

```powershell
node scripts/inspect-studio-contract.cjs
```

The report contains tool schemas and a hash, not credentials. Select the intended
instance explicitly; never infer it from window focus. The integration creator is
user 4974439157. Temporary test model uploads are authorized on this host.

Use a short workspace root (for example `C:\Users\JM\BloxBot-v1-acceptance`) to avoid
Blender/Windows path-length restrictions. Do not run desktop and CLI controllers
against the same workspace simultaneously.
