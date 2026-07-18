import { accountAliases, type Env } from "./env";

export class GmailError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

export function credentialsFor(env: Env, alias: string): GoogleCredentials {
  const suffix = alias.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const clientId = env[`GOOGLE_CLIENT_ID_${suffix}`];
  const clientSecret = env[`GOOGLE_CLIENT_SECRET_${suffix}`];
  if (typeof clientId !== "string" || typeof clientSecret !== "string") {
    throw new GmailError(
      `Account "${alias}" has no Google OAuth client configured. Set the GOOGLE_CLIENT_ID_${suffix} and GOOGLE_CLIENT_SECRET_${suffix} secrets.`,
      500,
    );
  }
  return { clientId, clientSecret };
}

export function assertKnownAlias(env: Env, alias: string): void {
  const aliases = accountAliases(env);
  if (!aliases.includes(alias)) {
    throw new GmailError(`Unknown account "${alias}". Configured accounts: ${aliases.join(", ")}.`, 400);
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export async function exchangeToken(
  credentials: GoogleCredentials,
  grant: { code: string; redirectUri: string } | { refreshToken: string },
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
  if ("code" in grant) {
    params.set("code", grant.code);
    params.set("grant_type", "authorization_code");
    params.set("redirect_uri", grant.redirectUri);
  } else {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", grant.refreshToken);
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    body: params,
    method: "POST",
  });
  if (!response.ok) {
    throw new GmailError(`Google token request failed: ${await response.text()}`, response.status);
  }
  return response.json<TokenResponse>();
}

export async function storeTokens(env: Env, alias: string, tokens: TokenResponse): Promise<void> {
  if (tokens.refresh_token !== void 0) {
    await env.GMAIL_KV.put(`refresh:${alias}`, tokens.refresh_token);
  }
  const ttlSeconds = Math.max(60, tokens.expires_in - 300);
  await env.GMAIL_KV.put(`access:${alias}`, tokens.access_token, { expirationTtl: ttlSeconds });
  accessTokenCache.set(alias, { expiresAt: Date.now() + ttlSeconds * 1000, token: tokens.access_token });
}

/* In-memory layer over KV so a 50-wide Promise.all fan-out does one token
   lookup, and concurrent cold starts share a single refresh exchange. */
const accessTokenCache = new Map<string, { expiresAt: number; token: string }>();
const pendingTokenFetches = new Map<string, Promise<string>>();

export function getAccessToken(env: Env, alias: string): Promise<string> {
  const cached = accessTokenCache.get(alias);
  if (cached !== void 0 && cached.expiresAt > Date.now()) return Promise.resolve(cached.token);
  const pending = pendingTokenFetches.get(alias);
  if (pending !== void 0) return pending;
  const fetched = fetchAccessToken(env, alias).finally(() => pendingTokenFetches.delete(alias));
  pendingTokenFetches.set(alias, fetched);
  return fetched;
}

async function fetchAccessToken(env: Env, alias: string): Promise<string> {
  const stored = await env.GMAIL_KV.get(`access:${alias}`);
  if (stored !== null) {
    /* Remaining KV TTL is unknown; trust the stored token briefly. */
    accessTokenCache.set(alias, { expiresAt: Date.now() + 60_000, token: stored });
    return stored;
  }
  const refreshToken = await env.GMAIL_KV.get(`refresh:${alias}`);
  if (refreshToken === null) {
    throw new GmailError(
      `Account "${alias}" is not connected yet. Visit /connect/${alias}?key=<setup secret> in a browser to authorize it.`,
      401,
    );
  }
  const tokens = await exchangeToken(credentialsFor(env, alias), { refreshToken });
  await storeTokens(env, alias, tokens);
  return tokens.access_token;
}

export async function gmailFetch<T>(env: Env, alias: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken(env, alias);
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init?.body !== void 0 && init.body !== null) headers.set("content-type", "application/json");
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof parsed.error === "object" &&
        parsed.error !== null &&
        "message" in parsed.error &&
        typeof parsed.error.message === "string"
      ) {
        message = parsed.error.message;
      }
    } catch {
      /* keep raw body */
    }
    throw new GmailError(`[${alias}] ${message}`, response.status);
  }
  return response.json<T>();
}

/* Gmail REST resource shapes (only the fields read here). */

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPartBody {
  attachmentId?: string;
  data?: string;
}

