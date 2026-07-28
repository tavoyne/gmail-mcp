import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export const ORIGIN = "https://gmail-mcp.net";

export interface Env {
  /* Comma-separated account aliases, e.g. "candix,personal". Per alias, the
     GOOGLE_CLIENT_ID_<ALIAS> and GOOGLE_CLIENT_SECRET_<ALIAS> secrets must be
     set. */
  ACCOUNTS: string;
  GMAIL_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  /* Bearer token accepted on /mcp alongside OAuth tokens. */
  MCP_SECRET: string;
  OAUTH_KV: KVNamespace;
  /* Injected by OAuthProvider on requests routed to the default handler. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /* Key gating the /connect/<alias> Google authorization routes and the
     /authorize MCP-client approval page. */
  SETUP_SECRET: string;
  [key: string]: unknown;
}

/** Parses the ACCOUNTS var into the list of configured account aliases. */
export const accountAliases = (env: Env): string[] => {
  return env.ACCOUNTS.split(",")
    .map((alias) => {
      return alias.trim();
    })
    .filter((alias) => {
      return alias.length > 0;
    });
};
