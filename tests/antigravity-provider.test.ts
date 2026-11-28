import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel, createAssistantMessageEventStream, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_PROVIDER } from "../src/agent/antigravity/constants.ts";
import { createAntigravityProvider } from "../src/agent/antigravity/provider.ts";

test("builds models dynamically from discovered account models with per-model thinking levels", async () => {
	const collection = createModels();
	collection.setProvider(createAntigravityProvider(() => createAssistantMessageEventStream(), [
		{ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["low", "medium", "high", "xhigh"] },
		{ id: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", thinkingLevels: [] },
	]));

	const models = collection.getModels(ANTIGRAVITY_PROVIDER);
	assert.deepEqual(models.map((m) => m.id), ["gemini-4-neon", "gemini-pro-orchestrator"]);

	const neon = models[0]!;
	assert.deepEqual(neon.input, ["text", "image"]);
	assert.deepEqual(neon.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(getSupportedThinkingLevels(neon), ["low", "medium", "high", "xhigh"]);
	assert.equal(clampThinkingLevel(neon, "off"), "low");
	assert.equal(clampThinkingLevel(neon, "max"), "xhigh");

	const orchestrator = models[1]!;
	assert.equal(orchestrator.reasoning, false);
	assert.deepEqual(getSupportedThinkingLevels(orchestrator), ["off"]);

	assert.ok(await collection.checkAuth(ANTIGRAVITY_PROVIDER));
	assert.equal((await collection.getAvailable(ANTIGRAVITY_PROVIDER)).length, 2);
});
