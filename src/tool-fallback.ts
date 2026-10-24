/**
 * Free-tier core-tool schema fallback.
 *
 * The OpenCode Zen gateway rejects free-tier `/responses` bodies that lack
 * `read` and `bash` in `tools`, while DSH deliberately does not send them.
 * When the request model is marked free-tier, this module rewrites the body
 * to carry both schemas — and only when they are actually missing, so a body
 * that already declares them passes through byte-identical.
 *
 * @module dsh-opencode-patch/tool-fallback
 */

import { ALL_MODELS_MARKER } from "./config-values.ts";
import { catalogPlaneForRoute, findModelSpecOn } from "./models-catalog.ts";
import { isRecord, isUnknownArray } from "./utils/guards.ts";

/** Path segment that marks a Responses-API body worth inspecting. */
export const RESPONSES_PATH = "/responses";

/** Placeholder `read` schema the gateway's validator accepts. */
export const DUMMY_READ_TOOL = {
  description: "Read a file or directory from the local filesystem.",
  name: "read",
  parameters: {
    properties: {
      filePath: {
        description: "The absolute path to the file or directory to read",
        type: "string",
      },
      offset: {
        description: "The line number to start reading from (1-indexed)",
        type: "number",
      },
      limit: {
        description: "The maximum number of lines to read (defaults to 2000)",
        type: "number",
      },
    },
    required: ["filePath"],
    type: "object",
  },
  type: "function",
} as const;

/** Placeholder `bash` schema the gateway's validator accepts. */
export const DUMMY_BASH_TOOL = {
  description: "Execute a bash command.",
  name: "bash",
  parameters: {
    properties: {
      command: {
        description: "The command to execute",
        type: "string",
      },
      workdir: {
        description:
          "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
        type: "string",
      },
      timeout: {
        description: "Optional timeout in milliseconds",
        type: "number",
      },
    },
    required: ["command"],
    type: "object",
  },
  type: "function",
} as const;

/** Placeholder `read` schema formatted for OpenAI-compatible /chat/completions. */
export const DUMMY_READ_TOOL_FUNCTION = {
  type: "function",
  function: {
    description: "Read a file or directory from the local filesystem.",
    name: "read",
    parameters: {
      properties: {
        filePath: {
          description: "The absolute path to the file or directory to read",
          type: "string",
        },
        offset: {
          description: "The line number to start reading from (1-indexed)",
          type: "number",
        },
        limit: {
          description: "The maximum number of lines to read (defaults to 2000)",
          type: "number",
        },
      },
      required: ["filePath"],
      type: "object",
    },
  },
} as const;

/** Placeholder `bash` schema formatted for OpenAI-compatible /chat/completions. */
export const DUMMY_BASH_TOOL_FUNCTION = {
  type: "function",
  function: {
    description: "Execute a bash command.",
    name: "bash",
    parameters: {
      properties: {
        command: {
          description: "The command to execute",
          type: "string",
        },
        workdir: {
          description:
            "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
          type: "string",
        },
        timeout: {
          description: "Optional timeout in milliseconds",
          type: "number",
        },
      },
      required: ["command"],
      type: "object",
    },
  },
} as const;

const toolNames = (
  tools: unknown[]
): { hasBash: boolean; hasRead: boolean; isOpenAiFormat: boolean } => {
  let hasBash = false;
  let hasRead = false;
  let isOpenAiFormat = false;
  for (const tool of tools) {
    if (!isRecord(tool)) {
      continue;
    }
    let toolName: unknown = tool.name;
    if (typeof toolName !== "string" && isRecord(tool.function)) {
      toolName = tool.function.name;
      isOpenAiFormat = true;
    }
    if (toolName === "read") {
      hasRead = true;
    }
    if (toolName === "bash") {
      hasBash = true;
    }
  }
  return { hasBash, hasRead, isOpenAiFormat };
};