export interface GmailPart {
  body?: GmailPartBody;
  filename?: string;
  headers?: GmailHeader[];
  mimeType?: string;
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
  snippet?: string;
  threadId?: string;
}

export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

export interface GmailLabelColor {
  backgroundColor?: string;
  textColor?: string;
}

export interface GmailLabel {
  color?: GmailLabelColor;
  id: string;
  name: string;
  type?: string;
}

export type MessageFormat = "FULL_CONTENT" | "METADATA_ONLY" | "MINIMAL";

export function headerValue(message: GmailMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload?.headers?.find((header) => header.name.toLowerCase() === lower)?.value;
}

export function parseAddresses(value: string | undefined): string[] {
  if (value === void 0) return [];
  return value.match(/[A-Za-z0-9._%+'=-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
}

function isoDate(internalDate: string | undefined): string | undefined {
  if (internalDate === void 0) return void 0;
  return `${new Date(Number(internalDate)).toISOString().slice(0, 19)}Z`;
}

export function decodeBody(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let idx = 0; idx < binary.length; idx += 1) bytes[idx] = binary.charCodeAt(idx);
  return new TextDecoder().decode(bytes);
}

export interface MappedAttachment {
  filename: string;
  id: string;
  mimeType: string;
}

export interface CollectedParts {
  attachments: MappedAttachment[];
  htmlBody?: string;
  plaintextBody?: string;
}

export function collectParts(payload: GmailPart | undefined): CollectedParts {
  const collected: CollectedParts = { attachments: [] };
  const visit = (part: GmailPart | undefined): void => {
    if (part === void 0) return;
    if (part.filename !== void 0 && part.filename !== "" && part.body?.attachmentId !== void 0) {
      collected.attachments.push({
        filename: part.filename,
        id: part.body.attachmentId,
        mimeType: part.mimeType ?? "application/octet-stream",
      });
    } else if (part.mimeType === "text/plain" && part.body?.data !== void 0 && collected.plaintextBody === void 0) {
      collected.plaintextBody = decodeBody(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data !== void 0 && collected.htmlBody === void 0) {
      collected.htmlBody = decodeBody(part.body.data);
    }
    for (const child of part.parts ?? []) visit(child);
  };
  visit(payload);
  return collected;
}

export interface MappedMessage {
  attachmentIds?: string[];
  attachments?: MappedAttachment[];
  bccRecipients?: string[];
  ccRecipients?: string[];
  date?: string;
  htmlBody?: string;
  id: string;
  labelIds: string[];
  plaintextBody?: string;
  sender?: string;
  snippet?: string;
  subject?: string;
  toRecipients?: string[];
}

export function mapMessage(message: GmailMessage, format: MessageFormat): MappedMessage {
  const mapped: MappedMessage = { id: message.id, labelIds: message.labelIds ?? [] };
  const date = isoDate(message.internalDate);
  if (date !== void 0) mapped.date = date;
  const sender = parseAddresses(headerValue(message, "From"))[0];
  if (sender !== void 0) mapped.sender = sender;
  const to = parseAddresses(headerValue(message, "To"));
  if (to.length > 0) mapped.toRecipients = to;
  const cc = parseAddresses(headerValue(message, "Cc"));
  if (cc.length > 0) mapped.ccRecipients = cc;
  const bcc = parseAddresses(headerValue(message, "Bcc"));
  if (bcc.length > 0) mapped.bccRecipients = bcc;
  if (format === "METADATA_ONLY") return mapped;
  if (message.snippet !== void 0) mapped.snippet = message.snippet;
  const subject = headerValue(message, "Subject");
  if (subject !== void 0) mapped.subject = subject;
  if (format === "MINIMAL") return mapped;
  const collected = collectParts(message.payload);
  if (collected.plaintextBody !== void 0) mapped.plaintextBody = collected.plaintextBody;
  if (collected.htmlBody !== void 0) mapped.htmlBody = collected.htmlBody;
  if (collected.attachments.length > 0) {
    mapped.attachmentIds = collected.attachments.map((attachment) => attachment.id);
    mapped.attachments = collected.attachments;
  }
  return mapped;
}

export function messageFetchParams(format: MessageFormat): URLSearchParams {
  const params = new URLSearchParams();
  if (format === "FULL_CONTENT") {
    params.set("format", "full");
    return params;
  }
  params.set("format", "metadata");
  for (const header of ["Bcc", "Cc", "Date", "From", "Subject", "To"]) {
    params.append("metadataHeaders", header);
  }
  return params;
}
