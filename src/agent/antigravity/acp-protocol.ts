import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { JsonObject, Usage } from "@earendil-works/pi-ai";
import type { AntigravityDiscoveredModel } from "../../core/contracts/antigravity.ts";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_AUTH_REQUIRED_CODE = -32000;

export type AcpPromptBlock =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string };

export type AcpHttpMcpServer = {
	type: "http";
	name: string;
	url: string;
	headers: { name: string; value: string }[];
};

export type AcpUsage = Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning">>;

export type AcpToolCallInfo = {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: JsonObject;
};

export type AcpPermissionOption = {
	optionId: string;
	name?: string;
	kind?: string;
};

export type AcpSessionUpdate =
	| { type: "textDelta"; text: string }
	| { type: "thinkingDelta"; thinking: string }
	| { type: "toolCall"; toolCall: AcpToolCallInfo }
	| { type: "toolCallUpdate"; toolCall: AcpToolCallInfo }
	| { type: "usageUpdate"; contextWindow?: number; usedTokens?: number; usage?: AcpUsage };

export type AcpIncomingMessage =
	| { type: "response"; id: number; result?: unknown; error?: { code?: number; message?: string } }
	| { type: "sessionUpdate"; sessionId: string; update: AcpSessionUpdate }
	| { type: "permissionRequest"; id: number | string; sessionId: string; toolCall: AcpToolCallInfo; options: AcpPermissionOption[] };

export type AcpConfigOptionValue = {
	value: string;
	name: string;
};

export type AcpConfigOption = {
	id: string;
	category?: string;
	name?: string;
	currentValue?: string;
	options: AcpConfigOptionValue[];
};

export type AcpSessionSetup = {
	sessionId: string;
	modelConfigId?: string;
	thoughtConfigId?: string;
	thoughtOptionValues: Map<ThinkingLevel, string>;
	models: AntigravityDiscoveredModel[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function acpInitializeRequest(id: number): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "initialize",
		params: {
			protocolVersion: ACP_PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: "learnharness", version: "1.0.0" },
		},
	});
}

export function acpNewSessionRequest(id: number, cwd: string, mcpServers: readonly AcpHttpMcpServer[] = []): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "session/new",
		params: { cwd, mcpServers },
	});
}

export function acpSetConfigOptionRequest(id: number, sessionId: string, configId: string, value: string): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "session/set_config_option",
		params: { sessionId, configId, value },
	});
}

export function acpSetModelRequest(id: number, sessionId: string, modelId: string): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "session/set_model",
		params: { sessionId, modelId },
	});
}

export function acpPromptRequest(id: number, sessionId: string, prompt: AcpPromptBlock[]): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "session/prompt",
		params: { sessionId, prompt },
	});
}

export function acpCancelNotification(sessionId: string): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		method: "session/cancel",
		params: { sessionId },
	});
}

export function acpPermissionResponse(id: number | string, optionId: string | null): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: {
			outcome: optionId !== null
				? { outcome: "selected", optionId }
				: { outcome: "cancelled" },
		},
	});
}

const EFFORT_ORDER: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

export function normalizeThoughtLevel(raw: string): ThinkingLevel | null {
	const value = raw.trim().toLowerCase();
	switch (value) {
		case "low":
			return "low";
		case "medium":
		case "med":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
		case "extra":
		case "extra_high":
		case "extra-high":
		case "extra high":
			return "xhigh";
		case "max":
			return "max";
		default:
			return null;
	}
}

function parseOptionList(raw: unknown): AcpConfigOptionValue[] {
	if (!Array.isArray(raw)) return [];
	const out: AcpConfigOptionValue[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		// ACP configOptions can be flat options or grouped ({ group, options: [...] }).
		if (Array.isArray(entry.options)) {
			out.push(...parseOptionList(entry.options));
			continue;
		}
		if (typeof entry.value !== "string" || !entry.value.trim()) continue;
		const value = entry.value.trim();
		const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : value;
		out.push({ value, name });
	}
	return out;
}

export function parseConfigOptions(raw: unknown): AcpConfigOption[] {
	if (!Array.isArray(raw)) return [];
	const out: AcpConfigOption[] = [];
	for (const entry of raw) {
		if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) continue;
		out.push({
			id: entry.id.trim(),
			category: typeof entry.category === "string" ? entry.category : undefined,
			name: typeof entry.name === "string" ? entry.name : undefined,
			currentValue: typeof entry.currentValue === "string" ? entry.currentValue : undefined,
			options: parseOptionList(entry.options),
		});
	}
	return out;
}

