// Diagnostic only: discover the live contract through the application's broker.
require("sucrase/register/ts");
const { Effect, ManagedRuntime } = require("effect");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createHash } = require("node:crypto");
const { writeFile } = require("node:fs/promises");
const { resolve, dirname } = require("node:path");
const {
  StudioMcpBroker,
  makeStudioMcpBrokerLayer,
} = require("../electron/services/StudioMcpBroker.ts");
async function main() {
  const destination = resolve(process.argv[2] || "../studio-mcp-contract.json");
  const runtime = ManagedRuntime.make(
    makeStudioMcpBrokerLayer({
      workspace: dirname(destination),
      localAppData: process.env.LOCALAPPDATA,
      comSpec: process.env.ComSpec,
      systemRoot: process.env.SystemRoot,
    }),
  );
  const client = new Client({ name: "BloxBot-contract-diagnostic", version: "1.0.0" });
  try {
    const broker = await runtime.runPromise(StudioMcpBroker);
    await client.connect(new StreamableHTTPClientTransport(new URL(broker.info.url)));
    const { tools } = await client.listTools();
    const contract = tools
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sha256 = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
    await writeFile(
      destination,
      JSON.stringify({ capturedAt: new Date().toISOString(), sha256, tools: contract }, null, 2),
    );
    console.log(JSON.stringify({ tools: contract.length, sha256, report: destination }));
    console.log(
      JSON.stringify(await runtime.runPromise(broker.callTool("list_roblox_studios", {}))),
    );
  } finally {
    await client.close();
    await runtime.dispose();
  }
}
main().catch(() => {
  console.error("Studio contract discovery failed");
  process.exitCode = 1;
});
