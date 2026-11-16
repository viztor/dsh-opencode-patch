/**
 * What each generation of the OpenCode client sends: its User-Agent, its
 * session headers and what they carry, and its origin headers (L6).
 *
 * The plugin emulates one generation ({@link EMULATED_GENERATION}), and the
 * headers it writes (`planeHeadersFor` in `request-shape.ts`) and the
 * User-Agent it signs with (`identity.ts`) are read from that generation's
 * row. The other row is RECORDED, not read: it says what the next generation
 * sends, so the tree has one statement of which generation sends which header
 * where, and a switch starts from a table rather than a hunt through comments.
 *
 * A switch is NOT a one-word change. `sessionValue` is recorded and read by
 * nothing yet: `planeHeadersFor` writes the session id into every session
 * header, so emulating 2.x also needs the affinity id plumbed in as an input,
 * the User-Agent's channel and client parts supplied, and the writer taught
 * that 2.x has no message-id header.
 *
 * No 2.x version is pinned (`OPENCODE_CLI_VERSION` is a 1.x version): the 2.x
 * row's User-Agent is a format, not a value. A concrete 2.x literal anywhere
 * in the tree is still a claim nothing checks, and `pnpm run cli:version`
 * refuses one.
 *
 * Every value is a constant or a function of its arguments: this module is in
 * `utils/` and the architecture test holds it to that.
 *
 * @module dsh-opencode-patch/utils/client-generation
 */

import {
  PARENT_SESSION_ALT_HEADER,
  PARENT_SESSION_HEADER,
  SESSION_AFFINITY_HEADER,
  SESSION_HEADER,
  SESSION_ID_HEADER,
} from "./session-id.ts";

/** The parts a User-Agent is built from; a generation reads what its form needs. */
export interface UserAgentParts {
  readonly version: string;
  /** The release channel (`latest`, `dev`, ...), which only 2.x names. */
  readonly channel?: string;
  /** The client app's name (`cli`, ...), which only 2.x names. */
  readonly client?: string;
}

/** One generation's row. */
export interface ClientGeneration {
  /** The User-Agent this generation sends, from its parts. */
  readonly userAgent: (parts: UserAgentParts) => string;
  /** The session headers on a request to an OpenCode plane, in write order. */
  readonly planeSessionHeaders: readonly string[];
  /** The session headers added for a relay (a route not named `opencode*`). */
  readonly relaySessionHeaders: readonly string[];
  /** The parent-session headers, for a subagent or child session. */
  readonly parentHeaders: readonly string[];
  /** The origin headers: the client app, the turn's message id, the project. */
  readonly originHeaders: {
    readonly client: string;
    readonly request?: string;
    readonly project: string;
  };
  /**
   * What the session headers other than `x-opencode-session-id` carry: the
   * session's own id, or its affinity id (the parent's id for a subagent).
   */
  readonly sessionValue: "session" | "affinity";
  /** Where the row was read from, and how sure the reading is. */
  readonly evidence: string;
}

/** The generations the table records. */
export type GenerationId = "1.x" | "2.x";

/** The table, one row per generation. */
export const CLIENT_GENERATIONS = {
  "1.x": {
    evidence:
      "v1.19.5 packages/opencode/src/session/llm/request.ts: the User-Agent (line 18), the plane and relay branches, and the origin headers in the client and project branch",
    originHeaders: {
      client: "x-opencode-client",
      project: "x-opencode-project",
      request: "x-opencode-request",
    },
    parentHeaders: [PARENT_SESSION_HEADER, PARENT_SESSION_ALT_HEADER],
    planeSessionHeaders: ["x-opencode-session-id", SESSION_HEADER],
    relaySessionHeaders: [SESSION_AFFINITY_HEADER, SESSION_ID_HEADER],
    sessionValue: "session",
    userAgent: ({ version }) => `opencode/${version}`,
  },
  "2.x": {
    evidence:
      "recorded, not measured: packages/core/src/session/model-request.ts at 2.0.32 (docs/upstream-findings.md §1.3), packages/core/src/app.ts:24 for the User-Agent, a capture of 2.0.28 for the four session headers (utils/session-id.ts), and §2.1 for the dropped message id; whether the gateway enforces any of it is unverified",
    originHeaders: {
      client: "x-opencode-client",
      project: "x-opencode-project",
    },
    parentHeaders: [PARENT_SESSION_HEADER, PARENT_SESSION_ALT_HEADER],
    planeSessionHeaders: [
      "x-opencode-session-id",
      SESSION_AFFINITY_HEADER,
      SESSION_ID_HEADER,
      SESSION_HEADER,
    ],
    relaySessionHeaders: [],
    sessionValue: "affinity",
    userAgent: ({ channel, client, version }) =>
      `opencode/${channel ?? "<channel>"}/${version}/${client ?? "<client>"}`,
  },
} as const satisfies Readonly<Record<GenerationId, ClientGeneration>>;

/** The generation this plugin emulates: the one the registry's `latest` publishes. */
export const EMULATED_GENERATION = "1.x" satisfies GenerationId;
