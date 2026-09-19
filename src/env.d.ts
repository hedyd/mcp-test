// Hand-written so the example type-checks without running `wrangler types`.
// Run `npm run types` to generate the real worker-configuration.d.ts.
interface Env {
  SITE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Optional bearer token guarding /mcp. Set with: wrangler secret put MCP_TOKEN */
  MCP_TOKEN?: string;
}
