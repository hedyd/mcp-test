# mcp-live-site

A website with **no backend of its own** that updates the instant an AI calls a tool.

The page is plain static HTML/CSS/JS on Cloudflare's edge. It holds one WebSocket
open to a **Durable Object**. When an AI calls an MCP tool, the Worker pokes that
same Durable Object, which pushes the new state down every open socket. No
database, no polling, no origin server, no third-party realtime service.

```
   AI client (Claude Code, Claude Desktop, …)
        │  MCP over Streamable HTTP  (POST /mcp)
        ▼
   ┌──────────────────────────────────────────┐
   │  Cloudflare Worker  (src/index.ts)       │   stateless, dies in ~5ms
   │   /mcp  → JSON-RPC tool calls            │
   │   /ws   → upgrade, forward to the DO     │
   └───────────────┬──────────────────────────┘
                   │ stub.fetch()
                   ▼
   ┌──────────────────────────────────────────┐
   │  Durable Object "SiteRoom" (src/room.ts) │   ONE instance per room,
   │   • holds the state (SQLite storage)     │   globally addressable,
   │   • holds every open WebSocket           │   long-lived, hibernatable
   └───────────────┬──────────────────────────┘
                   │ ws.send(state)   ← the push
                   ▼
   ┌──────────────────────────────────────────┐
   │  Static page (public/) on Cloudflare CDN │   no server, no build step
   └──────────────────────────────────────────┘
```

The whole point is the middle box. A normal serverless function has nowhere to
keep a socket — it is gone before the browser reconnects. A Durable Object is a
single, named, stateful instance that every viewer and every tool call is routed
to, so it *can* keep the sockets and push to them.

## Try it in two minutes

```bash
npm install
npm run dev            # http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787> in a browser, leave it visible, then in another terminal:

```bash
export MCP_TOKEN=dev-token          # matches .dev.vars; PowerShell: $env:MCP_TOKEN="dev-token"

node scripts/mcp-call.mjs list
node scripts/mcp-call.mjs set_headline headline="Hello from an AI" subhead="nothing polled this"
node scripts/mcp-call.mjs add_item text="build started"
node scripts/mcp-call.mjs set_theme theme=neon
node scripts/mcp-call.mjs get_state
```

The page changes as you hit enter. Open a second tab — it picks up the current
state on connect and both tabs stay in sync. The viewer count at the bottom is
live too.

`scripts/mcp-call.mjs` is a ~60-line MCP client, there so you can see the
protocol without an AI in the loop.

## Deploy

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put MCP_TOKEN     # paste a long random string
```

That one command ships the static assets **and** the Worker **and** the Durable
Object to every Cloudflare location. You get a URL like
`https://mcp-live-site.<your-subdomain>.workers.dev`.

> Durable Objects need a Workers **paid plan ($5/mo)** on most accounts. The
> SQLite-backed class used here (`new_sqlite_classes` in `wrangler.jsonc`) is the
> variant available on the free plan where free DOs are offered — if
> `wrangler deploy` complains about Durable Objects, that is the plan gate, not
> your code.

## Point an AI at it

Claude Code:

```bash
claude mcp add --transport http live-site https://mcp-live-site.<you>.workers.dev/mcp \
  --header "Authorization: Bearer <your MCP_TOKEN>"
```

Claude Desktop / any client reading `mcpServers` config:

```jsonc
{
  "mcpServers": {
    "live-site": {
      "type": "http",
      "url": "https://mcp-live-site.<you>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <your MCP_TOKEN>" }
    }
  }
}
```

Then open the site and ask the AI something like *"set the headline to Deploy
finished and add a feed item for each step you just did."* The page moves while
it talks.

## Tools

| tool | what it does |
| --- | --- |
| `set_headline` | headline + optional subhead |
| `set_theme` | `light` \| `dark` \| `neon` |
| `add_item` | append a line to the live feed |
| `clear_items` | empty the feed |
| `get_state` | read what the page currently shows |

Every tool takes an optional `room` (default `"demo"`). Rooms are fully
independent — `idFromName(room)` maps to a different Durable Object instance, so
`/?room=alice` and `/?room=bob` are separate pages with separate state. That is
how you would give each student, customer or session their own live page without
provisioning anything.

## Files

| file | role |
| --- | --- |
| [src/index.ts](src/index.ts) | the Worker. Just a router: `/mcp`, `/ws`, `/api/state`, else static assets |
| [src/room.ts](src/room.ts) | the Durable Object. State + WebSocket fan-out. **The interesting file.** |
| [src/mcp.ts](src/mcp.ts) | MCP server: JSON-RPC over one POST endpoint, no SDK |
| [public/](public/) | the static site. `app.js` is the whole client |
| [scripts/mcp-call.mjs](scripts/mcp-call.mjs) | CLI MCP client for testing |
| [wrangler.jsonc](wrangler.jsonc) | bindings, assets, DO migration |

## Details worth knowing

**MCP needs no SDK here.** MCP is JSON-RPC 2.0 with agreed method names. A
server that keeps no per-session state answers `initialize`, `tools/list` and
`tools/call` with a plain JSON body — that is all of [src/mcp.ts](src/mcp.ts).
Notifications (messages with no `id`) get a bare `202`.

**Hibernation.** [src/room.ts](src/room.ts) uses `ctx.acceptWebSocket(ws)` rather
than `ws.accept()`. The runtime holds the sockets, so the object can be evicted
from memory while connections stay open, and you are not billed for idle
connection time. State is re-read from storage when it wakes. `setWebSocketAutoResponse`
answers the browser's keepalive `ping` without waking it at all.

**The upgrade request is passed through untouched.** `roomFetch` in
[src/index.ts](src/index.ts) hands the original `Request` to the stub instead of
rebuilding it, because rebuilding drops the WebSocket upgrade. The Durable Object
routes on the same pathname.

**Static assets never touch your code.** With the `assets` binding, Cloudflare
serves anything matching a file in `public/` directly from the CDN. Only `/mcp`,
`/ws` and `/api/state` reach the Worker, so the page itself costs no Worker
invocations.

**`/api/state`** exists so a page can render current state over plain HTTP —
useful for the first paint, or for `curl`.

**Auth.** `/mcp` requires `Authorization: Bearer $MCP_TOKEN` when the secret is
set. If you never set it, the endpoint is open — fine while developing, not fine
once it is on the internet, since anyone could rewrite your page. Viewers
(`/ws`, `/api/state`) are unauthenticated and read-only.

## Extending it

- **Let viewers write back.** `webSocketMessage` in the DO currently ignores
  everything but `sync`. Accept an edit message there and you have a shared
  whiteboard — the AI and the humans editing the same object.
- **Real content.** Replace the `SiteState` shape with whatever your page shows
  (a chart series, a build log, a kanban board). The transport doesn't change.
- **AI-facing reads.** `get_state` already lets the model see what viewers see,
  so it can decide what to change next.
- **Scheduling.** `ctx.storage.setAlarm()` inside the DO gives you timed pushes
  (countdowns, auto-expiry) with no cron worker.
