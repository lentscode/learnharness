import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const ANTIGRAVITY_PROVIDER = "antigravity";

/** One model discovered from `agy acp` for the signed-in account. */
export interface AntigravityDiscoveredModel {
	id: string;
	name: string;
	thinkingLevels: ThinkingLevel[];
}

/** Installation/version check plus account model discovery from `agy acp`. */
export interface AntigravityStatus {
	state: "not-found" | "meets-minimum" | "update-required" | "version-unchecked";
	version: string | null;
	minimumVersion: string;
	authState: "authenticated" | "not-signed-in" | "unchecked" | "error";
	models: AntigravityDiscoveredModel[];
	error?: string;
}

/** 1.5.15 includes ACP stability fixes for cancellation, replay, and subagent wakeups. */
export const ANTIGRAVITY_MINIMUM_VERSION = "1.5.15";
