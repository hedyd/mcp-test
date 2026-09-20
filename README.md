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
```

That one command ships the static assets **and** the Worker **and** the Durable
Object to every Cloudflare location. You get a URL like
`https://mcp-live-site.<your-subdomain>.workers.dev`. The first deploy also
creates the `OAUTH_KV` namespace and writes its id into
[wrangler.jsonc](wrangler.jsonc) — commit that change.

The page works now; to let an AI write to it, set up sign-in (below).

> **This runs on the Workers free plan.** Durable Objects are free-plan
> eligible as long as they use the SQLite storage backend, which is what
> `new_sqlite_classes` in [wrangler.jsonc](wrangler.jsonc) selects. Free tier
> gives you 100k requests/day, 5 GB storage and 100k row writes/day; over the
> limit, requests fail rather than silently billing you. The older KV-backed
> Durable Objects are paid-only — do not switch `new_sqlite_classes` to
> `new_classes` unless you are on a paid plan and know why you want it.

## Sign in with GitHub

Nobody gets handed a token. People sign in with their GitHub account, and their
GitHub username becomes their room. It's standard MCP OAuth — the same way the
Figma or Google Drive connectors work.

**1. Create a GitHub OAuth app** at
<https://github.com/settings/applications/new>:

| field | value |
| --- | --- |
| Homepage URL | `https://mcp-live-site.<you>.workers.dev` |
| Authorization callback URL | `https://mcp-live-site.<you>.workers.dev/callback` |

Then click **Generate a new client secret**.

**2. Give the Worker its credentials:**

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

**3. Decide who's in.** In [wrangler.jsonc](wrangler.jsonc), put your own
GitHub username in `ADMIN_USERS`, and — for a class or team — everyone's in
`ALLOWED_USERS`. Then `npx wrangler deploy` again.

**4. Connect.** Each person runs:

```bash
claude mcp add --transport http live-site https://mcp-live-site.<you>.workers.dev/mcp
```

No header, no token. On first use Claude Code opens a browser (if it doesn't,
run `/mcp` and pick `live-site`): a consent screen names the app asking for
access, **Allow with GitHub** goes to GitHub's normal login, and they're done.
Tokens refresh on their own.

Then open the site and ask the AI something like *"set the headline to Deploy
finished and add a feed item for each step you just did."* The page moves while
it talks.

### Who can do what

| caller | rooms | shown on the page as |
| --- | --- | --- |
| GitHub user in `ADMIN_USERS` | any (default `demo`) | their username |
| any other allowed GitHub user | only `/?room=<their username>` | their username |
| `MCP_TOKEN` bearer (scripts, CI) | any (default `demo`) | `admin` |
| no token | nothing — `401` with sign-in instructions | |

- **`ALLOWED_USERS` empty means any GitHub account can sign in**, each confined
  to their own room. Fine for a demo; for a class, list everyone. Otherwise
  strangers can sign in and use up your free KV writes (below).
- **Removing someone from `ALLOWED_USERS` cuts them off on the next deploy** —
  including tokens they already hold. There is nothing to revoke by hand.
- **`MCP_TOKEN` is optional**, for things that can't click through a browser
  (`scripts/mcp-call.mjs`, CI). `npx wrangler secret put MCP_TOKEN` to enable it.

**Cost.** Sign-in state lives in Workers KV. Free tier: 100k reads/day,
1,000 writes/day. Each tool call is one read; each sign-in or token refresh is a
few writes. Comfortable for a class; past the limit, new sign-ins fail until
00:00 UTC rather than billing you.

**Signing in locally.** A GitHub OAuth app has one callback URL, so local dev
needs a second app with callback `http://127.0.0.1:8787/callback`, its id and
secret in `.dev.vars`. Or skip sign-in locally and use `MCP_TOKEN=dev-token`.

## Tools

| tool | what it does |
| --- | --- |
| `set_headline` | headline + optional subhead |
| `set_theme` | `light` \| `dark` \| `neon` |
| `add_item` | append a line to the live feed |
| `clear_items` | empty the feed |
| `get_state` | read what the page currently shows |

Every tool takes an optional `room`. Rooms are fully independent —
`idFromName(room)` maps to a different Durable Object instance, so
`/?room=alice` and `/?room=bob` are separate pages with separate state. That is
how you would give each student, customer or session their own live page without
provisioning anything. A signed-in user's default room is their own; see
[Who can do what](#who-can-do-what).

## Files

| file | role |
| --- | --- |
| [src/index.ts](src/index.ts) | the Worker: a router wrapped in the OAuth provider |
| [src/room.ts](src/room.ts) | the Durable Object. State + WebSocket fan-out. **The interesting file.** |
| [src/mcp.ts](src/mcp.ts) | MCP server: JSON-RPC over one POST endpoint, no SDK |
| [src/auth.ts](src/auth.ts) | sign-in: consent screen, GitHub round trip, who may use which room |
| [public/](public/) | the static site. `app.js` is the whole client |
| [scripts/mcp-call.mjs](scripts/mcp-call.mjs) | CLI MCP client for testing (uses `MCP_TOKEN`) |
| [wrangler.jsonc](wrangler.jsonc) | bindings, assets, DO migration, who's allowed |

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

**Auth is split in two.** [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
is the OAuth *server*: discovery documents, client registration, PKCE, issuing
and checking tokens (stored only as hashes). [src/auth.ts](src/auth.ts) is the
part it leaves to the app — working out who the user is, by sending them
through GitHub. The GitHub token is used once to read the username and then
discarded; the site never holds GitHub access.

**The consent screen is not decoration.** Any app can register itself as a
client, and GitHub skips its own prompt for returning users. Without our
screen, a malicious app could get a token for someone just by having them click
a link. The screen names the app and where it will send you, a per-login random
state is tied to a `SameSite` cookie so another site can't submit the form for
you, and the page refuses to be framed so a click can't be hijacked.

**`/mcp` is always locked.** Without a valid token it returns `401` pointing at
the sign-in metadata; there is no open mode. `MCP_TOKEN` is compared in
constant time, so response timing reveals nothing about a guess. Viewers
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
