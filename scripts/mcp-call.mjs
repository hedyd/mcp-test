#!/usr/bin/env node
/**
 * A tiny MCP client, so you can drive the site without wiring up an AI first.
 *
 *   node scripts/mcp-call.mjs list
 *   node scripts/mcp-call.mjs set_headline headline="Ship it" subhead="pushed over a websocket"
 *   node scripts/mcp-call.mjs add_item text="build finished"
 *   node scripts/mcp-call.mjs set_theme theme=neon
 *   node scripts/mcp-call.mjs get_state
 *
 * Point it somewhere else with env vars:
 *   MCP_URL=https://mcp-live-site.you.workers.dev/mcp MCP_TOKEN=secret node scripts/mcp-call.mjs list
 */

const URL_ = process.env.MCP_URL || "http://127.0.0.1:8787/mcp";
const TOKEN = process.env.MCP_TOKEN || "";

const [tool, ...rest] = process.argv.slice(2);

if (!tool) {
  console.error("usage: node scripts/mcp-call.mjs <list|tool-name> [key=value ...]");
  process.exit(1);
}

let id = 0;

async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const body = await res.json();
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.result;
}

function parseArgs(pairs) {
  if (pairs.length === 1 && pairs[0].trimStart().startsWith("{")) {
    return JSON.parse(pairs[0]);
  }
  return Object.fromEntries(
    pairs.map((p) => {
      const i = p.indexOf("=");
      if (i === -1) throw new Error(`expected key=value, got "${p}"`);
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
}

async function main() {
  // A real client always handshakes first.
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-call", version: "1.0.0" },
  });
  console.error(`connected to ${init.serverInfo.name} v${init.serverInfo.version}
`);

  if (tool === "list") {
    const { tools } = await rpc("tools/list");
    for (const t of tools) console.log(`${t.name.padEnd(14)} ${t.description}`);
    return;
  }

  const result = await rpc("tools/call", { name: tool, arguments: parseArgs(rest) });
  for (const block of result.content) console.log(block.text);
  if (result.isError) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
