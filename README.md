# gmail-mcp

Remote MCP server on Cloudflare Workers exposing multiple Gmail accounts to Claude through one connector. Tool names, descriptions, and response shapes replicate Anthropic's built-in Gmail connector; the additions are a required `account` parameter on every tool (plus `account: "all"` fan-out on `search_threads`) and `get_message_attachment`, which the built-in connector does not expose. That tool returns a short-lived signed download link rather than attachment content, so files reach disk without passing through the model's context.

## Architecture

- `/mcp`: Streamable HTTP MCP endpoint. Two auth paths: MCP OAuth (what claude.ai uses; dynamic client registration + PKCE via `workers-oauth-provider`, with the `/authorize` approval page gated by `SETUP_SECRET`) or a static bearer secret (`MCP_SECRET`) for CLI clients and tests.
- `/attachment?...&signature=<hmac>`: serves one attachment's raw bytes. `get_message_attachment` mints these links, signing account, message id, attachment id and a 10-minute expiry with `MCP_SECRET`. The link carries its own authorization so a plain `curl -o` works, and within its window it unlocks that one attachment and nothing else.
- `/connect/<alias>?key=<SETUP_SECRET>`: browser route that runs the Google OAuth flow for one account and stores its refresh token in KV.
- `/oauth/callback`: Google OAuth redirect target.
- Tokens live in the `GMAIL_KV` namespace (`refresh:<alias>` plus a short-lived `access:<alias>` cache). Scope is `gmail.modify`: read, search, labels, drafts; no send.
- Requires a Workers **paid** plan: `search_threads` and `list_drafts` make one Gmail request per result, so a large `pageSize` (or `account: "all"`) exceeds the free plan's 50-subrequest cap.

## Configuration

- `ACCOUNTS` var in `wrangler.jsonc`: comma-separated account aliases. Rerun `npx wrangler deploy` after changing it.
- Secrets (set with `npx wrangler secret put <NAME>`):
  - `MCP_SECRET`: bearer token Claude sends; anyone holding it can read the connected mailboxes.
  - `SETUP_SECRET`: gates the `/connect` routes.
  - `GOOGLE_CLIENT_ID_<ALIAS>` / `GOOGLE_CLIENT_SECRET_<ALIAS>` per account, alias uppercased (e.g. `GOOGLE_CLIENT_ID_CANDIX`).

## Per-account Google setup (~10 min, once per Workspace org)

1. Go to https://console.cloud.google.com and create a project inside that Workspace org (top-left project picker > New project).
2. APIs & Services > Library > search "Gmail API" > Enable.
3. APIs & Services > OAuth consent screen: User type **Internal** (no verification, refresh tokens do not expire), fill in the app name and contact email.
4. APIs & Services > Credentials > Create credentials > OAuth client ID > Application type **Web application**. Add the authorized redirect URI: `https://gmail-mcp.<your-subdomain>.workers.dev/oauth/callback`.
5. Copy the client ID and secret into Worker secrets:
   ```sh
   npx wrangler secret put GOOGLE_CLIENT_ID_<ALIAS>
   npx wrangler secret put GOOGLE_CLIENT_SECRET_<ALIAS>
   ```
6. Visit `https://gmail-mcp.<your-subdomain>.workers.dev/connect/<alias>?key=<SETUP_SECRET>` in a browser while signed in to that Google account, and approve.

Re-run step 6 anytime to reconnect (e.g. after revoking access).

## Connect to Claude

Settings > Connectors > Add custom connector:

- URL: `https://gmail-mcp.<your-subdomain>.workers.dev/mcp`
- Leave the OAuth client ID/secret fields empty (Claude registers itself dynamically).
- Click Add, then Connect: an approval page opens; paste `SETUP_SECRET` and approve.

The connector then works on claude.ai web, mobile, desktop, and Claude Code.

## Rotating the bearer secret

```sh
npx wrangler secret put MCP_SECRET
```

Then update the Authorization header in the Claude connector settings.
