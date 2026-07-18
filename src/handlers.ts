import type { Env } from "./env";
import type {
  GmailLabel,
  GmailLabelColor,
  GmailMessage,
  GmailThread,
  MappedMessage,
  MessageFormat,
} from "./gmail";
import type { DraftAttachment } from "./mime";

import { isString } from "remeda";

import { accountAliases } from "./env";
import {
  assertKnownAlias,
  collectParts,
  GmailError,
  gmailFetch,
  headerValue,
  mapMessage,
  messageFetchParams,
  parseAddresses,
} from "./gmail";
import { buildDraftMime } from "./mime";

type Args = Record<string, unknown>;

/* -----------------------------------------------------------------------------
/* optionalBoolean
/* -------------------------------------------------------------------------- */

const optionalBoolean = (args: Args, key: string): boolean | undefined => {
  const value = args[key];

  return typeof value === "boolean" ? value : void 0;
};

/* -----------------------------------------------------------------------------
/* optionalInteger
/* -------------------------------------------------------------------------- */

const optionalInteger = (args: Args, key: string): number | undefined => {
  const value = args[key];

  return typeof value === "number" ? Math.trunc(value) : void 0;
};

/* -----------------------------------------------------------------------------
/* optionalString
/* -------------------------------------------------------------------------- */

const optionalString = (args: Args, key: string): string | undefined => {
  const value = args[key];

  return typeof value === "string" ? value : void 0;
};

/* -----------------------------------------------------------------------------
/* requiredString
/* -------------------------------------------------------------------------- */

const requiredString = (args: Args, key: string): string => {
  const value = optionalString(args, key);

  if (value === void 0 || value === "") {
    throw new GmailError(`Missing required parameter "${key}".`, 400);
  }

  return value;
};

/* -----------------------------------------------------------------------------
/* stringArray
/* -------------------------------------------------------------------------- */

const stringArray = (args: Args, key: string): string[] => {
  const value = args[key];

  if (!Array.isArray(value)) return [];

  return value.filter(isString);
};

/* -----------------------------------------------------------------------------
/* requiredStringArray
/* -------------------------------------------------------------------------- */

const requiredStringArray = (args: Args, key: string): string[] => {
  const value = stringArray(args, key);

  if (value.length === 0) {
    throw new GmailError(`Missing required parameter "${key}".`, 400);
  }

  return value;
};

/* -----------------------------------------------------------------------------
/* messageFormat
/* -------------------------------------------------------------------------- */

const messageFormat = (args: Args): MessageFormat => {
  const value = optionalString(args, "messageFormat");

  return value === "MINIMAL" || value === "METADATA_ONLY"
    ? value
    : "FULL_CONTENT";
};

/* -----------------------------------------------------------------------------
/* searchThreads
/* -------------------------------------------------------------------------- */

interface ThreadListResponse {
  nextPageToken?: string;
  resultSizeEstimate?: number;
  threads?: { id: string }[];
}

