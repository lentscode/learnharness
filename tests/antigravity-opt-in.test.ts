import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, type TestContext } from "node:test";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-opt-in-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));
const { SETTINGS_FILE } = await import("../config.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { sanitizeUserSettings, providerKeyMissing } = await import("../src/core/settings.ts");
const { parseAntigravitySettingsBody } = await import("../src/server/settings-body.ts");
const { antigravityAvailable, antigravityEnabled } = await import("../src/server/antigravity-config.ts");
const { antigravityInstallationResponse } = await import("../src/server/antigravity.ts");
const { modelCatalog, validateModelsSettings } = await import("../src/server/model-catalog.ts");
const { providerKeyPresent } = await import("../src/server/keys.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { createJobRunner } = await import("../src/agent/subagents/runner.ts");
const { toAntigravityModel } = await import("../src/agent/antigravity/provider.ts");

const SAMPLE_MODELS = [
	{ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["low", "medium", "high", "xhigh"] as const },
	{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", thinkingLevels: ["low", "medium", "high"] as const },
];

function setup(t: TestContext) {
	const previous = readSettings();
	const savedPath = process.env.PATH;
	const dir = mkdtempSync(join(tmpdir(), "agy-opt-in-"));
	writeFileSync(join(dir, process.platform === "win32" ? "agy.exe" : "agy"), "", { mode: 0o755 });
	process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
	t.after(() => {
		if (previous) writeSettings(previous); else rmSync(SETTINGS_FILE, { force: true });
		if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
		rmSync(dir, { recursive: true, force: true });
	});
	writeSettings({ version: 1 });
}

async function save(body: unknown) {
	return PUT(new Request("http://test/api/settings/antigravity", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		{ params: Promise.resolve({ section: "antigravity" }) });
}

test("opt-in parses strictly and malformed stored values never enable Antigravity CLI", () => {
	assert.deepEqual(parseAntigravitySettingsBody({}), { ok: true, settings: {} });
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: true, ignored: true }), { ok: true, settings: { enabled: true } });
	assert.deepEqual(parseAntigravitySettingsBody({ enabled: false }), { ok: true, settings: { enabled: false } });
	for (const raw of [true, null, [], "on", { enabled: "true" }, { enabled: 1 }]) assert.equal(parseAntigravitySettingsBody(raw).ok, false);
	for (const raw of [null, [], true, "on", { enabled: "true" }, { enabled: 1 }]) {
		assert.notEqual(sanitizeUserSettings({ version: 1, antigravity: raw })?.antigravity?.enabled, true);
	}
	assert.equal(sanitizeUserSettings({ version: 1 })?.antigravity, undefined);
});

test("default off even with an installed binary; toggling preserves discovered models, pins, and unrelated settings", async (t) => {
	setup(t);
	const models = { strong: { model: { provider: "antigravity", id: "gemini-4-neon" } } };
	writeSettings({
		version: 1,
		antigravity: { enabled: false, models: SAMPLE_MODELS.map((m) => ({ ...m, thinkingLevels: [...m.thinkingLevels] })) },
		models,
		graph: { enabled: false },
		futureSection: { keep: 1 },
	});
	assert.equal(antigravityEnabled(), false);
	assert.equal(antigravityAvailable(), false);
	assert.equal(providerKeyPresent("antigravity"), false);
	assert(!modelCatalog().models.some((m) => m.provider === "antigravity"));

	assert.equal((await save({ enabled: true })).status, 200);
	assert.equal(antigravityEnabled(), true);
	assert.equal(antigravityAvailable(), true);
	const catalogModels = modelCatalog().models.filter((m) => m.provider === "antigravity");
	assert.equal(catalogModels.length, 2);
	assert.equal(catalogModels[0]!.cost, null);
	assert.equal(catalogModels[0]!.contextWindow, null);

	assert.equal((await save({ enabled: false })).status, 200);
	assert.equal(antigravityAvailable(), false);
	assert(!modelCatalog().models.some((m) => m.provider === "antigravity"));
	assert.equal(readSettings()?.antigravity?.models?.length, 2, "cached discovered models survive opt-out toggle");
	assert.deepEqual(readSettings()?.models, models);
	assert.deepEqual(readSettings()?.graph, { enabled: false });
	assert.deepEqual(readSettings()?.futureSection, { keep: 1 });
	assert.equal(validateModelsSettings(models, models).ok, true);
	assert.equal((await save({ enabled: "true" })).status, 400);
	assert.equal(antigravityEnabled(), false);
});

test("off cannot launch a status/discovery probe even through an authorized HTTP request", async (t) => {
	setup(t);
	const request = new Request("http://test/api/antigravity", { headers: { "x-learnharness-antigravity": "1" } });
	const response = await antigravityInstallationResponse(request, async () => assert.fail("disabled CLI must not execute"));
	assert.equal(response.status, 403);
});

test("a saved Antigravity CLI background job is refused before model execution while opt-in is off", async (t) => {
	setup(t);
	const chat = chatStore.createChat("Antigravity opt-in job fixture");
	t.after(() => { jobStore.deleteJobsForChat(chat.id); chatStore.deleteChat(chat.id); });
	const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "agy-off-job" });
	let calls = 0;
	const model = toAntigravityModel({ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["medium", "high"] });
	const runner = createJobRunner({
		chatStore,
		jobStore,
		deliver: async () => {},
		engineFor: () => ({ model, streamFn: () => { calls++; assert.fail("must not run a disabled CLI model"); } }),
		providerKeyMissing: (provider, tier) => providerKeyPresent(provider) ? null : providerKeyMissing(provider, [tier]),
	});
	await runner.runJob(job.id, { question: "Synthetic fixture only" });
	assert.equal(calls, 0);
	const refused = jobStore.getJob(job.id)!;
	assert.equal(refused.status, "error");
	assert.match(JSON.stringify(refused.result), /Antigravity CLI is unavailable\. Enable and set it up in Settings/);
});
