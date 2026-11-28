/**
 * Stand-in for `agy acp` in tests. Speaks ACP JSON-RPC 2.0 over stdin/stdout,
 * connects to the MCP bridge registered in session/new when executing MCP directives, and
 * records received requests/permissions to FAKE_AGY_RECORD when set.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { on } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const parentMessages = on(process, "message");
const BRIDGE_SERVER_NAME = "learnharness";
const SESSION_ID = "acp-session-1";

const recorded = {
	argv: process.argv.slice(2),
	cwd: process.cwd(),
	agentFile: existsSync(join(process.cwd(), ".agents", "agents", "learnharness", "agent.md"))
		? readFileSync(join(process.cwd(), ".agents", "agents", "learnharness", "agent.md"), "utf8")
		: null,
	mcpConfig: existsSync(join(process.cwd(), ".agents", "mcp_config.json"))
		? readFileSync(join(process.cwd(), ".agents", "mcp_config.json"), "utf8")
		: null,
	requests: [],
	permissions: [],
	cancelled: false,
};

function flushRecord() {
	if (process.env.FAKE_AGY_RECORD) {
		writeFileSync(process.env.FAKE_AGY_RECORD, JSON.stringify(recorded, null, 2));
	}
}

function writeJson(obj) {
	return new Promise((resolve) => process.stdout.write(`${JSON.stringify(obj)}\n`, resolve));
}

let lastSend = Promise.resolve();
let bridgeServer;
async function connectBridge() {
	if (bridgeServer?.type !== "http") throw new Error("LearnHarness MCP bridge was not registered in session/new");
	const headers = Object.fromEntries(bridgeServer.headers.map(({ name, value }) => [name, value]));
	const client = new Client({ name: "fake-agy", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(bridgeServer.url), { requestInit: { headers } });
	const send = transport.send.bind(transport);
	transport.send = (...args) => (lastSend = send(...args));
	await client.connect(transport);
	return client;
}

const pendingPermissions = new Map();
let nextServerReqId = 1000;

function requestPermission(toolCall) {
	const id = nextServerReqId++;
	return new Promise((resolve) => {
		pendingPermissions.set(id, resolve);
		void writeJson({
			jsonrpc: "2.0",
			id,
			method: "session/request_permission",
			params: {
				sessionId: SESSION_ID,
				toolCall,
				options: [
					{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
					{ optionId: "reject-once", name: "Reject once", kind: "reject_once" },
				],
			},
		});
	});
}

function defaultSessionNewResult() {
	const models = process.env.FAKE_AGY_MODELS
		? JSON.parse(process.env.FAKE_AGY_MODELS)
		: [
			{ value: "gemini-4-neon", name: "Gemini 4 Neon" },
			{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
			{ value: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
		];
	const efforts = process.env.FAKE_AGY_EFFORTS
		? JSON.parse(process.env.FAKE_AGY_EFFORTS)
		: [
			{ value: "low", name: "Low" },
			{ value: "medium", name: "Medium" },
			{ value: "high", name: "High" },
			{ value: "xhigh", name: "Extra" },
		];
	return {
		sessionId: SESSION_ID,
		configOptions: [
			{ id: "model", category: "model", name: "Model", currentValue: models[0]?.value, options: models },
			{ id: "thought_level", category: "thought_level", name: "Thinking level", currentValue: "medium", options: efforts },
		],
		models: {
			currentModelId: models[0]?.value,
			availableModels: models.map((m) => ({ modelId: m.value, name: m.name })),
		},
	};
}

let bridge = null;
const results = [];
const pendingResults = [];
const controllers = new Map();
const cancelled = new Set();

async function runScenario(promptReqId) {
	const scenarioPath = process.env.FAKE_AGY_SCENARIO;
	const lines = scenarioPath ? readFileSync(scenarioPath, "utf8").split("\n").filter(Boolean) : [];
	let completed = false;
	for (const line of lines) {
		const directive = JSON.parse(line);
		if (directive.fake === "thought") {
			await writeJson({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId: SESSION_ID, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: directive.text } } },
			});
			continue;
		}
		if (directive.fake === "text") {
			await writeJson({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId: SESSION_ID, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: directive.text } } },
			});
			continue;
		}
		if (directive.fake === "usage") {
			await writeJson({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: SESSION_ID,
					update: {
						sessionUpdate: "usage_update",
						...(directive.size !== undefined ? { size: directive.size } : {}),
						...(directive.used !== undefined ? { used: directive.used } : {}),
						...(directive.usage ? { usage: directive.usage } : {}),
					},
				},
			});
			continue;
		}
		if (directive.fake === "tool_call") {
			await writeJson({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: SESSION_ID,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: directive.id,
						title: directive.title,
						status: "in_progress",
						rawInput: directive.rawInput,
					},
				},
			});
			continue;
		}
		if (directive.fake === "permission") {
			const decision = await requestPermission({
				toolCallId: directive.id,
				title: directive.title,
				rawInput: directive.rawInput,
			});
			recorded.permissions.push({ id: directive.id, title: directive.title, decision });
			flushRecord();
			continue;
		}
		if (directive.fake === "call" || directive.fake === "start-call") {
			bridge ??= await connectBridge();
			const controller = new AbortController();
			if (directive.id) controllers.set(directive.id, controller);
			const req = bridge.callTool({
				name: directive.name,
				arguments: directive.arguments,
				...(directive.metaId ? { _meta: { "antigravity/toolCallId": directive.metaId } } : {}),
			}, undefined, { signal: controller.signal });
			if (directive.fake === "start-call") {
				pendingResults.push({ id: directive.id, request: req });
				void req.catch(() => {});
				await lastSend;
			} else {
				const res = await req;
				results.push(res.content.map((block) => block.text ?? "[image]").join(""));
			}
			continue;
		}
		if (directive.fake === "cancel-call") {
			cancelled.add(directive.id);
			controllers.get(directive.id)?.abort("cancelled by fake CLI");
			await lastSend;
			continue;
		}
		if (directive.fake === "checkpoint") {
			await lastSend;
			process.send?.({ fake: "checkpoint" });
			continue;
		}
		if (directive.fake === "wait-for-message") {
			await parentMessages.next();
			continue;
		}
		if (directive.fake === "hold") {
			setInterval(() => {}, 60_000);
			return;
		}
		if (directive.fake === "exit") {
			if (directive.stderr) process.stderr.write(directive.stderr);
			process.exit(directive.code);
		}
		if (directive.fake === "reply") {
			const awaited = await Promise.all(
				pendingResults.splice(0).filter(({ id }) => !cancelled.has(id)).map(({ request }) => request),
			);
			for (const res of awaited) {
				results.push(res.content.map((block) => block.text ?? "[image]").join(""));
			}
			await writeJson({
				jsonrpc: "2.0",
				method: "session/update",
				params: {
					sessionId: SESSION_ID,
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: results.join(" | ") } },
				},
			});
			await writeJson({
				jsonrpc: "2.0",
				id: promptReqId,
				result: { stopReason: "end_turn", ...(directive.usage ? { usage: directive.usage } : {}) },
			});
			completed = true;
			continue;
		}
		if (directive.fake === "done") {
			await writeJson({
				jsonrpc: "2.0",
				id: promptReqId,
				result: { stopReason: directive.stopReason ?? "end_turn", ...(directive.usage ? { usage: directive.usage } : {}) },
			});
			completed = true;
			continue;
		}
	}
	if (!completed) {
		await writeJson({ jsonrpc: "2.0", id: promptReqId, result: { stopReason: "end_turn" } });
	}
}

createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const msg = JSON.parse(line);
	if (msg.id !== undefined && msg.method === undefined && pendingPermissions.has(msg.id)) {
		const resolve = pendingPermissions.get(msg.id);
		pendingPermissions.delete(msg.id);
		resolve(msg.result);
		return;
	}
	recorded.requests.push(msg);
	flushRecord();

	if (msg.method === "initialize") {
		void writeJson({
			jsonrpc: "2.0",
			id: msg.id,
			result: {
				protocolVersion: 1,
				agentCapabilities: { promptCapabilities: { image: true } },
				agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
			},
		});
		return;
	}

	if (msg.method === "session/new") {
		if (process.env.FAKE_AGY_AUTH === "signed-out") {
			void writeJson({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Authentication required" } });
			return;
		}
		bridgeServer = msg.params.mcpServers.find((server) => server.name === BRIDGE_SERVER_NAME);
		void writeJson({ jsonrpc: "2.0", id: msg.id, result: defaultSessionNewResult() });
		return;
	}

	if (msg.method === "session/set_config_option" || msg.method === "session/set_model") {
		void writeJson({ jsonrpc: "2.0", id: msg.id, result: {} });
		return;
	}

	if (msg.method === "session/cancel") {
		recorded.cancelled = true;
		flushRecord();
		return;
	}

	if (msg.method === "session/prompt") {
		void runScenario(msg.id);
	}
});
