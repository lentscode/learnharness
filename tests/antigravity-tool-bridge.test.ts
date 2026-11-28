import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ANTIGRAVITY_MCP_TIMEOUT_SECONDS, BRIDGE_SERVER_NAME, createToolBridge } from "../src/agent/antigravity/tool-bridge.ts";

const echoTool = {
	name: "echo",
	description: "Echo text",
	parameters: Type.Object({ text: Type.String() }),
};

test("configures eager tools, 30-minute timeout, bearer auth, and rejects unauthorized or undeclared calls", async (t) => {
	const errors: string[] = [];
	const bridge = await createToolBridge([echoTool], {
		onCall: () => {},
		onError: (err) => errors.push(err.message),
	});
	t.after(() => bridge.close());

	const parsed = JSON.parse(bridge.mcpConfig);
	const server = parsed.mcpServers[BRIDGE_SERVER_NAME];
	assert.equal(server.timeoutSeconds, ANTIGRAVITY_MCP_TIMEOUT_SECONDS);
	assert.deepEqual(server.enabledTools, ["echo"]);
	assert.deepEqual(server.tools, { echo: { eager: true, background: "off" } });
	assert.match(server.serverUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

	// Rejects missing / wrong bearer token
	const unauthorized = await fetch(server.serverUrl, { method: "POST", body: "{}" });
	assert.equal(unauthorized.status, 401);

	const client = new Client({ name: "test-client", version: "1.0.0" });
	const transport = new StreamableHTTPClientTransport(new URL(server.serverUrl), { requestInit: { headers: server.headers } });
	await client.connect(transport);
	t.after(() => client.close());

	const listed = await client.listTools();
	assert.deepEqual(listed.tools.map((item) => item.name), ["echo"]);

	// Rejects undeclared tool
	await assert.rejects(() => client.callTool({ name: "run_command", arguments: { cmd: "id" } }));
	assert.match(errors[0] ?? "", /undeclared harness tool/);

	// Holds declared tool call until resolved, forwarding both text and image results
	const callPromise = client.callTool({ name: "echo", arguments: { text: "hello" } });
	const [pending] = await bridge.waitForToolCalls(1);
	assert.ok(pending);
	assert.equal(pending.name, "echo");
	assert.deepEqual(pending.arguments, { text: "hello" });

	bridge.resolveToolCall(pending, {
		role: "toolResult",
		toolCallId: pending.id,
		toolName: "echo",
		content: [
			{ type: "text", text: "world" },
			{ type: "image", mimeType: "image/png", data: "AAAA" },
		],
		isError: false,
		timestamp: Date.now(),
	});

	const result = await callPromise;
	assert.deepEqual(result.content, [
		{ type: "text", text: "world" },
		{ type: "image", mimeType: "image/png", data: "AAAA" },
	]);
});
