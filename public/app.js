/**
 * The entire client. It opens one WebSocket and renders whatever the Durable
 * Object sends. There is no polling, no API key, and no build step.
 */

const room = new URLSearchParams(location.search).get("room") || "demo";
const el = (id) => document.getElementById(id);

el("room").textContent = room;

let socket = null;
let retry = 0;
let lastRev = -1;

connect();

function connect() {
  setStatus("connecting", "connecting…");

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(room)}`);

  socket.addEventListener("open", () => {
    retry = 0;
    setStatus("open", "live");
  });

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return; // "pong" from the hibernation auto-responder
    }
    if (msg.type === "state") render(msg.state);
    if (msg.type === "presence") el("viewers").textContent = plural(msg.viewers, "watching");
  });

  socket.addEventListener("close", () => {
    setStatus("closed", "reconnecting…");
    // Exponential backoff, capped at 10s.
    const delay = Math.min(10000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  });

  socket.addEventListener("error", () => socket.close());
}

// Keepalive: the Durable Object answers "ping" with "pong" without waking up.
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
}, 30000);

function render(state) {
  const changed = state.rev !== lastRev && lastRev !== -1;
  lastRev = state.rev;

  document.documentElement.dataset.theme = state.theme;

  if (el("headline").textContent !== state.headline) {
    el("headline").textContent = state.headline;
    if (changed) flash(el("headline"));
  }
  el("subhead").textContent = state.subhead;

  const feed = el("feed");
  el("feed-wrap").hidden = state.items.length === 0;
  const known = new Set([...feed.children].map((li) => li.dataset.id));

  feed.replaceChildren(
    ...state.items.map((item) => {
      const li = document.createElement("li");
      li.dataset.id = item.id;
      const text = document.createElement("span");
      text.textContent = item.text;
      const time = document.createElement("time");
      time.dateTime = item.at;
      time.textContent = new Date(item.at).toLocaleTimeString();
      li.append(text, time);
      if (changed && !known.has(item.id)) flash(li);
      return li;
    }),
  );

  el("rev").textContent = `rev ${state.rev}`;
  el("updated").textContent = state.rev
    ? `updated ${new Date(state.updatedAt).toLocaleTimeString()}`
    : "never updated";
}

function flash(node) {
  node.classList.remove("flash");
  void node.offsetWidth; // restart the animation
  node.classList.add("flash");
}

function setStatus(state, text) {
  el("status").dataset.state = state;
  el("status-text").textContent = text;
}

function plural(n, word) {
  return `${n} ${n === 1 ? "browser" : "browsers"} ${word}`;
}
