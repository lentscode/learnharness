import { getAntigravityBinary } from "../agent/antigravity/binary.ts";
import { ANTIGRAVITY_PROVIDER } from "../agent/antigravity/constants.ts";
import { createAntigravityProvider } from "../agent/antigravity/provider.ts";
import { streamAntigravity } from "../agent/antigravity/stream.ts";
import { piModels, registerProviderSource } from "../agent/models.ts";
import type { AntigravityDiscoveredModel } from "../core/contracts/antigravity.ts";
import { settingsStore } from "../store/settings.ts";

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function antigravityEnabled(): boolean {
	return settingsStore.readSettings()?.antigravity?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function antigravityAvailable(): boolean {
	return antigravityEnabled() && getAntigravityBinary() !== null;
}

export function antigravityDiscoveredModels(): AntigravityDiscoveredModel[] {
	return settingsStore.readSettings()?.antigravity?.models ?? [];
}

/** Sync the dynamic Antigravity CLI model list from settings into piModels(). */
export function installAntigravityProviderSource(): void {
	let fingerprint: string | undefined;
	registerProviderSource("antigravity", {
		isCustom: (id) => id === ANTIGRAVITY_PROVIDER,
		sync(models) {
			const discovered = antigravityDiscoveredModels();
			const next = JSON.stringify(discovered);
			if (next === fingerprint && models.getProvider(ANTIGRAVITY_PROVIDER)) return;
			models.setProvider(createAntigravityProvider(streamAntigravity, discovered));
			fingerprint = next;
		},
	});
}

export function syncAntigravityProvider(): void {
	piModels();
}
