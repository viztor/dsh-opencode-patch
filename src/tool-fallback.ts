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
import { isRecord, isUnknownArray } from "./guards.ts";

/** Path segment that marks a Responses-API body worth inspecting. */
export const RESPONSES_PATH = "/responses";

/** Check whether a request URL targets a model completion endpoint. */
export const isCompletionEndpoint = (url: string): boolean =>
  url.includes(RESPONSES_PATH) ||
  url.includes("/chat/completions") ||
  url.includes("/completions");

/** Placeholder `read` schema the gateway's validator accepts. */
export const DUMMY_READ_TOOL = {
  description: "Read a file or directory from the local filesystem.",
  name: "read",
  parameters: {
    properties: {
      filePath: {
        description: "The absolute path to the file",
        type: "string",
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
      command: { description: "The command to execute", type: "string" },
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
          description: "The absolute path to the file",
          type: "string",
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
        command: { description: "The command to execute", type: "string" },
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

/** Whether `modelId` is in scope for the core-tool fallback. */
export const isCoreToolModel = (modelId: string, marker: string): boolean => {
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
 * @param options - whether injection is enabled and which model marker scopes it.
 * @returns the (possibly rewritten) body; the original reference when untouched.
 */
export const maybeInjectCoreTools = (
  url: string,
  body: RequestInit["body"],
  headers: Headers,
  options: { enabled: boolean; modelMarker: string }
): RequestInit["body"] => {
  if (!options.enabled) {
    return body;
  }
  if (!url.includes(RESPONSES_PATH)) {
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
  if (!isCoreToolModel(modelProp, options.modelMarker)) {
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
  const useOpenAi =
    isOpenAiFormat ||
    url.includes("/chat/completions") ||
    url.includes("/completions");
  if (!hasRead) {
    tools.push(useOpenAi ? DUMMY_READ_TOOL_FUNCTION : DUMMY_READ_TOOL);
  }
  if (!hasBash) {
    tools.push(useOpenAi ? DUMMY_BASH_TOOL_FUNCTION : DUMMY_BASH_TOOL);
  }
  parsed.tools = tools;
  const newBodyStr = JSON.stringify(parsed);
  headers.set("content-length", Buffer.byteLength(newBodyStr).toString());
  return newBodyStr;
};
