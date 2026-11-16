/**
 * A claimed request's body: read once, parsed at most once, and rewritten by
 * the free-tier core-tool fallback when its model needs it.
 *
 * DSH sends inference as `fetch(new Request(url, { body }))`, so `init.body` is
 * undefined and the body has to be read off the Request. Three things read it:
 * the free-model check on the credential path, the core-tool fallback, and the
 * debug entry's tool names. They used to parse it once each; now the first
 * reader parses it and the others share the record.
 *
 * **The readers do not agree about a Buffer, on purpose.** The fallback
 * decodes one and rewrites it; the free-model check and the debug names read a
 * string body only, so a Buffer is "not free" (the missing-credential report
 * stays, the safe side) and names no tools until the fallback has rewritten it
 * into a string. {@link RequestBody.json} is the string-only reading and
 * {@link RequestBody.decoded} the fallback's.
 *
 * @module dsh-opencode-patch/request/body
 */

import { type CatalogPlane, specOn } from "../models-catalog.ts";
import { injectCoreToolsInto, isCoreToolUrl } from "../tool-fallback.ts";
import { isRecord } from "../utils/guards.ts";

/** A claimed request's body, as the patch found it. */
export interface RequestBody {
  /** Which half of the call carried it. */
  readonly source: "request" | "init" | "none";
  /** The body as it came: the init's own, or the Request's text. */
  readonly raw: RequestInit["body"];
  /**
   * The body parsed, when it is a string holding a JSON object: what the
   * free-model check and the debug names read. Parsed on first ask, once.
   */
  readonly json: () => Record<string, unknown> | undefined;
  /**
   * The body parsed, when it is a string or a Buffer holding a JSON object:
   * what the fallback reads. The same parse as {@link RequestBody.json}.
   */
  readonly decoded: () => Record<string, unknown> | undefined;
}

/** The text a body holds, when it is a string or a Buffer. */
const textOf = (raw: RequestInit["body"]): string | undefined => {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf-8");
  }
  return undefined;
};

/** A body over `raw`, its parse deferred to the first reader that asks. */
const bodyOf = (
  source: RequestBody["source"],
  raw: RequestInit["body"]
): RequestBody => {
  let parsed:
    | { readonly value: Record<string, unknown> | undefined }
    | undefined;
  const decoded = (): Record<string, unknown> | undefined => {
    if (parsed === undefined) {
      const text = textOf(raw);
      let value: unknown;
      if (text !== undefined && text.length > 0) {
        try {
          value = JSON.parse(text);
        } catch {
          value = undefined;
        }
      }
      parsed = { value: isRecord(value) ? value : undefined };
    }
    return parsed.value;
  };
  return {
    decoded,
    json: () => (typeof raw === "string" ? decoded() : undefined),
    raw,
    source,
  };
};

/**
 * Read a claimed request's body, off whichever half carries it.
 *
 * The init's body first; else the Request's, read from a clone so the
 * caller's stream is never consumed. A Request whose body is already spent
 * answers no body, and is sent as it stands.
 *
 * @param input - the request or URL `fetch` was called with.
 * @param init - the call's init, when it had one.
 */
