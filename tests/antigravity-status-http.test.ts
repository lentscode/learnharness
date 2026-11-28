import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTIGRAVITY_MINIMUM_VERSION, type AntigravityStatus } from "../src/core/contracts/antigravity.ts";
import { antigravityInstallationResponse as respond, antigravityInstallationStatus } from "../src/server/antigravity.ts";

const antigravityInstallationResponse: typeof respond = (request, inspect) => respond(request, inspect, () => true);

function request(headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/antigravity", { headers: { "x-learnharness-antigravity": "1", ...headers } });
}

const status: AntigravityStatus = {
	state: "not-found",
	version: null,
	minimumVersion: ANTIGRAVITY_MINIMUM_VERSION,
	authState: "unchecked",
	models: [],
};

for (const headers of [
	{ origin: "https://attacker.invalid" },
	{ "sec-fetch-site": "cross-site" },
	{ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
	{ origin: "null" },
	{ "x-learnharness-antigravity": "" },
] as Record<string, string>[]) test(`unsafe status request ${JSON.stringify(headers)} never invokes the probe`, async () => {
	let probes = 0;
	const response = await antigravityInstallationResponse(request(headers), async () => { probes++; return status; });
	assert.equal(response.status, 403);
	assert.equal(probes, 0);
	assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("disabled opt-in never starts a probe", async () => {
	let probes = 0;
	const response = await respond(request(), async () => { probes++; return status; }, () => false);
	assert.equal(response.status, 403);
	assert.equal(probes, 0);
});

test("ordinary GET without intent header cannot start a probe", async () => {
	const response = await antigravityInstallationResponse(new Request("http://localhost:3000/api/antigravity"), async () => assert.fail("must not probe"));
	assert.equal(response.status, 403);
});

for (const headers of [{}, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }] as Record<string, string>[]) test(`legitimate Providers GET ${JSON.stringify(headers)} succeeds`, async () => {
	let probes = 0;
	const response = await antigravityInstallationResponse(request(headers), async () => { probes++; return status; });
	assert.equal(response.status, 200);
	assert.equal(probes, 1);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), status);
});

test("antigravityInstallationStatus probes and saves models only when meets-minimum and authenticated", async () => {
	const saved: unknown[] = [];
	const models = [{ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["medium", "high"] as const }];
	const authed = await antigravityInstallationStatus({
		inspect: async () => ({ state: "meets-minimum", version: "1.5.16", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION }),
		discover: async () => ({ authState: "authenticated", models: models.map((m) => ({ ...m, thinkingLevels: [...m.thinkingLevels] })) }),
		saveModels: (list) => saved.push(list),
	});
	assert.equal(authed.authState, "authenticated");
	assert.equal(authed.models.length, 1);
	assert.equal(saved.length, 1);

	const outdated = await antigravityInstallationStatus({
		inspect: async () => ({ state: "update-required", version: "1.5.10", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION }),
		discover: async () => assert.fail("must not discover on outdated CLI"),
		saveModels: () => assert.fail("must not save on outdated CLI"),
	});
	assert.equal(outdated.authState, "unchecked");
	assert.deepEqual(outdated.models, []);
});