const searchThreads = async (
  env: Env,
  alias: string,
  args: Args,
): Promise<unknown> => {
  const includeTrash = optionalBoolean(args, "includeTrash") ?? false;

  const pageSize = Math.min(
    Math.max(optionalInteger(args, "pageSize") ?? 20, 1),
    50,
  );

  const pageToken = optionalString(args, "pageToken");

  const query = optionalString(args, "query");

  const view = optionalString(args, "view");

  const params = new URLSearchParams({ maxResults: String(pageSize) });

  const q = [
    query,
    query?.includes("in:draft") === true ? void 0 : "-in:draft",
  ]
    .filter(isString)
    .join(" ");

  if (q !== "") params.set("q", q);

  if (pageToken !== void 0) params.set("pageToken", pageToken);

  if (includeTrash) params.set("includeSpamTrash", "true");

  const list = await gmailFetch<ThreadListResponse>(
    env,
    alias,
    `/threads?${params}`,
  );

  const format: MessageFormat =
    view === "THREAD_VIEW_METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";

  const detailParams = messageFetchParams("MINIMAL");

  const threads = await Promise.all(
    (list.threads ?? []).map(async (item) => {
      const thread = await gmailFetch<GmailThread>(
        env,
        alias,
        `/threads/${item.id}?${detailParams}`,
      );

      return {
        id: thread.id,
        messages: (thread.messages ?? []).map((message) => {
          return mapMessage(message, format);
        }),
      };
    }),
  );

  /* The genuine connector returns {} on zero results (observed); empty fields
     are omitted. */
  return {
    ...(list.nextPageToken !== void 0
      ? { nextPageToken: list.nextPageToken }
      : {}),
    ...((list.resultSizeEstimate ?? 0) > 0
      ? { resultCountEstimate: String(list.resultSizeEstimate) }
      : {}),
    ...(threads.length > 0 ? { threads } : {}),
  };
};

/* -----------------------------------------------------------------------------
/* getThread
/* -------------------------------------------------------------------------- */

const getThread = async (
  env: Env,
  alias: string,
  args: Args,
): Promise<unknown> => {
  const format = messageFormat(args);

  const threadId = requiredString(args, "threadId");

  const thread = await gmailFetch<GmailThread>(
    env,
    alias,
    `/threads/${threadId}?${messageFetchParams(format)}`,
  );

  return {
    id: thread.id,
    messages: (thread.messages ?? []).map((message) => {
      return mapMessage(message, format);
    }),
  };
};

/* -----------------------------------------------------------------------------
/* getMessage
/* -------------------------------------------------------------------------- */

const getMessage = async (
  env: Env,
  alias: string,
  args: Args,
): Promise<unknown> => {
  const format = messageFormat(args);

  const messageId = requiredString(args, "messageId");

  const message = await gmailFetch<GmailMessage>(
    env,
    alias,
    `/messages/${messageId}?${messageFetchParams(format)}`,
  );

  return mapMessage(message, format);
};

/* -----------------------------------------------------------------------------
/* validateRecipients
/* -------------------------------------------------------------------------- */

const PLAIN_ADDRESS = /^[^\s@<>",]+@[^\s@<>",]+$/;

const validateRecipients = (addresses: string[], field: string): void => {
  for (const address of addresses) {
    if (!PLAIN_ADDRESS.test(address)) {
      throw new GmailError(
        `Invalid ${field} recipient "${address}". Each string MUST be a valid plain email address (e.g., "user@example.com").`,
        400,
      );
    }
  }
};

/* -----------------------------------------------------------------------------
/* draftAttachments
/* -------------------------------------------------------------------------- */

const draftAttachments = (args: Args): DraftAttachment[] => {
  const value = args["attachments"];

  if (!Array.isArray(value)) return [];

  return value.map((item): DraftAttachment => {
    if (typeof item !== "object" || item === null) {
      throw new GmailError(
        "Each attachment must be an object with a base64-encoded content field.",
        400,
      );
    }

    const record: Record<string, unknown> = { ...item };

    const content = record["content"];

    if (typeof content !== "string") {
      throw new GmailError(
        'Missing required attachment field "content" (base64-encoded).',
        400,
      );
    }

    return {
      content,
      filename: isString(record["filename"]) ? record["filename"] : void 0,
      inline: record["inline"] === true,
      mimeType: isString(record["mimeType"]) ? record["mimeType"] : void 0,
    };
  });
};

/* -----------------------------------------------------------------------------
/* quotePlaintext
/* -------------------------------------------------------------------------- */

const quotePlaintext = (
  body: string,
  attribution: string,
  original: string,
): string => {
  const quoted = original
    .split("\n")
    .map((line) => {
      return `> ${line}`;
    })
    .join("\n");

  return `${body}\n\n${attribution}\n${quoted}`;
};

