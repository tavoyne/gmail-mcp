import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpAgent } from "agents/mcp";

import { accountAliases } from "./env";
import { FAVICON_BASE64 } from "./favicon";
import { credentialsFor, exchangeToken, GmailError, storeTokens } from "./gmail";
import { callTool } from "./handlers";
import { buildTools } from "./schemas";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

const ORIGIN = "https://gmail-mcp.theophile.workers.dev";

/* -----------------------------------------------------------------------------
/* faviconBytes
/* -------------------------------------------------------------------------- */

const faviconBytes = (): Uint8Array => {
  const binary = atob(FAVICON_BASE64);

  const bytes = new Uint8Array(binary.length);

  for (let idx = 0; idx < binary.length; idx += 1) {
    bytes[idx] = binary.charCodeAt(idx);
  }

  return bytes;
};

/* -----------------------------------------------------------------------------
/* GmailMcp
/* -------------------------------------------------------------------------- */

export class GmailMcp extends McpAgent<Env> {
  server = new Server(
    {
      icons: [
        {
          mimeType: "image/x-icon",
          sizes: ["256x256"],
          src: `${ORIGIN}/favicon.ico`,
        },
      ],
      name: "Gmail (multi-account)",
      version: "1.0.0",
      websiteUrl: ORIGIN,
    },
    { capabilities: { tools: {} } },
  );

  async init(): Promise<void> {
    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      return { tools: buildTools(accountAliases(this.env)) };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const result = await callTool(
          this.env,
          request.params.name,
          request.params.arguments ?? {},
        );

        return {
          content: [
            {
              text: JSON.stringify(result),
              type: "text",
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              text: message,
              type: "text",
            },
          ],
          isError: true,
        };
      }
    });
  }
}

const mcpHandler = GmailMcp.serve("/mcp");

/* -----------------------------------------------------------------------------
/* staticAuthorized
/* -------------------------------------------------------------------------- */

/* Static bearer access for CLI clients and tests; claude.ai uses the OAuth
   flow below. */
const staticAuthorized = async (
  request: Request,
  env: Env,
): Promise<boolean> => {
  const header = request.headers.get("authorization");

  if (header === null) return false;

  const expected = new TextEncoder().encode(`Bearer ${env.MCP_SECRET}`);

  const received = new TextEncoder().encode(header);

  if (expected.length !== received.length) return false;

  return crypto.subtle.timingSafeEqual(expected, received);
};

/* -----------------------------------------------------------------------------
/* connect
/* -------------------------------------------------------------------------- */

const connect = (request: Request, env: Env): Response => {
  const url = new URL(request.url);

  const alias = decodeURIComponent(url.pathname.slice("/connect/".length));

  const key = url.searchParams.get("key");

  if (key !== env.SETUP_SECRET) return new Response("Forbidden", { status: 403 });

  if (!accountAliases(env).includes(alias)) {
    return new Response(
      `Unknown account "${alias}". Configured accounts: ${accountAliases(env).join(", ")}.`,
      { status: 404 },
    );
  }

  const params = new URLSearchParams({
    access_type: "offline",
    client_id: credentialsFor(env, alias).clientId,
    prompt: "consent",
    redirect_uri: `${url.origin}/oauth/callback`,
    response_type: "code",
    scope: GMAIL_SCOPE,
    state: `${alias}:${key}`,
  });

  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    302,
  );
};

/* -----------------------------------------------------------------------------
/* oauthCallback
/* -------------------------------------------------------------------------- */

const oauthCallback = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);

  const code = url.searchParams.get("code");

  const state = url.searchParams.get("state") ?? "";

  const separatorIdx = state.indexOf(":");

  const alias = separatorIdx > 0 ? state.slice(0, separatorIdx) : "";

  const key = separatorIdx > 0 ? state.slice(separatorIdx + 1) : "";

  if (key !== env.SETUP_SECRET || !accountAliases(env).includes(alias)) {
    return new Response("Forbidden", { status: 403 });
  }

  if (code === null) {
    return new Response(
      `Google returned no authorization code: ${url.searchParams.get("error") ?? "unknown error"}`,
      { status: 400 },
    );
  }

  const tokens = await exchangeToken(credentialsFor(env, alias), {
    code,
    redirectUri: `${url.origin}/oauth/callback`,
  });

  if (tokens.refresh_token === void 0) {
    return new Response(
      "Google returned no refresh token. Revoke the app's prior access at https://myaccount.google.com/permissions, then retry.",
      { status: 400 },
    );
  }

  await storeTokens(env, alias, tokens);

  const profileResponse = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { authorization: `Bearer ${tokens.access_token}` } },
  );

  const profile = profileResponse.ok
    ? await profileResponse.json<{ emailAddress?: string }>()
    : {};

  return new Response(
    `Connected ${profile.emailAddress ?? "account"} as "${alias}". You can close this tab.`,
  );
};

/* -----------------------------------------------------------------------------
/* encodeAuthRequest
/* -------------------------------------------------------------------------- */

