/**
 * Antigravity CLI provider driven through the real chat handler: a learner-facing
 * question ends the turn while the `agy acp` process waits on the held MCP call,
 * and the learner's answer arrives later as that call's tool result.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { after, type TestContext } from "node:test";

import type { RunAntigravity } from "../src/agent/antigravity/stream.ts";
import type { PiEngine } from "../src/agent/models.ts";

const testData = mkdtempSync(join(tmpdir(), "lh-agy-harness-data-"));
process.env.LH_DATA_DIR = testData;
after(() => rmSync(testData, { recursive: true, force: true }));
const { PATHS, SETTINGS_FILE } = await import("../config.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { LIVE_PROCESS_IDLE_TIMEOUT_MS, liveProcessIdleTimeoutMs } = await import("../src/agent/claude-code/live-processes.ts");
const { toAntigravityModel } = await import("../src/agent/antigravity/provider.ts");
const { createAntigravityStreamFunction } = await import("../src/agent/antigravity/stream.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { cliContextWindowOf, danglingQuestionOf } = await import("../src/core/native-messages.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { isTurnRunning } = await import("../src/server/turn-liveness.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");

const FAKE_AGY = fileURLToPath(new URL("./fixtures/antigravity/fake-agy.mjs", import.meta.url));
const TURN_TIMEOUT_MS = 8000;

const ASK_ID = "agy_harness_ask";
const ASK_INPUT = { question: "What do you already know about sockets?" };
const ANSWER_TEXT = "Only that they carry bytes between programs";

const DISCOVERED = [{ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["low", "medium", "high", "xhigh"] as const }];

type FakeRun = { runAgy: RunAntigravity; children: ChildProcessWithoutNullStreams[]; recordFiles: string[] };

function toAskScenario(): string[] {
	return [
		JSON.stringify({ fake: "usage", size: 200_000 }),
		JSON.stringify({ fake: "tool_call", id: ASK_ID, title: "mcp_learnharness_ask_user_question", rawInput: ASK_INPUT }),
		JSON.stringify({ fake: "call", id: ASK_ID, name: "ask_user_question", arguments: ASK_INPUT }),
		JSON.stringify({ fake: "reply" }),
	];
}

function createFakeRun(t: TestContext, scenarios: string[][]): FakeRun {
	const settings = readSettings();
	writeSettings({
		...(settings ?? { version: 1 }),
		antigravity: { enabled: true, models: DISCOVERED.map((m) => ({ ...m, thinkingLevels: [...m.thinkingLevels] })) },
	});
	t.after(() => { if (settings) writeSettings(settings); else rmSync(SETTINGS_FILE, { force: true }); });
	const dir = mkdtempSync(join(tmpdir(), "agy-harness-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, process.platform === "win32" ? "agy.exe" : "agy"), "", { mode: 0o755 });
	const savedPath = process.env.PATH;
	process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
	t.after(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; });

	const children: ChildProcessWithoutNullStreams[] = [];
	const recordFiles: string[] = [];

	const runAgy: RunAntigravity = (args, options) => {
		const scenario = scenarios[children.length];
		assert.ok(scenario, `unexpected spawn #${children.length + 1}`);

		const scenarioFile = join(dir, `scenario-${children.length}.jsonl`);
		const recordFile = join(dir, `record-${children.length}.json`);
		writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);

		const child = spawn(process.execPath, [FAKE_AGY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_AGY_SCENARIO: scenarioFile, FAKE_AGY_RECORD: recordFile },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));

		children.push(child);
		recordFiles.push(recordFile);
		return child;
	};

	return { runAgy, children, recordFiles };
}

function createAntigravityChat(t: TestContext): string {
	const chat = chatStore.createChat("Antigravity: question answered later");
	chatStore.saveSettings(chat.id, { model: { provider: "antigravity", id: "gemini-4-neon" } });
	t.after(() => unlinkSync(join(PATHS.chats, `${chat.id}.json`)));
	return chat.id;
}

function createAgentFactory(fakeRun: FakeRun): Parameters<typeof handleChatRequest>[1] {
	const model = toAntigravityModel({ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevels: ["low", "medium", "high", "xhigh"] });
	const engine: PiEngine = { model, streamFn: createAntigravityStreamFunction(fakeRun.runAgy) };
	return (options) => createTeacherAgent(undefined, { engine, chatId: options.chatId, messages: options.messages });
}

async function runChatTurn(chatId: string, input: object, agentFactory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const request = new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
	const ack = await handleChatRequest(request, agentFactory);
	assert.equal(ack.status, 200, await ack.clone().text());

	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();

	const deadline = Date.now() + TURN_TIMEOUT_MS;
	while (isTurnRunning(chatId)) {
		assert.ok(Date.now() < deadline, "turn did not settle");
		await sleep(10);
	}
}

function toAnswerInput(): object {
	return {
		type: "answer",
		toolCallId: ASK_ID,
		answer: { kind: "ask", questionText: ASK_INPUT.question, dontKnow: false, answers: [], text: ANSWER_TEXT, answeredAt: new Date().toISOString() },
	};
}

function getLastAssistantText(chatId: string): string {
	const messages = chatStore.getChat(chatId)?.messages ?? [];
	const assistant = messages.findLast((message) => message.role === "assistant");
	assert.ok(assistant?.role === "assistant");
	return assistant.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit", { signal: AbortSignal.timeout(TURN_TIMEOUT_MS) });
}

test("disabled opt-in refuses a saved Antigravity chat before write-ahead or agent creation", async (t) => {
	const fakeRun = createFakeRun(t, [toAskScenario()]);
	const chatId = createAntigravityChat(t);
	writeSettings({ ...(readSettings() ?? { version: 1 }), antigravity: { enabled: false } });
	const before = chatStore.getChat(chatId)!.messages;
	const response = await handleChatRequest(new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text: "must not start" } }),
	}), () => assert.fail("disabled work must not build an agent"));
	assert.equal(response.status, 503);
	assert.match((await response.json()).error, /Antigravity CLI is unavailable/);
	assert.equal(isTurnRunning(chatId), false);
	assert.equal(fakeRun.children.length, 0);
	assert.deepEqual(chatStore.getChat(chatId)!.messages, before);
});

test("a question answered before the idle timeout continues the waiting agy acp process", async (t) => {
	const fakeRun = createFakeRun(t, [toAskScenario()]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createAntigravityChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, agentFactory);

	assert.equal(danglingQuestionOf(chatStore.getChat(chatId)?.messages ?? [])?.toolCallId, ASK_ID);
	const [waiting] = fakeRun.children;
	assert.ok(waiting);
	assert.equal(waiting.exitCode, null, "agy acp process should wait on the held question call");

	await runChatTurn(chatId, toAnswerInput(), agentFactory);

	assert.equal(fakeRun.children.length, 1);
	assert.deepEqual(cliContextWindowOf(chatStore.getChat(chatId)!.messages), { model: "antigravity:gemini-4-neon", tokens: 200_000 });
	assert.ok(getLastAssistantText(chatId).includes(ANSWER_TEXT), getLastAssistantText(chatId));
	await waitForExit(waiting);
});

test("a question answered after idle timeout starts a fresh agy acp process with replayed history", async (t) => {
	liveProcessIdleTimeoutMs.current = 300;
	t.after(() => { liveProcessIdleTimeoutMs.current = LIVE_PROCESS_IDLE_TIMEOUT_MS; });

	const fakeRun = createFakeRun(t, [
		toAskScenario(),
		[JSON.stringify({ fake: "text", text: "hello there" }), JSON.stringify({ fake: "done" })],
	]);
	const agentFactory = createAgentFactory(fakeRun);
	const chatId = createAntigravityChat(t);

	await runChatTurn(chatId, { type: "text", text: "teach me sockets" }, agentFactory);
	const [waiting] = fakeRun.children;
	assert.ok(waiting);
	await waitForExit(waiting);

	await runChatTurn(chatId, toAnswerInput(), agentFactory);

	assert.equal(fakeRun.children.length, 2);
	assert.equal(getLastAssistantText(chatId), "hello there");

	const secondRecord = JSON.parse(readFileSync(fakeRun.recordFiles[1]!, "utf8"));
	const promptReq = secondRecord.requests.find((r: { method: string }) => r.method === "session/prompt");
	const promptText = promptReq.params.prompt.map((b: { text?: string }) => b.text ?? "").join("\n");
	assert.ok(promptText.includes("[tool call ask_user_question]"), promptText);
	assert.ok(promptText.includes(ASK_INPUT.question), promptText);
	assert.ok(promptText.includes("[tool result ask_user_question]"), promptText);
	assert.ok(promptText.includes(ANSWER_TEXT), promptText);
});