export function findThoughtConfig(configOptions: readonly AcpConfigOption[]): {
	configId?: string;
	optionValues: Map<ThinkingLevel, string>;
	levels: ThinkingLevel[];
} {
	const thoughtOpt = configOptions.find((opt) =>
		opt.category === "thought_level"
		|| opt.id === "thought_level"
		|| opt.id === "reasoning_effort"
		|| opt.id === "thinking_level"
		|| opt.id === "effort",
	);
	const optionValues = new Map<ThinkingLevel, string>();
	if (thoughtOpt) {
		for (const item of thoughtOpt.options) {
			const level = normalizeThoughtLevel(item.value) ?? normalizeThoughtLevel(item.name);
			if (level && !optionValues.has(level)) optionValues.set(level, item.value);
		}
	}
	const levels = EFFORT_ORDER.filter((level) => optionValues.has(level));
	return { configId: thoughtOpt?.id, optionValues, levels };
}

function isFixedEffortModel(id: string, name: string): boolean {
	const lowerId = id.toLowerCase();
	const lowerName = name.toLowerCase();
	if (lowerId.includes("orchestrator") || lowerName.includes("orchestrator")) return true;
	return /-(?:low|medium|high|xhigh|max)$/.test(lowerId);
}

/** Extract session ID, configOption ids, effort mappings, and available models from `session/new`. */
export function parseSessionSetup(result: unknown): AcpSessionSetup | null {
	if (!isRecord(result) || typeof result.sessionId !== "string" || !result.sessionId.trim()) return null;

	const configOptions = parseConfigOptions(result.configOptions);
	const modelOpt = configOptions.find((opt) => opt.category === "model" || opt.id === "model");
	const thought = findThoughtConfig(configOptions);

	const byId = new Map<string, AntigravityDiscoveredModel>();
	const addModel = (id: string, name: string) => {
		const trimmedId = id.trim();
		if (!trimmedId || byId.has(trimmedId)) return;
		const trimmedName = name.trim() || trimmedId;
		const thinkingLevels = isFixedEffortModel(trimmedId, trimmedName) ? [] : [...thought.levels];
		byId.set(trimmedId, { id: trimmedId, name: trimmedName, thinkingLevels });
	};

	if (modelOpt) {
		for (const option of modelOpt.options) addModel(option.value, option.name);
	}
	if (isRecord(result.models) && Array.isArray(result.models.availableModels)) {
		for (const entry of result.models.availableModels) {
			if (!isRecord(entry)) continue;
			const id = typeof entry.modelId === "string" ? entry.modelId : typeof entry.id === "string" ? entry.id : "";
			const name = typeof entry.name === "string" ? entry.name : id;
			if (id) addModel(id, name);
		}
	}

	return {
		sessionId: result.sessionId.trim(),
		modelConfigId: modelOpt?.id,
		thoughtConfigId: thought.configId,
		thoughtOptionValues: thought.optionValues,
		models: [...byId.values()],
	};
}

export function extractAcpUsage(raw: unknown): AcpUsage {
	if (!isRecord(raw)) return {};
	const usage: AcpUsage = {};
	const num = (...keys: string[]): number | undefined => {
		for (const key of keys) {
			const value = raw[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
		}
		return undefined;
	};
	const input = num("inputTokens", "input_tokens");
	const output = num("outputTokens", "output_tokens");
	const cacheRead = num("cachedReadTokens", "cacheReadTokens", "cache_read_tokens", "cache_read_input_tokens");
	const cacheWrite = num("cachedWriteTokens", "cacheWriteTokens", "cache_write_tokens", "cache_creation_input_tokens");
	const reasoning = num("thoughtTokens", "thinkingTokens", "thinking_tokens", "reasoningTokens");
	if (input !== undefined) usage.input = input;
	if (output !== undefined) usage.output = output;
	if (cacheRead !== undefined) usage.cacheRead = cacheRead;
	if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
	if (reasoning !== undefined) usage.reasoning = reasoning;
	return usage;
}

function parseToolCallInfo(raw: unknown): AcpToolCallInfo | null {
	if (!isRecord(raw) || typeof raw.toolCallId !== "string" || !raw.toolCallId.trim()) return null;
	return {
		toolCallId: raw.toolCallId,
		title: typeof raw.title === "string" ? raw.title : undefined,
		kind: typeof raw.kind === "string" ? raw.kind : undefined,
		status: typeof raw.status === "string" ? raw.status : undefined,
		rawInput: isRecord(raw.rawInput) ? (raw.rawInput as JsonObject) : undefined,
	};
}

function parseSessionUpdate(raw: unknown): AcpSessionUpdate | null {
	if (!isRecord(raw) || typeof raw.sessionUpdate !== "string") return null;
	switch (raw.sessionUpdate) {
		case "agent_message_chunk": {
			const content = raw.content;
			if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
				return { type: "textDelta", text: content.text };
			}
			return null;
		}
		case "agent_thought_chunk": {
			const content = raw.content;
			if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
				return { type: "thinkingDelta", thinking: content.text };
			}
			return null;
		}
		case "tool_call": {
			const toolCall = parseToolCallInfo(raw);
			return toolCall ? { type: "toolCall", toolCall } : null;
		}
		case "tool_call_update": {
			const toolCall = parseToolCallInfo(raw);
			return toolCall ? { type: "toolCallUpdate", toolCall } : null;
		}
		case "usage_update": {
			const size = typeof raw.size === "number" && Number.isSafeInteger(raw.size) && raw.size > 0 ? raw.size : undefined;
			const used = typeof raw.used === "number" && Number.isSafeInteger(raw.used) && raw.used >= 0 ? raw.used : undefined;
			const usage = extractAcpUsage(isRecord(raw.usage) ? raw.usage : raw);
			return { type: "usageUpdate", contextWindow: size, usedTokens: used, usage: Object.keys(usage).length ? usage : undefined };
		}
		default:
			return null;
	}
}

