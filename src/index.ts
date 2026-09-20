/**
 * The Worker. It is only a router, wrapped in an OAuth provider:
 *
 *   /mcp            AI tool calls      -> needs a bearer token; the provider checks it
 *                                         first, then hands the caller's identity to MCP
 *   /authorize      sign-in            -> consent screen, then GitHub (auth.ts)
 *   /callback       back from GitHub   -> issue the grant (auth.ts)
 *   /token, /register, /.well-known/*  -> answered by the OAuth provider itself
 *   /ws?room=demo   browser WebSocket  -> forwarded to the SiteRoom Durable Object
 *   /api/state      plain JSON read    -> so the page can render before the socket opens
 *   everything else -> static files in ./public, served by Cloudflare, never by this code
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { handleAuth, resolveAdminToken, type AuthProps } from "./auth";
import { handleMcp } from "./mcp";
import { sanitizeRoom } from "./room";

export { SiteRoom } from "./room";

const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" || url.pathname === "/callback") {
      return handleAuth(request, env);
    }

    if (url.pathname === "/ws" || url.pathname === "/api/state") {
      return roomFetch(request, env, url);
    }

    // Requests that match a file in ./public never get here — Cloudflare's asset
    // server answers them first. This is the fallback for everything else.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// Built once, at module scope: the provider caches its helpers on `env` the
// first time it runs, so per-request instances would silently share state.
// No fixed `resourceMetadata.resource`, so the same code serves local dev and
// production; MCP clients send the resource at sign-in and tokens are bound to it.
export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      handleMcp(request, env, (ctx as ExecutionContext & { props: AuthProps }).props),
  },
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  resolveExternalToken: resolveAdminToken,
});

function roomFetch(request: Request, env: Env, url: URL): Promise<Response> {
  const room = sanitizeRoom(url.searchParams.get("room"));
  const stub = env.SITE_ROOM.get(env.SITE_ROOM.idFromName(room));
  // Pass the request through untouched — rebuilding it would strip the
  // WebSocket upgrade. The Durable Object routes on the same pathname.
  return stub.fetch(request);
}