const encodeAuthRequest = (authRequest: AuthRequest): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(authRequest));

  let binary = "";

  for (let idx = 0; idx < bytes.length; idx += 1) {
    binary += String.fromCharCode(bytes[idx] ?? 0);
  }

  return btoa(binary);
};

/* -----------------------------------------------------------------------------
/* decodeAuthRequest
/* -------------------------------------------------------------------------- */

const decodeAuthRequest = (encoded: string): AuthRequest => {
  const binary = atob(encoded);

  const bytes = new Uint8Array(binary.length);

  for (let idx = 0; idx < binary.length; idx += 1) {
    bytes[idx] = binary.charCodeAt(idx);
  }

  return JSON.parse(new TextDecoder().decode(bytes));
};

/* -----------------------------------------------------------------------------
/* escapeHtml
/* -------------------------------------------------------------------------- */

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
};

/* -----------------------------------------------------------------------------
/* oauthHelpers
/* -------------------------------------------------------------------------- */

const oauthHelpers = (env: Env): OAuthHelpers => {
  if (env.OAUTH_PROVIDER === void 0) {
    throw new Error("OAUTH_PROVIDER is only available on OAuthProvider routes.");
  }

  return env.OAUTH_PROVIDER;
};

/* -----------------------------------------------------------------------------
/* authorizePage
/* -------------------------------------------------------------------------- */

/* MCP-client authorization: the page where a connecting client (e.g.
   claude.ai) gets approved. Gated by the setup secret so only the owner can
   grant access. */
const authorizePage = async (request: Request, env: Env): Promise<Response> => {
  const helpers = oauthHelpers(env);

  const authRequest = await helpers.parseAuthRequest(request);

  const client = await helpers.lookupClient(authRequest.clientId);

  const clientName = client?.clientName ?? authRequest.clientId;

  const page = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>gmail-mcp</title></head>
  <body style="font-family:sans-serif;max-width:28rem;margin:4rem auto">
    <h1 style="font-size:1.2rem">Authorize MCP client</h1>
    <p><b>${escapeHtml(clientName)}</b> is requesting access to the Gmail accounts served by gmail-mcp (${escapeHtml(accountAliases(env).join(", "))}).</p>
    <form method="post" action="/authorize">
      <input type="hidden" name="state" value="${encodeAuthRequest(authRequest)}">
      <label>Username<br>
        <input type="text" name="username" value="gmail-mcp" autocomplete="username" style="width:100%">
      </label>
      <p></p>
      <label>Setup secret<br>
        <input type="password" name="key" autocomplete="current-password" style="width:100%" autofocus>
      </label>
      <p><button type="submit">Approve</button></p>
    </form>
  </body>
</html>`;

  return new Response(page, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};

/* -----------------------------------------------------------------------------
/* authorizeSubmit
/* -------------------------------------------------------------------------- */

const authorizeSubmit = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  const form = await request.formData();

  const key = form.get("key");

  const state = form.get("state");

  if (typeof key !== "string" || typeof state !== "string") {
    return new Response("Bad request", { status: 400 });
  }

  if (key !== env.SETUP_SECRET) {
    return new Response("Forbidden: wrong setup secret.", { status: 403 });
  }

  const authRequest = decodeAuthRequest(state);

  const { redirectTo } = await oauthHelpers(env).completeAuthorization({
    metadata: {},
    props: {},
    request: authRequest,
    scope: authRequest.scope,
    userId: "owner",
  });

  return Response.redirect(redirectTo, 302);
};

/* -----------------------------------------------------------------------------
/* defaultHandler
/* -------------------------------------------------------------------------- */

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/authorize") {
        return request.method === "POST"
          ? await authorizeSubmit(request, env)
          : await authorizePage(request, env);
      }

      if (url.pathname.startsWith("/connect/")) return connect(request, env);

      if (url.pathname === "/oauth/callback") {
        return await oauthCallback(request, env);
      }

      if (url.pathname === "/favicon.ico" || url.pathname === "/icon.svg") {
        return new Response(faviconBytes(), {
          headers: {
            "cache-control": "public, max-age=86400",
            "content-type": "image/x-icon",
          },
        });
      }

      if (url.pathname === "/icon.png") {
        /* The embedded ICO holds a single PNG entry after the 22-byte header. */
        return new Response(faviconBytes().subarray(22), {
          headers: {
            "cache-control": "public, max-age=86400",
            "content-type": "image/png",
          },
        });
      }

      if (url.pathname === "/") {
        return new Response(
          '<!doctype html><html><head><meta charset="utf-8"><title>gmail-mcp</title><link rel="icon" href="/favicon.ico" sizes="256x256"></head><body>gmail-mcp</body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof GmailError) {
        return new Response(error.message, { status: error.status });
      }

      throw error;
    }
  },
};

/* -----------------------------------------------------------------------------
/* Main
/* -------------------------------------------------------------------------- */

const oauthProvider = new OAuthProvider({
  apiHandler: mcpHandler,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler,
  tokenEndpoint: "/token",
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" && (await staticAuthorized(request, env))) {
      return mcpHandler.fetch(request, env, ctx);
    }

    return oauthProvider.fetch(request, env, ctx);
  },
};
