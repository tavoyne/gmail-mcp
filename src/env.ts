import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /* Injected by OAuthProvider on requests routed to the default handler. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /* Comma-separated account aliases, e.g. "candix,second". Per alias, the
     GOOGLE_CLIENT_ID_<ALIAS> and GOOGLE_CLIENT_SECRET_<ALIAS> secrets must be set. */
  ACCOUNTS: string;
  GMAIL_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  /* Bearer token Claude sends on every /mcp request. */
  MCP_SECRET: string;
  /* Key gating the /connect/<alias> Google authorization routes. */
  SETUP_SECRET: string;
  [key: string]: unknown;
}

export function accountAliases(env: Env): string[] {
  return env.ACCOUNTS.split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}
