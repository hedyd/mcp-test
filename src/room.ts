/**
 * SiteRoom — one Durable Object instance per "room" (per live page).
 *
 * This is the part that makes a server-less frontend live. A normal Worker
 * invocation dies in milliseconds and has nowhere to keep a socket. A Durable
 * Object is a single addressable, stateful object: every browser viewing room
 * "demo" and every MCP tool call targeting room "demo" is routed to the *same*
 * instance, anywhere in the world. It holds the open WebSockets and the current
 * state, so a tool call can push straight down to the browsers.
 *
 * It uses the WebSocket Hibernation API (ctx.acceptWebSocket), so the object can
 * be evicted from memory while sockets stay open — you are not billed for idle
 * connection time, and the connections survive.
 */

export interface SiteState {
  headline: string;
  subhead: string;
  theme: "light" | "dark" | "neon";
  items: { id: string; text: string; at: string; by?: string }[];
  rev: number;
  updatedAt: string;
  /** Who made the last change — a GitHub username, or "admin" for MCP_TOKEN. */
  updatedBy?: string;
}

const INITIAL_STATE: SiteState = {
  headline: "Waiting for the AI…",
  subhead: "This page has no server. Call an MCP tool and watch it change.",
  theme: "dark",
  items: [],
  rev: 0,
  updatedAt: new Date(0).toISOString(),
};

export type Patch = Partial<Pick<SiteState, "headline" | "subhead" | "theme">> & {
  addItem?: string;
  clearItems?: boolean;
  author?: string;
};

/**
 * Normalise a room name. The browser (?room=) and MCP (room argument) paths both
 * go through this, so "Alice" and "alice" can never become two different objects.
 */
export function sanitizeRoom(raw: string | null | undefined): string {
  const room = (raw ?? "demo").toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 64);
  return room || "demo";
}

export class SiteRoom implements DurableObject {
  private state: SiteState | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    // Answer client keepalives without waking the object from hibernation.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      // Public paths arrive forwarded from the Worker with the original request
      // intact (an upgrade request must not be rebuilt); the short paths are
      // called internally by the MCP handler.
      case "/ws":
      case "/connect":
        return this.handleConnect(request);
      case "/api/state":
      case "/state":
        return json(await this.load());
      case "/apply":
        return json(await this.apply((await request.json()) as Patch));
      case "/reset":
        return json(await this.reset());
      default:
        return new Response("not found", { status: 404 });
    }
  }

  /** Browser opens a WebSocket here. */
  private async handleConnect(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hand the socket to the runtime instead of keeping it in memory ourselves.
    this.ctx.acceptWebSocket(server);

    const state = await this.load();
    server.send(JSON.stringify({ type: "state", state }));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called by the runtime when a hibernated socket receives a message. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let msg: { type?: string };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    // Viewers are read-only here; they may only re-request the snapshot.
    if (msg.type === "sync") {
      ws.send(JSON.stringify({ type: "state", state: await this.load() }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // 1006 is not a code a server is allowed to send back.
    ws.close(code === 1006 ? 1000 : code, reason);
    this.broadcastPresence();
  }

  async webSocketError() {
    this.broadcastPresence();
  }

  // ---------------------------------------------------------------- state

  private async load(): Promise<SiteState> {
    if (!this.state) {
      this.state =
        (await this.ctx.storage.get<SiteState>("state")) ?? { ...INITIAL_STATE };
    }
    return this.state;
  }

  /** Apply a patch from an MCP tool call, persist it, push it to every viewer. */
  private async apply(patch: Patch): Promise<SiteState> {
    const state = { ...(await this.load()) };

    if (patch.headline !== undefined) state.headline = patch.headline;
    if (patch.subhead !== undefined) state.subhead = patch.subhead;
    if (patch.theme !== undefined) state.theme = patch.theme;
    if (patch.clearItems) state.items = [];
    if (patch.addItem !== undefined) {
      state.items = [
        ...state.items,
        {
          id: crypto.randomUUID(),
          text: patch.addItem,
          at: new Date().toISOString(),
          by: patch.author,
        },
      ].slice(-50);
    }

    state.rev += 1;
    state.updatedAt = new Date().toISOString();
    state.updatedBy = patch.author;

    this.state = state;
    await this.ctx.storage.put("state", state);
    this.broadcast({ type: "state", state });

    return state;
  }

  private async reset(): Promise<SiteState> {
    const state = { ...INITIAL_STATE, updatedAt: new Date().toISOString() };
    this.state = state;
    await this.ctx.storage.put("state", state);
    this.broadcast({ type: "state", state });
    return state;
  }

  // ------------------------------------------------------------ broadcast

  private broadcast(payload: unknown) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // Socket already gone; the close handler will tidy up.
      }
    }
  }

  private broadcastPresence() {
    this.broadcast({ type: "presence", viewers: this.ctx.getWebSockets().length });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