/**
 * Whether `modelId` is in scope for the core-tool fallback.
 *
 * @param modelId - the request body's model id.
 * @param marker - the configured model-id marker.
 * @param route - a route id naming the plane the request is on: the turn's
 * provider or the URL's plane id. Go iff it is `opencode-go` or starts with
 * `opencode-go-`; anything else, and no route at all, is Zen.
 */
export const isCoreToolModel = (
  modelId: string,
  marker: string,
  route?: string
): boolean => {
  // The catalog's free-tier flag is the authority: it catches free models
  // whose ids carry no marker (big-pickle), where a substring test goes blind.
  // It is read from the request's own plane: the two planes price the same id
  // independently, so a Go-first lookup answered a Zen question with Go data.
  if (findModelSpecOn(catalogPlaneForRoute(route), modelId)?.is_free === true) {
    return true;
  }
  if (marker === ALL_MODELS_MARKER) {
    return true;
  }
  if (marker.length === 0) {
    return false;
  }
  return modelId.includes(marker);
};

/**
 * Inject `read` + `bash` schemas into a free-tier completions body.
 *
 * @param url - request URL (supports `/responses` and `/chat/completions`).
 * @param body - the outgoing request body.
 * @param headers - the mutable header bag whose `content-length` must track a
 * rewritten body.
 * @param options - whether injection is enabled, which model marker scopes it,
 * and the route id whose plane's catalog decides whether the model is free.
 * @returns the (possibly rewritten) body; the original reference when untouched.
 */
export const maybeInjectCoreTools = (
  url: string,
  body: RequestInit["body"],
  headers: Headers,
  options: { enabled: boolean; modelMarker: string; route?: string }
): RequestInit["body"] => {
  if (!options.enabled) {
    return body;
  }
  // Both JSON routes: the gateway checks read+bash on /responses AND
  // /chat/completions (a toolless completions body 403s the same way). An
  // Anthropic `/messages` URL names neither, so it never gets this far — which
  // is why there are no Anthropic-dialect schemas below.
  const isResponses = url.includes(RESPONSES_PATH);
  const isCompletions =
    url.includes("/chat/completions") || url.includes("/completions");
  if (!isResponses && !isCompletions) {
    return body;
  }
  if (body === undefined || body === null) {
    return body;
  }
  let bodyStr: string | undefined;
  if (typeof body === "string") {
    bodyStr = body;
  } else if (Buffer.isBuffer(body)) {
    bodyStr = body.toString("utf-8");
  } else {
    return body;
  }
  if (bodyStr.length === 0) {
    return body;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    return body;
  }
  if (!isRecord(parsed)) {
    return body;
  }
  const modelProp: unknown = parsed.model;
  if (typeof modelProp !== "string") {
    return body;
  }
  if (!isCoreToolModel(modelProp, options.modelMarker, options.route)) {
    return body;
  }
  const toolsProp: unknown = parsed.tools;
  let tools: unknown[];
  if (toolsProp === undefined) {
    tools = [];
  } else if (isUnknownArray(toolsProp)) {
    tools = [...toolsProp];
  } else {
    // A malformed `tools` value cannot be merged with — replace it, the same
    // as an absent one, so the request leaves with schemas the gateway accepts.
    tools = [];
  }
  const { hasBash, hasRead, isOpenAiFormat } = toolNames(tools);
  const useOpenAi = isOpenAiFormat || isCompletions;
  const readTool = useOpenAi ? DUMMY_READ_TOOL_FUNCTION : DUMMY_READ_TOOL;
  const bashTool = useOpenAi ? DUMMY_BASH_TOOL_FUNCTION : DUMMY_BASH_TOOL;

  if (!hasRead) {
    tools.push(readTool);
  }
  if (!hasBash) {
    tools.push(bashTool);
  }
  parsed.tools = tools;
  const newBodyStr = JSON.stringify(parsed);
  headers.set("content-length", Buffer.byteLength(newBodyStr).toString());
  return newBodyStr;
};
