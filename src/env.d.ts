// Hand-written so the example type-checks without running `wrangler types`.
// Run `npm run types` to generate the real worker-configuration.d.ts.
interface Env {
  SITE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Grants, tokens and registered clients for sign-in. Created on first deploy. */
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth provider in index.ts; not a binding. */
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;

  /** From your GitHub OAuth app. Set with: wrangler secret put GITHUB_CLIENT_ID */
  GITHUB_CLIENT_ID?: string;
  /** From your GitHub OAuth app. Set with: wrangler secret put GITHUB_CLIENT_SECRET */
  GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated GitHub usernames who may write to any room. */
  ADMIN_USERS?: string;
  /** Comma-separated GitHub usernames allowed to sign in. Empty = any GitHub account. */
  ALLOWED_USERS?: string;

  /** Optional admin key for scripts and CI. Set with: wrangler secret put MCP_TOKEN */
  MCP_TOKEN?: string;

  /** Local testing only: point sign-in at a fake GitHub. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
}