/* -----------------------------------------------------------------------------
/* createDraft
/* -------------------------------------------------------------------------- */

const createDraft = async (
  env: Env,
  alias: string,
  args: Args,
): Promise<unknown> => {
  const to = stringArray(args, "to");

  const cc = stringArray(args, "cc");

  const bcc = stringArray(args, "bcc");

  validateRecipients(to, "to");

  validateRecipients(cc, "cc");

  validateRecipients(bcc, "bcc");

  let body = optionalString(args, "body");

  let htmlBody = optionalString(args, "htmlBody");

  let subject = optionalString(args, "subject");

  const replyToMessageId = optionalString(args, "replyToMessageId");

  let inReplyTo: string | undefined;

  let references: string | undefined;

  let threadId: string | undefined;

  if (replyToMessageId !== void 0) {
    const original = await gmailFetch<GmailMessage>(
      env,
      alias,
      `/messages/${replyToMessageId}?format=full`,
    );

    threadId = original.threadId;

    inReplyTo = headerValue(original, "Message-ID");

    references = [headerValue(original, "References"), inReplyTo]
      .filter(isString)
      .join(" ");

    if (references === "") references = void 0;

    const originalSubject = headerValue(original, "Subject");

    if (subject === void 0 && originalSubject !== void 0) {
      subject = /^re:/i.test(originalSubject)
        ? originalSubject
        : `Re: ${originalSubject}`;
    }

    const originalDate = headerValue(original, "Date");

    const originalSender = parseAddresses(headerValue(original, "From"))[0];

    const attribution = `On ${originalDate ?? "an earlier date"}, ${originalSender ?? "the original sender"} wrote:`;

    const collected = collectParts(original.payload);

    if (body !== void 0 && collected.plaintextBody !== void 0) {
      body = quotePlaintext(body, attribution, collected.plaintextBody);
    }

    if (htmlBody !== void 0 && collected.htmlBody !== void 0) {
      htmlBody = `${htmlBody}<br><br><div>${attribution}</div><blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${collected.htmlBody}</blockquote>`;
    }
  }

  const raw = buildDraftMime({
    attachments: draftAttachments(args),
    bcc,
    body,
    cc,
    htmlBody,
    inReplyTo,
    references,
    subject: subject ?? "",
    to,
  });

  const draft = await gmailFetch<{ id: string }>(env, alias, "/drafts", {
    body: JSON.stringify({
      message: { raw, ...(threadId !== void 0 ? { threadId } : {}) },
    }),
    method: "POST",
  });

  return { id: draft.id };
};

/* -----------------------------------------------------------------------------
/* mapDraft
/* -------------------------------------------------------------------------- */

interface DraftListResponse {
  drafts?: { id: string }[];
  nextPageToken?: string;
}

interface DraftDetail {
  id: string;
  message?: GmailMessage;
}

const mapDraft = (
  detail: DraftDetail,
  view: string | undefined,
): Record<string, unknown> => {
  const message = detail.message;

  const mapped: MappedMessage =
    message !== void 0
      ? mapMessage(message, "FULL_CONTENT")
      : { id: detail.id, labelIds: [] };

  const withContent = view !== "DRAFT_VIEW_METADATA_ONLY";

  return {
    ...(mapped.bccRecipients !== void 0
      ? { bccRecipients: mapped.bccRecipients }
      : {}),
    ...(mapped.ccRecipients !== void 0
      ? { ccRecipients: mapped.ccRecipients }
      : {}),
    ...(mapped.date !== void 0 ? { date: mapped.date } : {}),
    ...(withContent && mapped.htmlBody !== void 0
      ? { htmlBody: mapped.htmlBody }
      : {}),
    id: detail.id,
    ...(withContent && mapped.plaintextBody !== void 0
      ? { plaintextBody: mapped.plaintextBody }
      : {}),
    ...(withContent && mapped.subject !== void 0
      ? { subject: mapped.subject }
      : {}),
    ...(message?.threadId !== void 0 ? { threadId: message.threadId } : {}),
    ...(mapped.toRecipients !== void 0
      ? { toRecipients: mapped.toRecipients }
      : {}),
  };
};

