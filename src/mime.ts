const CRLF = "\r\n";

export interface DraftAttachment {
  content: string;
  filename?: string;
  inline?: boolean;
  mimeType?: string;
}

export interface DraftMimeInput {
  attachments: DraftAttachment[];
  bcc: string[];
  body?: string;
  cc: string[];
  htmlBody?: string;
  inReplyTo?: string;
  references?: string;
  subject: string;
  to: string[];
}

interface MimeNode {
  body: string;
  headers: [string, string][];
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let idx = 0; idx < bytes.length; idx += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(idx, idx + 0x8000));
  }
  return btoa(binary);
}

function base64FromString(value: string): string {
  return base64FromBytes(new TextEncoder().encode(value));
}

function wrap76(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join(CRLF);
}

function encodeHeaderValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64FromString(value)}?=`;
}

/* Header values built from message content must never introduce new header lines. */
function stripCrlf(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

function sanitizeFilename(filename: string): string {
  return stripCrlf(filename).replace(/"/g, "");
}

function textNode(content: string, mimeType: string): MimeNode {
  return {
    body: wrap76(base64FromString(content)),
    headers: [
      ["Content-Type", `${mimeType}; charset="UTF-8"`],
      ["Content-Transfer-Encoding", "base64"],
    ],
  };
}

function attachmentNode(attachment: DraftAttachment): MimeNode {
  const filename = attachment.filename !== void 0 ? sanitizeFilename(attachment.filename) : void 0;
  const mimeType = stripCrlf(attachment.mimeType ?? "application/octet-stream");
  const headers: [string, string][] = [
    ["Content-Type", filename !== void 0 ? `${mimeType}; name="${filename}"` : mimeType],
    ["Content-Transfer-Encoding", "base64"],
  ];
  if (attachment.inline === true) {
    headers.push(["Content-Disposition", "inline"]);
    headers.push(["Content-ID", `<${filename ?? crypto.randomUUID()}>`]);
  } else {
    headers.push([
      "Content-Disposition",
      filename !== void 0 ? `attachment; filename="${filename}"` : "attachment",
    ]);
  }
  return { body: wrap76(attachment.content.replace(/\s/g, "")), headers };
}

function multipartNode(subtype: string, children: MimeNode[]): MimeNode {
  const boundary = `b_${crypto.randomUUID()}`;
  const rendered = children
    .map((child) => `--${boundary}${CRLF}${renderHeaders(child.headers)}${CRLF}${CRLF}${child.body}`)
    .join(CRLF);
  return {
    body: `${rendered}${CRLF}--${boundary}--`,
    headers: [["Content-Type", `multipart/${subtype}; boundary="${boundary}"`]],
  };
}

function renderHeaders(headers: [string, string][]): string {
  return headers.map(([name, value]) => `${name}: ${value}`).join(CRLF);
}

export function buildDraftMime(input: DraftMimeInput): string {
  const inline = input.attachments.filter((attachment) => attachment.inline === true);
  const regular = input.attachments.filter((attachment) => attachment.inline !== true);

  const textParts: MimeNode[] = [];
  if (input.body !== void 0) textParts.push(textNode(input.body, "text/plain"));
  if (input.htmlBody !== void 0) textParts.push(textNode(input.htmlBody, "text/html"));
  const core =
    textParts.length === 2 ? multipartNode("alternative", textParts) : (textParts[0] ?? textNode("", "text/plain"));
  const withInline =
    inline.length > 0 ? multipartNode("related", [core, ...inline.map(attachmentNode)]) : core;
  const root =
    regular.length > 0 ? multipartNode("mixed", [withInline, ...regular.map(attachmentNode)]) : withInline;

  const headers: [string, string][] = [];
  if (input.to.length > 0) headers.push(["To", input.to.join(", ")]);
  if (input.cc.length > 0) headers.push(["Cc", input.cc.join(", ")]);
  if (input.bcc.length > 0) headers.push(["Bcc", input.bcc.join(", ")]);
  headers.push(["Subject", encodeHeaderValue(input.subject)]);
  if (input.inReplyTo !== void 0) headers.push(["In-Reply-To", stripCrlf(input.inReplyTo)]);
  if (input.references !== void 0) headers.push(["References", stripCrlf(input.references)]);
  headers.push(["MIME-Version", "1.0"]);
  headers.push(...root.headers);

  const message = `${renderHeaders(headers)}${CRLF}${CRLF}${root.body}`;
  return base64FromString(message).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
