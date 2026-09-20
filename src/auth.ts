/**
 * Sign in with GitHub, so nobody has to hand out tokens.
 *
 * The OAuth *server* (token issuing, client registration, discovery documents,
 * checking bearer tokens on /mcp) is @cloudflare/workers-oauth-provider, wired
 * up in index.ts. This file is the part the library leaves to the app: deciding
 * who the user is. It does that by bouncing them through GitHub.
 *
 *   AI client ──► GET  /authorize   consent screen: "<client> wants to act as you"
 *             ──► POST /authorize   user clicks Allow → redirect to GitHub
 *   GitHub    ──► GET  /callback    we learn their GitHub login → issue our own grant
 *
 * The GitHub token is used once, to read the login, and then thrown away.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { sanitizeRoom } from "./room";

/** What an access token carries into the /mcp handler as ctx.props. */
export type AuthProps = { kind: "github"; login: string } | { kind: "token" };

export interface Identity {
  /** Shown on the page next to everything this caller writes. */
  name: string;
  /** The only room this caller may use, or null for every room. */
  room: string | null;
}

// Pending logins live this long between the consent screen and GitHub's callback.
const LOGIN_TTL_SECONDS = 600;

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return page(
      "Sign-in isn't set up",
      "<p>The site owner needs to set <code>GITHUB_CLIENT_ID</code> and " +
        "<code>GITHUB_CLIENT_SECRET</code>. See the README.</p>",
      503,
    );
  }

  if (url.pathname === "/authorize" && request.method === "GET") return consent(request, env);
  if (url.pathname === "/authorize" && request.method === "POST") return decide(request, env);
  if (url.pathname === "/callback" && request.method === "GET") return callback(request, env);
  return new Response("not found", { status: 404 });
}

/**
 * Decide what a signed-in caller may do. Checked on every /mcp request, not
 * just at login, so editing ADMIN_USERS or ALLOWED_USERS takes effect at once
 * for tokens that were already issued.
 */
export function identityFor(props: AuthProps, env: Env): Identity | null {
  if (props.kind === "token") return { name: "admin", room: null };

  const { login } = props;
  if (listed(env.ADMIN_USERS, login)) return { name: login, room: null };
  if (env.ALLOWED_USERS?.trim() && !listed(env.ALLOWED_USERS, login)) return null;
  return { name: login, room: login };
}

/**
 * The admin key (MCP_TOKEN) still works alongside OAuth, for scripts and CI
 * that can't click through a browser. The OAuth provider calls this for any
 * bearer token it didn't issue itself.
 */
export async function resolveAdminToken({
  token,
  env,
}: {
  token: string;
  env: Env;
}): Promise<{ props: AuthProps } | null> {
  if (!env.MCP_TOKEN) return null;
  // `===` stops at the first differing byte, so response timing leaks how much
  // of a guess was right. Hash both sides to a fixed length (timingSafeEqual
  // throws on unequal lengths, and this hides the token's length too), then
  // compare in constant time.
  const [given, expected] = await Promise.all([sha256(token), sha256(env.MCP_TOKEN)]);
  return crypto.subtle.timingSafeEqual(given, expected) ? { props: { kind: "token" } } : null;
}

// ------------------------------------------------------------- the flow

/** Step 1: show who is asking, before anything is sent to GitHub. */
async function consent(request: Request, env: Env): Promise<Response> {
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return page("Invalid sign-in request", `<p>${esc(errorText(err))}</p>`, 400);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return page("Unknown app", "<p>This app is not registered.</p>", 400);

  // A random key for this one login attempt. It goes in the form and in a
  // cookie; POST /authorize and /callback both require the two to match. A
  // SameSite cookie can't be planted by another site, so a malicious page
  // can't push a victim through the Allow step with its own pending request.
  const state = randomToken();
  await env.OAUTH_KV.put(pendingKey(state), JSON.stringify(authRequest), {
    expirationTtl: LOGIN_TTL_SECONDS,
  });

  const name = client.clientName || "An app";
  const sendsTo = safeHost(authRequest.redirectUri);

  return page(
    "Allow access to your live page?",
    `<p><b>${esc(name)}</b> wants to update your live page as you.</p>
     <p class="subhead">You'll sign in with GitHub next. Your GitHub username becomes
       your room, and the app will only be able to write there.</p>
     <p class="subhead">After you approve, you'll be sent back to <b>${esc(sendsTo)}</b>.
       If you don't recognise that, click Cancel.</p>
     <form method="post" action="/authorize" class="actions">
       <input type="hidden" name="state" value="${esc(state)}" />
       <button name="decision" value="allow" class="primary">Allow with GitHub</button>
       <button name="decision" value="deny">Cancel</button>
     </form>`,
    200,
    { "set-cookie": stateCookie(request, state, LOGIN_TTL_SECONDS) },
  );
}