/* -----------------------------------------------------------------------------
/* listDrafts
/* -------------------------------------------------------------------------- */

const listDrafts = async (
  env: Env,
  alias: string,
  args: Args,
): Promise<unknown> => {
  const pageSize = Math.min(
    Math.max(optionalInteger(args, "pageSize") ?? 20, 1),
    50,
  );

  const pageToken = optionalString(args, "pageToken");

  const query = optionalString(args, "query");

  const view = optionalString(args, "view");

  const params = new URLSearchParams({ maxResults: String(pageSize) });

  if (query !== void 0) params.set("q", query);

  if (pageToken !== void 0) params.set("pageToken", pageToken);

  const list = await gmailFetch<DraftListResponse>(
    env,
    alias,
    `/drafts?${params}`,
  );

  const drafts = await Promise.all(
    (list.drafts ?? []).map(async (item) => {
      const detail = await gmailFetch<DraftDetail>(
        env,
        alias,
        `/drafts/${item.id}?format=full`,
      );

      return mapDraft(detail, view);
    }),
  );

  return {
    ...(drafts.length > 0 ? { drafts } : {}),
    ...(list.nextPageToken !== void 0
      ? { nextPageToken: list.nextPageToken }
      : {}),
  };
};

/* -----------------------------------------------------------------------------
/* mapLabel
/* -------------------------------------------------------------------------- */

const mapLabel = (
  label: GmailLabel,
  color: GmailLabelColor | undefined,
): Record<string, unknown> => {
  return {
    ...(color !== void 0 ? { color } : {}),
    labelId: label.id,
    name: label.name,
  };
};

/* -----------------------------------------------------------------------------
/* listLabels
/* -------------------------------------------------------------------------- */

const listLabels = async (env: Env, alias: string): Promise<unknown> => {
  const list = await gmailFetch<{ labels?: GmailLabel[] }>(
    env,
    alias,
    "/labels",
  );

  const labels = await Promise.all(
    (list.labels ?? []).map(async (label) => {
      if (label.type !== "user" || label.color !== void 0) {
        return mapLabel(label, label.color);
      }

      const detail = await gmailFetch<GmailLabel>(
        env,
        alias,
        `/labels/${label.id}`,
      );

      return mapLabel(label, detail.color);
    }),
  );

  return { labels };
};

/* -----------------------------------------------------------------------------
/* createLabel
/* -------------------------------------------------------------------------- */

const createLabel = async (
  env: Env,
  alias: string,
  args: Args,
): Promise<unknown> => {
  const autoCreateParentLabels =
    optionalBoolean(args, "autoCreateParentLabels") ?? true;

  const displayName = requiredString(args, "displayName");

  const colorValue = args["color"];

  const color =
    typeof colorValue === "object" && colorValue !== null ? colorValue : void 0;

  if (autoCreateParentLabels && displayName.includes("/")) {
    const list = await gmailFetch<{ labels?: GmailLabel[] }>(
      env,
      alias,
      "/labels",
    );

    const existing = new Set(
      (list.labels ?? []).map((label) => {
        return label.name;
      }),
    );

    const segments = displayName.split("/");

    for (let idx = 1; idx < segments.length; idx += 1) {
      const parent = segments.slice(0, idx).join("/");

      if (existing.has(parent)) continue;

      await gmailFetch(env, alias, "/labels", {
        body: JSON.stringify({
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
          name: parent,
        }),
        method: "POST",
      });
    }
  }

  const created = await gmailFetch<GmailLabel>(env, alias, "/labels", {
    body: JSON.stringify({
      ...(color !== void 0 ? { color } : {}),
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
      name: displayName,
    }),
    method: "POST",
  });

  return mapLabel(created, created.color);
};

