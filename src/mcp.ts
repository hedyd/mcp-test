/**
 * A minimal MCP server speaking Streamable HTTP over a single POST endpoint.
 *
 * MCP is just JSON-RPC 2.0 with an agreed set of method names. A server that
 * keeps no per-session state can answer every request with a plain JSON body,
 * which is all this file does — no SDK, no dependencies, ~150 lines.
 *
 * Every tool here ends up calling into the SiteRoom Durable Object, which is
 * what actually pushes the change to the open browsers.
 */

import type { Patch, SiteState } from "./room";

const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "set_headline",
    description:
      "Set the big headline on the live site. Every browser with the page open updates instantly.",
    inputSchema: {
      type: "object",
      properties: {
        headline: { type: "string", description: "The new headline text." },
        subhead: { type: "string", description: "Optional smaller line underneath." },
        room: { type: "string", description: "Room to update. Defaults to 'demo'." },
      },
      required: ["headline"],
    },
  },
  {
    name: "set_theme",
    description: "Change the live site's colour theme.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", enum: ["light", "dark", "neon"] },
        room: { type: "string", description: "Room to update. Defaults to 'demo'." },
      },
      required: ["theme"],
    },
  },
  {
    name: "add_item",
    description:
      "Append a line to the live feed on the site. Useful for streaming progress or notes to whoever is watching.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The line to append." },
        room: { type: "string", description: "Room to update. Defaults to 'demo'." },
      },
      required: ["text"],
    },
  },
  {
    name: "clear_items",
    description: "Remove every line from the live feed.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room to update. Defaults to 'demo'." },
      },
    },
  },
  {
    name: "get_state",
    description:
      "Read what the live site is currently showing, including how many browsers are watching.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room to read. Defaults to 'demo'." },
      },
    },
  },
] as const;

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "DELETE") return new Response(null, { status: 204 });

  // GET is the optional server->client SSE stream. This server has nothing
  // unsolicited to say over MCP, so it declines.
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  if (!authorized(request, env)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      },
    });
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  // Notifications (no id) get an empty 202 — nothing to answer.
  if (body.id === undefined || body.id === null) {
    return new Response(null, { status: 202 });
  }

  try {
    return rpcResult(body.id, await dispatch(body, env));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("METHOD_NOT_FOUND:")) {
      return rpcError(body.id, -32601, message.slice("METHOD_NOT_FOUND:".length));
    }
    return rpcError(body.id, -32603, message);
  }
}

async function dispatch(req: JsonRpcRequest, env: Env): Promise<unknown> {
  switch (req.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mcp-live-site", version: "1.0.0" },
        instructions:
          "Tools here drive a live web page. Changes appear in open browsers immediately.",
      };

    case "ping":
      return {};

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call":
      return callTool(req.params as { name?: string; arguments?: Record<string, unknown> }, env);

    default:
      throw new Error(`METHOD_NOT_FOUND:Unknown method: ${req.method}`);
  }
}

async function callTool(
  params: { name?: string; arguments?: Record<string, unknown> } | undefined,
  env: Env,
): Promise<unknown> {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const room = typeof args.room === "string" && args.room ? args.room : "demo";

  let patch: Patch | null = null;

  switch (name) {
    case "set_headline":
      patch = {
        headline: String(args.headline ?? ""),
        ...(typeof args.subhead === "string" ? { subhead: args.subhead } : {}),
      };
      break;

    case "set_theme": {
      const theme = String(args.theme ?? "");
      if (theme !== "light" && theme !== "dark" && theme !== "neon") {
        return toolText(`Unknown theme "${theme}". Use light, dark or neon.`, true);
      }
      patch = { theme };
      break;
    }

    case "add_item":
      patch = { addItem: String(args.text ?? "") };
      break;

    case "clear_items":
      patch = { clearItems: true };
      break;

    case "get_state": {
      const state = await roomRequest<SiteState>(env, room, "/state");
      return toolText(JSON.stringify(state, null, 2));
    }

    default:
      throw new Error(`METHOD_NOT_FOUND:Unknown tool: ${name}`);
  }

  const state = await roomRequest<SiteState>(env, room, "/apply", patch);
  return toolText(
    `Pushed to room "${room}" (rev ${state.rev}). The page now reads "${state.headline}".`,
  );
}

/** Route a call to the one Durable Object instance that owns this room. */
async function roomRequest<T>(
  env: Env,
  room: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const stub = env.SITE_ROOM.get(env.SITE_ROOM.idFromName(room));
  const res = await stub.fetch(`https://room${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  if (!res.ok) throw new Error(`Room error ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function authorized(request: Request, env: Env): boolean {
  // No token configured = open server. Fine for a demo, set one before sharing.
  if (!env.MCP_TOKEN) return true;
  return request.headers.get("authorization") === `Bearer ${env.MCP_TOKEN}`;
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