/** Step 2: the user clicked Allow or Cancel on our consent screen. */
async function decide(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Defence in depth on top of the SameSite cookie: browsers send Origin on
  // form POSTs, and it must be us.
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return page("Blocked", "<p>Cross-site request.</p>", 403);

  const form = await request.formData();
  const state = String(form.get("state") ?? "");
  if (!state || state !== readCookie(request)) {
    return page("Sign-in expired", "<p>Start again from your app.</p>", 400);
  }

  const authRequest = await loadPending(env, state);
  if (!authRequest) return page("Sign-in expired", "<p>Start again from your app.</p>", 400);

  if (form.get("decision") !== "allow") {
    await env.OAUTH_KV.delete(pendingKey(state));
    // Tell the app the user said no, the standard OAuth way.
    const back = new URL(authRequest.redirectUri);
    back.searchParams.set("error", "access_denied");
    if (authRequest.state) back.searchParams.set("state", authRequest.state);
    return redirect(back.href, clearCookie(request));
  }

  const github = new URL("/login/oauth/authorize", githubWeb(env));
  github.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
  github.searchParams.set("redirect_uri", `${url.origin}/callback`);
  github.searchParams.set("state", state);
  // No scope: reading the public profile (the login) needs none.
  return redirect(github.href);
}

/** Step 3: GitHub sends the user back. Find out who they are, then issue our grant. */
async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");

  if (!state || state !== readCookie(request)) {
    return page("Sign-in expired", "<p>Start again from your app.</p>", 400);
  }

  const authRequest = await loadPending(env, state);
  // One use only: a replayed callback finds nothing.
  await env.OAUTH_KV.delete(pendingKey(state));
  if (!authRequest) return page("Sign-in expired", "<p>Start again from your app.</p>", 400);

  if (!code) {
    return page("GitHub sign-in was cancelled", "<p>Start again from your app.</p>", 400, {
      "set-cookie": clearCookie(request),
    });
  }

  let login: string;
  try {
    login = await githubLogin(env, code, `${url.origin}/callback`);
  } catch (err) {
    console.error("GitHub sign-in failed:", errorText(err));
    return page("GitHub sign-in failed", "<p>Please try again.</p>", 502);
  }

  const props: AuthProps = { kind: "github", login };
  if (!identityFor(props, env)) {
    return page(
      "Not on the list",
      `<p>The GitHub account <b>@${esc(login)}</b> isn't allowed on this site. ` +
        "Ask the site owner to add you.</p>",
      403,
      { "set-cookie": clearCookie(request) },
    );
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: login,
    metadata: { login },
    scope: authRequest.scope,
    props,
  });

  return redirect(redirectTo, clearCookie(request));
}

/** Trade GitHub's one-time code for a token, read the login, drop the token. */
async function githubLogin(env: Env, code: string, redirectUri: string): Promise<string> {
  const tokenRes = await fetch(new URL("/login/oauth/access_token", githubWeb(env)), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) throw new Error(`token exchange: ${token.error ?? tokenRes.status}`);

  const userRes = await fetch(new URL("/user", githubApi(env)), {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      // GitHub rejects API requests without a User-Agent.
      "user-agent": "mcp-live-site",
    },
  });
  if (!userRes.ok) throw new Error(`GitHub /user: ${userRes.status}`);

  const user = (await userRes.json()) as { login?: string };
  // GitHub logins are case-insensitive; rooms are lowercase.
  const login = sanitizeRoom(user.login);
  if (!user.login || login !== user.login.toLowerCase()) {
    throw new Error(`unusable GitHub login: ${user.login}`);
  }
  return login;
}

// ------------------------------------------------------------- helpers

// Overridable so the whole flow can be tested locally against a fake GitHub.
const githubWeb = (env: Env) => env.GITHUB_OAUTH_URL || "https://github.com";
const githubApi = (env: Env) => env.GITHUB_API_URL || "https://api.github.com";

const pendingKey = (state: string) => `login-state:${state}`;

async function loadPending(env: Env, state: string): Promise<AuthRequest | null> {
  return env.OAUTH_KV.get<AuthRequest>(pendingKey(state), "json");
}

function listed(list: string | undefined, login: string): boolean {
  return (list ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(login);
}

// `__Host-` cookies must be Secure, which plain-http local dev can't do.
function cookieName(request: Request): string {
  return new URL(request.url).protocol === "https:" ? "__Host-login_state" : "login_state";
}

function stateCookie(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const clearCookie = (request: Request) => stateCookie(request, "", 0);

function readCookie(request: Request): string | null {
  const name = cookieName(request);
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) =>
    c === "+" ? "-" : c === "/" ? "_" : "",
  );
}

function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host || uri;
  } catch {
    return uri;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function esc(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function page(
  title: string,
  body: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(
    `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="stage narrow">
    <h1>${esc(title)}</h1>
    ${body}
  </main>
</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Nobody may frame the consent screen and trick a click onto Allow.
        "content-security-policy": "frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "cache-control": "no-store",
        ...extra,
      },
    },
  );
}