/* -----------------------------------------------------------------------------
/* modifyLabels
/* -------------------------------------------------------------------------- */

const modifyLabels = async (
  env: Env,
  alias: string,
  resource: "messages" | "threads",
  id: string,
  change: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<unknown> => {
  await gmailFetch(env, alias, `/${resource}/${id}/modify`, {
    body: JSON.stringify(change),
    method: "POST",
  });

  return {};
};

/* -----------------------------------------------------------------------------
/* applySensitiveLabel
/* -------------------------------------------------------------------------- */

const applySensitiveLabel = async (
  env: Env,
  alias: string,
  resource: "messages" | "threads",
  id: string,
  labelOption: string,
): Promise<unknown> => {
  if (labelOption === "TRASH") {
    await gmailFetch(env, alias, `/${resource}/${id}/trash`, {
      body: JSON.stringify({}),
      method: "POST",
    });

    return {};
  }

  if (labelOption === "SPAM") {
    return modifyLabels(env, alias, resource, id, { addLabelIds: ["SPAM"] });
  }

  throw new GmailError('Parameter "labelOption" must be TRASH or SPAM.', 400);
};

/* -----------------------------------------------------------------------------
/* callTool
/* -------------------------------------------------------------------------- */

/** Dispatches an MCP tool call to its handler on the requested account. */
export const callTool = async (
  env: Env,
  name: string,
  args: Args,
): Promise<unknown> => {
  const aliases = accountAliases(env);

  const account = optionalString(args, "account");

  if (account === void 0 || account === "") {
    throw new GmailError(
      `Missing required parameter "account". Configured accounts: ${aliases.join(", ")}.`,
      400,
    );
  }

  if (name === "search_threads" && account === "all") {
    const entries = await Promise.all(
      aliases.map(async (alias): Promise<[string, unknown]> => {
        return [alias, await searchThreads(env, alias, args)];
      }),
    );

    return Object.fromEntries(entries);
  }

  assertKnownAlias(env, account);

  switch (name) {
    case "apply_sensitive_message_label": {
      return applySensitiveLabel(
        env,
        account,
        "messages",
        requiredString(args, "messageId"),
        requiredString(args, "labelOption"),
      );
    }

    case "apply_sensitive_thread_label": {
      return applySensitiveLabel(
        env,
        account,
        "threads",
        requiredString(args, "threadId"),
        requiredString(args, "labelOption"),
      );
    }

    case "create_draft": {
      return createDraft(env, account, args);
    }

    case "create_label": {
      return createLabel(env, account, args);
    }

    case "get_message": {
      return getMessage(env, account, args);
    }

    case "get_thread": {
      return getThread(env, account, args);
    }

    case "label_message": {
      return modifyLabels(
        env,
        account,
        "messages",
        requiredString(args, "messageId"),
        { addLabelIds: requiredStringArray(args, "labelIds") },
      );
    }

    case "label_thread": {
      return modifyLabels(
        env,
        account,
        "threads",
        requiredString(args, "threadId"),
        { addLabelIds: requiredStringArray(args, "labelIds") },
      );
    }

    case "list_drafts": {
      return listDrafts(env, account, args);
    }

    case "list_labels": {
      return listLabels(env, account);
    }

    case "search_threads": {
      return searchThreads(env, account, args);
    }

    case "unlabel_message": {
      return modifyLabels(
        env,
        account,
        "messages",
        requiredString(args, "messageId"),
        { removeLabelIds: requiredStringArray(args, "labelIds") },
      );
    }

    case "unlabel_thread": {
      return modifyLabels(
        env,
        account,
        "threads",
        requiredString(args, "threadId"),
        { removeLabelIds: requiredStringArray(args, "labelIds") },
      );
    }

    default: {
      throw new GmailError(`Unknown tool "${name}".`, 400);
    }
  }
};