export const readBody = async (
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<RequestBody> => {
  // The free-model check used to read `init.body` alone, so for every DSH
  // turn it answered "not free" and a keyless free model was reported as a
  // missing credential.
  const own = init?.body;
  if (own !== undefined) {
    return bodyOf("init", own);
  }
  if (input instanceof Request) {
    try {
      return bodyOf("request", await input.clone().text());
    } catch {
      return bodyOf("none", undefined);
    }
  }
  return bodyOf("none", undefined);
};

/**
 * Whether the model a body names is one the gateway admits with no key.
 *
 * The gateway's free-tier rule is per-model, not per-plane: `allowAnonymous` on
 * the model entry admits a request with no key at all, or with the literal
 * `public`, and the proxy strips it before forwarding
 * (`packages/console/app/src/lib/inference-proxy.ts`, identical in 1.19 and 2.x;
 * `docs/upstream-findings.md` §1.5). So "no credential resolved" is only a fault
 * for a model that NEEDS one, and reporting it for a free model sends the reader
 * to set a key they do not need.
 *
 * The body is read rather than assumed, because the model is the only thing that
 * decides. A plane-level check would be wrong in both directions: the Zen plane
 * offers free models, and so does Go, which serves them by subscription key.
 *
 * @param body - the request body, when there is one to read.
 * @param plane - the plane the request's URL is bound for.
 * @returns whether the model it names is flagged free.
 */
export const isFreeModelBody = (
  body: RequestBody,
  plane: CatalogPlane
): boolean => {
  // Both JSON routes carry the id under `model`, the Responses API included.
  const model: unknown = body.json()?.model;
  if (typeof model !== "string" || model.length === 0) {
    return false;
  }
  // **The plane's own flag.** A model can be free on one plane and not on the
  // other, and this decides whether a credential is required — so the answer
  // has to be the plane's. The plane-agnostic lookup searches Go first, which
  // today agrees with the plane-aware one for every model in the catalog, and
  // is wrong the day it does not.
  return specOn(plane, model)?.is_free === true;
};

/** The body a request goes out with, and the record it was written from. */
export interface SentBody {
  /** The body to send: the raw one, unless the fallback rewrote it. */
  readonly body: RequestInit["body"];
  /** The rewritten body's record; `undefined` when the body went as it came. */
  readonly record: Record<string, unknown> | undefined;
}

/**
 * The free-tier core-tool fallback over a claimed request's body: `read` and
 * `bash` for a free-tier model on `/responses` or `/chat/completions`, and
 * `tool_choice: "none"` for a toolless completions body (`tool-fallback.ts`).
 *
 * @param url - the request URL.
 * @param body - the body {@link readBody} read.
 * @param headers - the outgoing headers, whose `content-length` tracks a
 * rewritten body.
 * @param options - whether the fallback is on and which marker scopes it.
 */
export const applyCoreTools = (
  url: string,
  body: RequestBody,
  headers: Headers,
  options: { enabled: boolean; modelMarker: string }
): SentBody => {
  const unchanged: SentBody = { body: body.raw, record: undefined };
  if (!options.enabled || !isCoreToolUrl(url)) {
    return unchanged;
  }
  const record = body.decoded();
  if (
    record === undefined ||
    !injectCoreToolsInto(url, record, options.modelMarker)
  ) {
    return unchanged;
  }
  const text = JSON.stringify(record);
  headers.set("content-length", Buffer.byteLength(text).toString());
  return { body: text, record };
};

/**
 * Inject `read` + `bash` schemas into a free-tier completions body.
 *
 * {@link applyCoreTools} over a body handed in directly, so the fallback's
 * unit cases drive the reader and the gate the fetch patch runs rather than a
 * second copy of them. A declared `read`/`bash` without `properties` is
 * replaced, never duplicated; a chat-completions body that had no tools of
 * its own also gets `tool_choice: "none"`, and a `/responses` body never gets
 * a `tool_choice`.
 *
 * @param url - request URL (supports `/responses` and `/chat/completions`).
 * @param body - the outgoing request body.
 * @param headers - the mutable header bag whose `content-length` must track a
 * rewritten body.
 * @param options - whether injection is enabled and which model marker scopes it.
 * @returns the (possibly rewritten) body; the original reference when untouched.
 */
export const maybeInjectCoreTools = (
  url: string,
  body: RequestInit["body"],
  headers: Headers,
  options: { enabled: boolean; modelMarker: string }
): RequestInit["body"] =>
  applyCoreTools(url, bodyOf("init", body), headers, options).body;

/**
 * The call that sends a rewritten body.
 *
 * @param input - the request or URL `fetch` was called with.
 * @param init - the outgoing init, the patch's headers in it.
 * @param body - the body as it was read.
 * @param sent - the body to send.
 * @returns the input and init to call the wrapped `fetch` with.
 */
export const withSentBody = (
  input: RequestInfo | URL,
  init: RequestInit,
  body: RequestBody,
  sent: SentBody
): { input: RequestInfo | URL; init: RequestInit } => {
  if (sent.body === body.raw) {
    return { init, input };
  }
  if (body.source === "request" && input instanceof Request) {
    // The input Request already owns the old body — clone() so the
    // caller's stream is never consumed, and send a new Request.
    // `method` is restated so the lint can see it — the Request copy
    // carries the same method either way. The instanceof repeat is
    // there for the type checker.
    return {
      init,
      input: new Request(input, { body: sent.body, method: input.method }),
    };
  }
  return { init: { ...init, body: sent.body }, input };
};
