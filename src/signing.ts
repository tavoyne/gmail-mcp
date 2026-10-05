import type { Env } from "./env";

import { ORIGIN } from "./env";

/* Long enough for an agent to curl the link, short enough that one left behind
   in a shell history or log is worthless. */
const TTL_SECONDS = 600;

export interface AttachmentRef {
  account: string;
  attachmentId: string;
  messageId: string;
}

/* -----------------------------------------------------------------------------
/* hmacKey
/* -------------------------------------------------------------------------- */

const hmacKey = async (env: Env): Promise<CryptoKey> => {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.MCP_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
};

/* -----------------------------------------------------------------------------
/* signedPayload
/* -------------------------------------------------------------------------- */

/* Binding all three ids plus the expiry means a signature unlocks exactly one
   attachment for exactly one window. */
const signedPayload = (ref: AttachmentRef, expires: number): Uint8Array => {
  return new TextEncoder().encode(
    `${ref.account}:${ref.messageId}:${ref.attachmentId}:${expires}`,
  );
};

/* -----------------------------------------------------------------------------
/* hex
/* -------------------------------------------------------------------------- */

const hex = (buffer: ArrayBuffer): string => {
  return [...new Uint8Array(buffer)]
    .map((byte) => {
      return byte.toString(16).padStart(2, "0");
    })
    .join("");
};

const unhex = (value: string): Uint8Array | undefined => {
  if (value.length % 2 !== 0 || /[^0-9a-f]/.test(value)) return void 0;

  const bytes = new Uint8Array(value.length / 2);

  for (let idx = 0; idx < bytes.length; idx += 1) {
    bytes[idx] = Number.parseInt(value.slice(idx * 2, idx * 2 + 2), 16);
  }

  return bytes;
};

/* -----------------------------------------------------------------------------
/* signAttachmentUrl
/* -------------------------------------------------------------------------- */

export interface SignedAttachmentUrl {
  expiresAt: string;
  url: string;
}

/** Mints a self-authenticating download link for one Gmail attachment. */
export const signAttachmentUrl = async (
  env: Env,
  ref: AttachmentRef,
  now: number,
): Promise<SignedAttachmentUrl> => {
  const expires = Math.floor(now / 1000) + TTL_SECONDS;

  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env),
    signedPayload(ref, expires),
  );

  const params = new URLSearchParams({
    account: ref.account,
    attachmentId: ref.attachmentId,
    expires: String(expires),
    messageId: ref.messageId,
  });

  return {
    expiresAt: `${new Date(expires * 1000).toISOString().slice(0, 19)}Z`,
    /* The signature rides in the path: agent hosts such as OpenClaw mask query
       params named like secrets (signature, sig, token...) before the model
       sees the link, which would leave it holding a dead URL. */
    url: `${ORIGIN}/attachment/${hex(signature)}?${params.toString()}`,
  };
};

/* -----------------------------------------------------------------------------
/* verifyAttachmentUrl
/* -------------------------------------------------------------------------- */

export type VerifyResult =
  | { ok: false; reason: "expired" | "invalid" }
  | { ok: true; ref: AttachmentRef };

/** Checks a download link's signature and expiry before any Gmail call. */
export const verifyAttachmentUrl = async (
  env: Env,
  url: URL,
  now: number,
): Promise<VerifyResult> => {
  const account = url.searchParams.get("account");

  const attachmentId = url.searchParams.get("attachmentId");

  const expires = url.searchParams.get("expires");

  const messageId = url.searchParams.get("messageId");

  const signature = url.pathname.startsWith("/attachment/")
    ? url.pathname.slice("/attachment/".length)
    : null;

  if (
    account === null ||
    attachmentId === null ||
    expires === null ||
    messageId === null ||
    signature === null
  ) {
    return { ok: false, reason: "invalid" };
  }

  const deadline = Number(expires);

  if (!Number.isSafeInteger(deadline)) return { ok: false, reason: "invalid" };

  const bytes = unhex(signature);

  if (bytes === void 0) return { ok: false, reason: "invalid" };

  const ref = { account, attachmentId, messageId };

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env),
    bytes,
    signedPayload(ref, deadline),
  );

  if (!valid) return { ok: false, reason: "invalid" };

  /* Expiry is checked only once the signature holds, so a forged link never
     learns whether its guessed window was plausible. */
  if (Math.floor(now / 1000) > deadline)
    return { ok: false, reason: "expired" };

  return { ok: true, ref };
};
