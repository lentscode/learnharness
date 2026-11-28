import { discoverAntigravityModels, type AntigravityDiscoveryResult } from "../agent/antigravity/discovery.ts";
import { inspectAntigravityInstallation, type AntigravityInstallation } from "../agent/antigravity/installation.ts";
import type { AntigravityDiscoveredModel, AntigravityStatus } from "../core/contracts/antigravity.ts";
import { settingsStore } from "../store/settings.ts";
import { antigravityEnabled, syncAntigravityProvider } from "./antigravity-config.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

function persistDiscoveredModels(models: AntigravityDiscoveredModel[]): void {
	const current = settingsStore.readSettings() ?? { version: 1 };
	// Preserve current enabled state and every unrelated section.
	if (current.antigravity?.enabled !== true) return;
	settingsStore.writeSettings({
		...current,
		antigravity: { ...current.antigravity, models },
	});
	syncAntigravityProvider();
}

/** The Settings status seam: checks binary/version and, when meets-minimum, probes `agy acp` for models. */
export async function antigravityInstallationStatus({
	inspect = inspectAntigravityInstallation,
	discover = () => discoverAntigravityModels(),
	saveModels = persistDiscoveredModels,
}: {
	inspect?: () => Promise<AntigravityInstallation>;
	discover?: () => Promise<AntigravityDiscoveryResult>;
	saveModels?: (models: AntigravityDiscoveredModel[]) => void;
} = {}): Promise<AntigravityStatus> {
	initAuthEnv();
	const installation = await inspect();
	if (installation.state !== "meets-minimum") {
		return { ...installation, authState: "unchecked", models: [] };
	}
	const discovery = await discover();
	if (discovery.authState === "authenticated") {
		saveModels(discovery.models);
	}
	return { ...installation, ...discovery };
}

/** Same-origin browser intent, not user authentication. No CORS grants.
 * A public/shared server still requires its own access-control boundary. */
export async function antigravityInstallationResponse(
	request: Request,
	inspect: () => Promise<AntigravityStatus> = () => antigravityInstallationStatus(),
	enabled = antigravityEnabled,
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (request.method !== "GET" || !origin
		|| request.headers.get("x-learnharness-antigravity") !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)) {
		return Response.json({ error: "Antigravity CLI checks require a same-origin LearnHarness request." }, { status: 403, headers });
	}
	if (!enabled()) return Response.json({ error: "Antigravity CLI is disabled." }, { status: 403, headers });
	return Response.json(await inspect(), { headers });
}
