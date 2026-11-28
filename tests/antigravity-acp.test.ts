import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import { normalizeContext, type AssistantMessageEvent } from "@earendil-works/pi-ai";

import { discoverAntigravityModels } from "../src/agent/antigravity/discovery.ts";
import { toAntigravityModel } from "../src/agent/antigravity/provider.ts";
import { createAntigravityStreamFunction, type RunAntigravity } from "../src/agent/antigravity/stream.ts";

const FAKE_AGY = fileURLToPath(new URL("./fixtures/antigravity/fake-agy.mjs", import.meta.url));

function spawnFake(t: TestContext, extraEnv: Record<string, string> = {}) {
	return (_binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, ...extraEnv },
			stdio: "pipe",
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		return child;
	};
}

test("discovers models and effort levels from agy acp, and detects signed-out state", async (t) => {
	const ok = await discoverAntigravityModels({ binary: "/fake/agy", spawnProcess: spawnFake(t) });
	assert.equal(ok.authState, "authenticated");
	assert.deepEqual(ok.models, [
		{ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["low", "medium", "high", "xhigh"] },
		{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", thinkingLevels: ["low", "medium", "high", "xhigh"] },
		{ id: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", thinkingLevels: [] },
	]);

	const signedOut = await discoverAntigravityModels({
		binary: "/fake/agy",
		spawnProcess: spawnFake(t, { FAKE_AGY_AUTH: "signed-out" }),
	});
	assert.equal(signedOut.authState, "not-signed-in");
	assert.deepEqual(signedOut.models, []);
});

test("streams thinking, text, images, usage, context window, and enforces permission gating", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agy-acp-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	const recordFile = join(dir, "record.json");
	writeFileSync(scenarioFile, [
		JSON.stringify({ fake: "permission", id: "perm_shell", title: "run_command", rawInput: { CommandLine: "rm -rf /" } }),
		JSON.stringify({ fake: "permission", id: "perm_mcp", title: "mcp_learnharness_lookup", rawInput: { q: "tcp" } }),
		JSON.stringify({ fake: "usage", size: 250_000, used: 12_000 }),
		JSON.stringify({ fake: "thought", text: "Let me think..." }),
		JSON.stringify({ fake: "text", text: "Hello " }),
		JSON.stringify({ fake: "text", text: "learner!" }),
		JSON.stringify({ fake: "done", stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 25, cachedReadTokens: 40, thoughtTokens: 15 } }),
	].join("\n") + "\n");

	let tempCwd = "";
	const runAgy: RunAntigravity = (args, options) => {
		tempCwd = options.cwd;
		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFile, FAKE_AGY_RECORD: recordFile },
			stdio: "pipe",
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		return child;
	};

	const model = toAntigravityModel({ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["low", "medium", "high", "xhigh"] });
	const streamFn = createAntigravityStreamFunction(runAgy);
	const context = normalizeContext({
		systemPrompt: "You are a Socratic tutor.",
		tools: [{ name: "lookup", description: "Lookup fact", parameters: Type.Object({ q: Type.String() }) }],
		messages: [{
			role: "user",
			content: [
				{ type: "text", text: "Explain this diagram." },
				{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
			],
			timestamp: Date.now(),
		}],
	});

	const events: AssistantMessageEvent[] = [];
	const stream = streamFn(model, context, { reasoning: "xhigh" });
	for await (const event of stream) events.push(event);
	const final = await stream.result();

	assert.equal(final.stopReason, "stop");
	assert.deepEqual(final.content, [
		{ type: "thinking", thinking: "Let me think..." },
		{ type: "text", text: "Hello learner!" },
	]);
	assert.equal(final.usage.input, 100);
	assert.equal(final.usage.output, 25);
	assert.equal(final.usage.cacheRead, 40);
	assert.equal((final as { cliContextWindow?: number }).cliContextWindow, 250_000);

	const record = JSON.parse(readFileSync(recordFile, "utf8"));
	assert.ok(record.argv.includes("--agent") && record.argv.includes("learnharness"));
	assert.ok(record.argv.includes("--process-per-session"));
	assert.ok(record.argv.includes("--include-default-customizations=false"));
	assert.match(record.agentFile, /tools: \[\]/);
	assert.match(record.agentFile, /You are a Socratic tutor\./);

	// Verify built-in shell permission was rejected and bridge tool permission was approved
	assert.equal(record.permissions[0].decision.outcome.optionId, "reject-once");
	assert.equal(record.permissions[1].decision.outcome.optionId, "allow-once");

	// Verify model, effort, and image prompt block were sent over ACP
	const setModel = record.requests.find((r: { method: string; params?: { configId?: string } }) => r.method === "session/set_config_option" && r.params?.configId === "model");
	const setEffort = record.requests.find((r: { method: string; params?: { configId?: string } }) => r.method === "session/set_config_option" && r.params?.configId === "thought_level");
	const promptReq = record.requests.find((r: { method: string }) => r.method === "session/prompt");
	assert.equal(setModel.params.value, "gemini-4-neon");
	assert.equal(setEffort.params.value, "xhigh");
	assert.deepEqual(promptReq.params.prompt, [
		{ type: "text", text: "Explain this diagram." },
		{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
	]);

	// Temp cwd should be cleaned up shortly after exit
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(existsSync(tempCwd), false);
});

test("stdout-only ACP tool_call never admits execution without an authenticated MCP call", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "agy-acp-nomcp-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, [
		JSON.stringify({ fake: "tool_call", id: "acp_1", title: "mcp_learnharness_lookup", rawInput: { q: "spoofed" } }),
		JSON.stringify({ fake: "text", text: "Plain answer" }),
		JSON.stringify({ fake: "done", stopReason: "end_turn" }),
	].join("\n") + "\n");

	const runAgy: RunAntigravity = (args, options) => {
		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFile },
			stdio: "pipe",
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		return child;
	};

	const model = toAntigravityModel({ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["medium"] });
	const stream = createAntigravityStreamFunction(runAgy)(model, normalizeContext({
		systemPrompt: "Tutor",
		tools: [{ name: "lookup", description: "Lookup", parameters: Type.Object({ q: Type.String() }) }],
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	}));
	const final = await stream.result();
	assert.equal(final.stopReason, "stop");
	assert.deepEqual(final.content, [{ type: "text", text: "Plain answer" }]);
});