export function parseAcpLine(line: string): AcpIncomingMessage | null {
	const parsed = JSON.parse(line) as unknown;
	if (!isRecord(parsed)) return null;

	// JSON-RPC response (has id and either result or error, and no method)
	if (typeof parsed.id === "number" && typeof parsed.method !== "string") {
		const error = isRecord(parsed.error)
			? {
				code: typeof parsed.error.code === "number" ? parsed.error.code : undefined,
				message: typeof parsed.error.message === "string" ? parsed.error.message : undefined,
			}
			: undefined;
		return { type: "response", id: parsed.id, result: parsed.result, error };
	}

	// Notification: session/update
	if (parsed.method === "session/update" && isRecord(parsed.params)) {
		const sessionId = typeof parsed.params.sessionId === "string" ? parsed.params.sessionId : "";
		const update = parseSessionUpdate(parsed.params.update);
		return update ? { type: "sessionUpdate", sessionId, update } : null;
	}

	// Agent → client request: session/request_permission
	if (parsed.method === "session/request_permission" && (typeof parsed.id === "number" || typeof parsed.id === "string") && isRecord(parsed.params)) {
		const sessionId = typeof parsed.params.sessionId === "string" ? parsed.params.sessionId : "";
		const toolCall = parseToolCallInfo(parsed.params.toolCall) ?? { toolCallId: "" };
		const options: AcpPermissionOption[] = Array.isArray(parsed.params.options)
			? parsed.params.options.flatMap((entry): AcpPermissionOption[] => {
				if (!isRecord(entry) || typeof entry.optionId !== "string") return [];
				return [{
					optionId: entry.optionId,
					name: typeof entry.name === "string" ? entry.name : undefined,
					kind: typeof entry.kind === "string" ? entry.kind : undefined,
				}];
			})
			: [];
		return { type: "permissionRequest", id: parsed.id, sessionId, toolCall, options };
	}

	return null;
}

/** Resolve a bridge tool name from an ACP tool title/name when it explicitly targets the bridge server. */
export function extractBridgeToolName(title: string | undefined, serverName: string, declaredTools: ReadonlySet<string>): string | null {
	if (!title) return null;
	const trimmed = title.trim();
	const prefixes = [
		`mcp_${serverName}_`,
		`mcp__${serverName}__`,
		`${serverName}/`,
		`${serverName}:`,
		`${serverName}.`,
	];
	for (const prefix of prefixes) {
		if (trimmed.startsWith(prefix)) {
			const candidate = trimmed.slice(prefix.length).trim();
			if (declaredTools.has(candidate)) return candidate;
		}
	}
	// Some ACP surfaces format titles as "mcp: learnharness/tool" or "learnharness / tool (args)".
	const match = new RegExp(`(?:^|\\b)(?:mcp_)?${serverName}(?:__|_|\\s*[/:.]\\s*)([A-Za-z0-9_.-]+)`).exec(trimmed);
	if (match?.[1] && declaredTools.has(match[1])) return match[1];
	return null;
}

export function selectPermissionOption(options: readonly AcpPermissionOption[], allow: boolean): string | null {
	if (allow) {
		return options.find((opt) => opt.kind === "allow_once")?.optionId
			?? options.find((opt) => opt.kind === "allow_always")?.optionId
			?? options.find((opt) => /\ballow\b/i.test(opt.name ?? ""))?.optionId
			?? null;
	}
	return options.find((opt) => opt.kind === "reject_once")?.optionId
		?? options.find((opt) => opt.kind === "reject_always")?.optionId
		?? options.find((opt) => /\b(deny|reject)\b/i.test(opt.name ?? ""))?.optionId
		?? null;
}

export function isAuthRequiredError(error: { code?: number; message?: string } | undefined): boolean {
	if (!error) return false;
	if (error.code === ACP_AUTH_REQUIRED_CODE) return true;
	return typeof error.message === "string" && /authentication required|please sign in|not authenticated|unauthenticated/i.test(error.message);
}
