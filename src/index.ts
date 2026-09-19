/**
 * The Worker. It is only a router:
 *
 *   /ws?room=demo   browser WebSocket  -> forwarded to the SiteRoom Durable Object
 *   /mcp            AI tool calls      -> MCP JSON-RPC, which pokes the same object
 *   /api/state      plain JSON read    -> so the page can render before the socket opens
 *   everything else -> static files in ./public, served by Cloudflare, never by this code
 */

import { handleMcp } from "./mcp";

export { SiteRoom } from "./room";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }

    if (url.pathname === "/ws" || url.pathname === "/api/state") {
      return roomFetch(request, env, url);
    }

    // Requests that match a file in ./public never get here — Cloudflare's asset
    // server answers them first. This is the fallback for everything else.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function roomFetch(request: Request, env: Env, url: URL): Promise<Response> {
  const room = sanitizeRoom(url.searchParams.get("room"));
  const stub = env.SITE_ROOM.get(env.SITE_ROOM.idFromName(room));
  // Pass the request through untouched — rebuilding it would strip the
  // WebSocket upgrade. The Durable Object routes on the same pathname.
  return stub.fetch(request);
}

function sanitizeRoom(raw: string | null): string {
  const room = (raw ?? "demo").toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 64);
  return room || "demo";
}
