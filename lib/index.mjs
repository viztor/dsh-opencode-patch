import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
//#region src/index.ts
const name = "dsh-opencode";
const inject = ["llm"];
const SESSION_HEADER = "x-opencode-session";
const OPENCODE_UA = "opencode/1.18.33 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";
const DUMMY_READ_TOOL = {
	description: "Read a file or directory from the local filesystem.",
	name: "read",
	parameters: {
		properties: { filePath: {
			description: "The absolute path to the file",
			type: "string"
		} },
		required: ["filePath"],
		type: "object"
	},
	type: "function"
};
const DUMMY_BASH_TOOL = {
	description: "Execute a bash command.",
	name: "bash",
	parameters: {
		properties: { command: {
			description: "The command to execute",
			type: "string"
		} },
		required: ["command"],
		type: "object"
	},
	type: "function"
};
/** Derive a valid OpenCode session ID (`ses_<12hex><14base62>`) deterministically from a DSH sessionId. */
const openCodeSessionIdFor = (sessionId) => {
	const hash = createHash("sha256").update(String(sessionId)).digest();
	const hexPart = hash.subarray(0, 6).toString("hex");
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let randPart = "";
	for (let i = 6; i < 20; i += 1) {
		const byte = hash[i];
		if (byte !== void 0) randPart += chars[byte % 62];
	}
	return `ses_${hexPart}${randPart}`;
};
const DEFAULT_PROVIDERS = ["opencode", "opencode-go"];
const resolveConfig = (config = {}) => {
	const providers = Array.isArray(config.providers) && config.providers.length > 0 ? config.providers.map(String) : [...DEFAULT_PROVIDERS];
	const mode = config.mode === "uuid" ? "uuid" : "session-id";
	const debug = config.debug === true;
	const debugFile = typeof config.debugFile === "string" && config.debugFile.length > 0 ? config.debugFile : void 0;
	const injectUserAgent = config.injectUserAgent !== false;
	const userAgent = typeof config.userAgent === "string" && config.userAgent.trim().length > 0 ? config.userAgent.trim() : void 0;
	const injectOriginHeaders = config.injectOriginHeaders !== false;
	return {
		debug,
		debugFile,
		injectCoreTools: config.injectCoreTools !== false,
		injectOriginHeaders,
		injectUserAgent,
		mode,
		providers: new Set(providers),
		userAgent
	};
};
const recordDebug = async (ctx, file, entry) => {
	try {
		await appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.logger?.warn?.("[dsh-opencode] debugFile write failed: %s", msg);
	}
};
const headerValueFor = (sessionId, _mode, table) => {
	if (sessionId === void 0 || sessionId === null) return;
	const raw = String(sessionId);
	if (raw.length === 0) return;
	let value = table.get(raw);
	if (value === void 0) {
		value = openCodeSessionIdFor(raw);
		table.set(raw, value);
	}
	return value;
};
const withStore = (iterable, store, als) => {
	const iterator = iterable[Symbol.asyncIterator]?.();
	if (!iterator) return iterable;
	const asyncIteratorObj = {
		async next() {
			return als.run(store, async () => iterator.next());
		},
		async return(value) {
			if (typeof iterator.return === "function") try {
				return await iterator.return(value);
			} catch {}
			return {
				done: true,
				value
			};
		},
		async throw(error) {
			if (typeof iterator.throw === "function") return als.run(store, async () => {
				if (typeof iterator.throw === "function") return iterator.throw(error);
				throw error instanceof Error ? error : new Error(String(error));
			});
			throw error instanceof Error ? error : new Error(String(error));
		}
	};
	return { [Symbol.asyncIterator]() {
		return asyncIteratorObj;
	} };
};
const hasSessionHeader = (input, init) => {
	const source = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : void 0);
	if (source === void 0) return false;
	try {
		return new Headers(source).has(SESSION_HEADER);
	} catch {
		return false;
	}
};
/** Determines if a request targets an OpenCode API endpoint. */
const isOpenCodeRequest = (url, state, providers) => {
	if (url.includes("opencode.ai/zen")) return true;
	if (state && providers.has(state.provider)) return true;
	return false;
};
const patchFetch = (original, als, config) => function patchedFetch(input, init) {
	const state = als.getStore();
	let url = "";
	if (typeof input === "string") url = input;
	else if (input && typeof input === "object" && "url" in input) url = String(input.url);
	if (!isOpenCodeRequest(url, state, config.providers)) return original.call(this, input, init);
	const headers = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : void 0));
	if (state) headers.set(SESSION_HEADER, state.value);
	else if (!headers.get("x-opencode-session")?.startsWith("ses_")) headers.set(SESSION_HEADER, process.env.OPENCODE_SESSION_ID ?? openCodeSessionIdFor("default"));
	if (config.injectUserAgent) headers.set("User-Agent", config.userAgent ?? "opencode/1.18.33 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14");
	if (config.injectOriginHeaders) {
		headers.set("x-opencode-client", "cli");
		headers.set("x-opencode-project", "global");
	}
	const newInit = {
		...init,
		headers
	};
	if (config.injectCoreTools && url.includes("/responses") && init?.body) try {
		let bodyStr = null;
		if (typeof init.body === "string") bodyStr = init.body;
		else if (Buffer.isBuffer(init.body)) bodyStr = init.body.toString("utf-8");
		if (bodyStr && bodyStr.length > 0) {
			const bodyObj = JSON.parse(bodyStr);
			if (typeof bodyObj.model === "string" && bodyObj.model.includes("free")) {
				if (!Array.isArray(bodyObj.tools)) bodyObj.tools = [];
				const hasRead = bodyObj.tools.some((t) => t.name === "read");
				const hasBash = bodyObj.tools.some((t) => t.name === "bash");
				if (!hasRead) bodyObj.tools.push(DUMMY_READ_TOOL);
				if (!hasBash) bodyObj.tools.push(DUMMY_BASH_TOOL);
				const newBodyStr = JSON.stringify(bodyObj);
				newInit.body = newBodyStr;
				headers.set("content-length", Buffer.byteLength(newBodyStr).toString());
			}
		}
	} catch {}
	return original.call(this, input, newInit);
};
const apply = (ctx, rawConfig = {}) => {
	const config = resolveConfig(rawConfig);
	const { debug, debugFile, mode, providers } = config;
	const als = new AsyncLocalStorage();
	const uuidBySession = /* @__PURE__ */ new Map();
	const originalFetch = globalThis.fetch;
	if (typeof originalFetch !== "function") {
		ctx.logger?.warn?.("[dsh-opencode] globalThis.fetch is unavailable; cannot inject x-opencode-session");
		return;
	}
	const patched = patchFetch(originalFetch, als, config);
	ctx.effect?.(() => {
		globalThis.fetch = patched;
		ctx.logger?.info?.("[dsh-opencode] active for providers [%s] with mode %s", [...providers].join(", "), mode);
		return () => {
			if (globalThis.fetch === patched) globalThis.fetch = originalFetch;
		};
	}, "dsh-opencode.fetch-patch");
	ctx.on?.("llm/stream", (options, next) => {
		if (!options || typeof options !== "object") return next();
		const { model, provider, sessionId } = options;
		if (!providers.has(String(provider))) return next();
		if (typeof sessionId !== "string" && typeof sessionId !== "number") return next();
		const rawSession = String(sessionId);
		const value = headerValueFor(rawSession, mode, uuidBySession);
		if (value === void 0) return next();
		const downstream = next();
		if (!downstream || typeof downstream[Symbol.asyncIterator] !== "function") return downstream;
		if (debug || debugFile !== void 0) {
			const entry = {
				header: SESSION_HEADER,
				model,
				provider,
				session: rawSession,
				ts: (/* @__PURE__ */ new Date()).toISOString(),
				value
			};
			if (debugFile !== void 0) recordDebug(ctx, debugFile, entry);
			if (debug) ctx.logger?.info?.("[dsh-opencode] streaming provider \"%s\" with %s=%s", String(provider), SESSION_HEADER, value);
		}
		return withStore(downstream, {
			model: typeof model === "string" ? model : void 0,
			provider: String(provider),
			value
		}, als);
	}, { prepend: true });
};
var src_default = {
	apply,
	inject,
	name
};
//#endregion
export { DEFAULT_PROVIDERS, DUMMY_BASH_TOOL, DUMMY_READ_TOOL, OPENCODE_UA, SESSION_HEADER, apply, src_default as default, hasSessionHeader, headerValueFor, inject, isOpenCodeRequest, name, openCodeSessionIdFor, patchFetch, resolveConfig, withStore };
