import { createProvider, type Api, type Model, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AntigravityDiscoveredModel } from "../../core/contracts/antigravity.ts";
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";

const ALL_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function buildThinkingLevelMap(levels: readonly ThinkingLevel[]): Model<Api>["thinkingLevelMap"] {
	const supported = new Set(levels);
	const map: Record<string, string | null> = {};
	for (const level of ALL_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map as Model<Api>["thinkingLevelMap"];
}

export function toAntigravityModel(discovered: AntigravityDiscoveredModel): Model<Api> {
	const hasReasoning = discovered.thinkingLevels.length > 0;
	return {
		id: discovered.id,
		name: discovered.name,
		api: ANTIGRAVITY_API,
		provider: ANTIGRAVITY_PROVIDER,
		baseUrl: "",
		input: ["text", "image"],
		// Pi-required placeholders, not prices: the CLI's own auth/routing
		// determines charges. Server pricing and the client catalog report unpriced.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: hasReasoning,
		...(hasReasoning ? { thinkingLevelMap: buildThinkingLevelMap(discovered.thinkingLevels) } : {}),
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

export function createAntigravityProvider(
	streamSimple: StreamFunction<Api, SimpleStreamOptions>,
	models: readonly AntigravityDiscoveredModel[],
): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity CLI",
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		models: models.map(toAntigravityModel),
		api: { stream: streamSimple, streamSimple },
	});
}
