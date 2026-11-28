import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ThinkingLevel as PiThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { externalCliEnv } from "../../core/auth-env.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { addLiveProcess, getLiveProcess, removeLiveProcess, type LiveProcess } from "../claude-code/live-processes.ts";
import { configurationForReuse, conversationForReuse } from "../claude-code/reuse-context.ts";
import { offerWorkerContinuation } from "../worker-request-admission.ts";
import {
	acpCancelNotification,
	acpInitializeRequest,
	acpNewSessionRequest,
	acpPermissionResponse,
	acpPromptRequest,
	acpSetConfigOptionRequest,
	acpSetModelRequest,
	extractAcpUsage,
	extractBridgeToolName,
	findThoughtConfig,
	isAuthRequiredError,
	parseAcpLine,
	parseConfigOptions,
	parseSessionSetup,
	selectPermissionOption,
	type AcpPromptBlock,
	type AcpSessionUpdate,
	type AcpToolCallInfo,
	type AcpUsage,
} from "./acp-protocol.ts";
import { AntigravityError } from "./constants.ts";
import { AntigravityLaunchError, createAntigravityLauncher } from "./launch.ts";
import { BRIDGE_SERVER_NAME, createToolBridge, type PendingToolCall, type ToolBridge } from "./tool-bridge.ts";
import { toAntigravityInput } from "./transcript.ts";

type RunAntigravityOptions = { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal };
type AntigravityChild = ChildProcessWithoutNullStreams | null;
export type RunAntigravity = (args: string[], options: RunAntigravityOptions) => AntigravityChild | Promise<AntigravityChild>;

const PRIVATE_FILE_MODE = 0o600;
const AGENT_NAME = "learnharness";
const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "agy CLI failed to start";
const REFUSAL_MESSAGE = "The model refused to complete the request";

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	max_turn_requests: "stop",
	max_tokens: "length",
	refusal: "error",
	cancelled: "aborted",
};

export function toEffort(level: PiThinkingLevel | undefined): ThinkingLevel | undefined {
	if (!level) return undefined;
	return level === "minimal" ? "low" : level;
}

export function toAntigravityArgs(): string[] {
	return [
		"acp",
		"--agent",
		AGENT_NAME,
		"--process-per-session",
		"--include-default-customizations=false",
		"--disable-telemetry",
	];
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

class AntigravityTurn {
	private readonly output: AssistantMessage & Pick<LhMessage, "cliContextWindow">;
	private openBlock: { type: "text" | "thinking"; contentIndex: number } | null = null;
	started = false;
	finished = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = createOutput(model);
	}

	appendText(text: string): void {
		if (this.finished || !text) return;
		this.start();
		if (this.openBlock && this.openBlock.type !== "text") this.closeOpenBlock();
		if (!this.openBlock) {
			const contentIndex = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.openBlock = { type: "text", contentIndex };
			this.stream.push({ type: "text_start", contentIndex, partial: this.output });
		}
		const block = this.output.content[this.openBlock.contentIndex];
		if (block?.type === "text") {
			block.text += text;
			this.stream.push({ type: "text_delta", contentIndex: this.openBlock.contentIndex, delta: text, partial: this.output });
		}
	}

	appendThinking(thinking: string): void {
		if (this.finished || !thinking) return;
		this.start();
		if (this.openBlock && this.openBlock.type !== "thinking") this.closeOpenBlock();
		if (!this.openBlock) {
			const contentIndex = this.output.content.length;
			this.output.content.push({ type: "thinking", thinking: "" });
			this.openBlock = { type: "thinking", contentIndex };
			this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
		}
		const block = this.output.content[this.openBlock.contentIndex];
		if (block?.type === "thinking") {
			block.thinking += thinking;
			this.stream.push({ type: "thinking_delta", contentIndex: this.openBlock.contentIndex, delta: thinking, partial: this.output });
		}
	}

	updateUsage(usage: AcpUsage): void {
		if (this.finished) return;
		Object.assign(this.output.usage, usage);
		const { input, output, cacheRead, cacheWrite } = this.output.usage;
		this.output.usage.totalTokens = input + output + cacheRead + cacheWrite;
	}

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined) this.output.cliContextWindow = tokens;
	}

	getMessage(): AssistantMessage {
		return this.output;
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeOpenBlock();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.finished = true;
		this.stream.push({ type: "done", reason: "toolUse", message: this.output });
		this.stream.end();
	}

	complete(rawStopReason: string | undefined): void {
		if (this.finished) return;
		this.start();
		this.closeOpenBlock();
		const mapped = rawStopReason ? STOP_REASONS[rawStopReason] : "stop";
		if (!mapped) {
			this.fail(`Unhandled stop reason: ${rawStopReason}`, "error");
			return;
		}
		if (mapped === "error") {
			this.fail(REFUSAL_MESSAGE, "error");
			return;
		}
		if (mapped === "aborted" || mapped === "pending") {
			this.fail(ABORT_MESSAGE, "aborted");
			return;
		}
		this.output.stopReason = mapped;
		this.finished = true;
		this.stream.push({ type: "done", reason: mapped, message: this.output });
		this.stream.end();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.closeOpenBlock();
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeOpenBlock(): void {
		if (!this.openBlock) return;
		const { type, contentIndex } = this.openBlock;
		this.openBlock = null;
		const block = this.output.content[contentIndex];
		if (type === "text" && block?.type === "text") {
			this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
		} else if (type === "thinking" && block?.type === "thinking") {
			this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
		}
	}
}

type TurnFiles = { cwd: string };

function buildAgentMarkdown(systemPrompt: string): string {
	return [
		"---",
		`name: ${AGENT_NAME}`,
		"description: LearnHarness runtime agent",
		"mainAgent: true",
		"subagent: false",
		"tools: []",
		"---",
		"",
		systemPrompt,
	].join("\n");
}

async function createTurnFiles(systemPrompt: string, mcpConfig: string): Promise<TurnFiles> {
	const cwd = await mkdtemp(join(tmpdir(), "antigravity-cwd-"));
	try {
		const agentDir = join(cwd, ".agents", "agents", AGENT_NAME);
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "agent.md"), buildAgentMarkdown(systemPrompt), { mode: PRIVATE_FILE_MODE });
		await writeFile(join(cwd, ".agents", "mcp_config.json"), mcpConfig, { mode: PRIVATE_FILE_MODE });
		return { cwd };
	} catch (error) {
		await rm(cwd, { recursive: true, force: true });
		throw error;
	}
}

async function removeTurnResources(bridge: ToolBridge, files: TurnFiles): Promise<void> {
	await Promise.all([
		bridge.close(),
		rm(files.cwd, { recursive: true, force: true }),
	]);
}

type HandshakeStep = "initialize" | "session_new" | "set_model" | "set_effort" | "prompt";

class AntigravityProcess implements LiveProcess {
	toolCallIds: string[] = [];
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;
	private signal: AbortSignal | undefined;
	private workerOwner: AbortSignal | undefined;
	private admitted: PendingToolCall[] = [];
	private readonly admittedIds = new Map<PendingToolCall, string>();
	private readonly cancelledIds = new Set<string>();
	private pendingError: string | undefined;
	private contextWindow: number | undefined;

	private nextRpcId = 1;
	private expectedRpcId = 0;
	private step: HandshakeStep = "initialize";
	private acpSessionId: string | undefined;
	private thoughtConfigId: string | undefined;
	private thoughtOptionValues = new Map<ThinkingLevel, string>();
	private readonly acpToolCalls = new Map<string, AcpToolCallInfo>();
	private readonly claimedAcpIds = new Set<string>();

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly bridge: ToolBridge,
		private readonly files: TurnFiles,
		private turn: AntigravityTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
		private readonly modelId: string,
		private readonly effort: ThinkingLevel | undefined,
		private readonly promptBlocks: AcpPromptBlock[],
		private readonly declaredToolNames: ReadonlySet<string>,
	) {}

	start(signal: AbortSignal | undefined): void {
		this.child.once("close", (code: number | null) => this.handleClose(`agy CLI exited with code ${code}`));
		this.child.once("error", (error) => {
			console.error("agy CLI process failed:", error);
			this.turn.fail(START_FAILED_MESSAGE, "error");
			this.handleClose(START_FAILED_MESSAGE);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-65_536); });
		this.child.stdin.on("error", (error) => console.error("agy CLI stdin closed early:", error));
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try { this.handleLine(line); }
			catch { this.fail("agy CLI emitted malformed ACP output"); }
		});
		this.setSignal(signal);
		if (!this.stopping) this.sendInitialize();
	}

	canContinue(owner: symbol, sessionId: string | undefined, configuration: unknown, messages: Message[], results: ToolResultMessage[]): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((result) => result.toolCallId)).size === results.length
			&& this.admitted.every((call) => {
				const emittedId = this.admittedIds.get(call) ?? call.id;
				return results.some((result) => result.toolCallId === emittedId && result.toolName === call.name);
			});
	}

	continueTurn(turn: AntigravityTurn, messages: Message[], results: ToolResultMessage[], signal: AbortSignal | undefined): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.workerOwner = undefined;
		this.setSignal(signal);
		if (this.stopping) return;
		for (const call of admitted) {
			const emittedId = this.admittedIds.get(call) ?? call.id;
			const result = results.find((candidate) => candidate.toolCallId === emittedId)!;
			this.bridge.resolveToolCall(call, result);
		}
		this.flushAdmissions();
	}

	kill(): void {
		this.pendingError = undefined;
		this.workerOwner = undefined;
		this.setSignal(undefined);
		this.stopChild();
	}

	private stopChild(): void {
		removeLiveProcess(this);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		if (this.acpSessionId && !this.child.stdin.destroyed) {
			try { this.child.stdin.write(`${acpCancelNotification(this.acpSessionId)}\n`); } catch { /* closing */ }
		}
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
		this.killTimer.unref();
	}

	fail(message: string): void {
		if (this.stopping || this.closed) return;
		if (this.sessionId && this.turn.finished && this.toolCallIds.length > 0) this.pendingError = message;
		this.turn.fail(message, "error");
		if (this.pendingError) {
			this.stopChild();
			addLiveProcess(this);
		} else {
			this.kill();
		}
	}

	consumeFailure(owner: symbol, turn: AntigravityTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	cancelCall(call: PendingToolCall): void {
		this.cancelledIds.add(call.id);
	}

	/** Only authenticated MCP requests, never ACP stdout updates alone, admit tool execution. */
	flushAdmissions(): void {
		if (this.stopping || this.turn.finished) return;
		const pending = this.bridge.getPendingToolCalls().filter((call) => !this.cancelledIds.has(call.id) && !this.admitted.includes(call));
		if (pending.length === 0) return;

		const calls: ToolCall[] = [];
		const admittedIds: string[] = [];
		for (const call of pending) {
			const callId = this.resolveCallId(call);
			this.admittedIds.set(call, callId);
			admittedIds.push(callId);
			calls.push({ type: "toolCall", id: callId, name: call.name, arguments: call.arguments });
		}

		this.admitted = pending;
		this.toolCallIds = admittedIds;
		this.turn.admit(calls);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) {
			addLiveProcess(this);
			const parkedTurn = this.turn;
			const request = this.signal;
			offerWorkerContinuation(request, {
				message: parkedTurn.getMessage(),
				handoff: (owner) => {
					if (this.turn !== parkedTurn || this.signal !== request || (!this.pendingError && (this.stopping || this.closed))) return;
					this.workerOwner = owner;
					this.setSignal(owner);
					return () => { if (this.turn === parkedTurn && this.workerOwner === owner) this.kill(); };
				},
			});
		} else {
			this.kill();
		}
	}

	private resolveCallId(call: PendingToolCall): string {
		if (call.metaId) {
			this.claimedAcpIds.add(call.metaId);
			return call.metaId;
		}
		// Correlate with an ACP tool_call update when its name and arguments match.
		for (const [acpId, info] of this.acpToolCalls.entries()) {
			if (this.claimedAcpIds.has(acpId)) continue;
			const bridged = extractBridgeToolName(info.title, BRIDGE_SERVER_NAME, this.declaredToolNames);
			if (bridged === call.name && (!info.rawInput || isDeepStrictEqual(info.rawInput, call.arguments))) {
				this.claimedAcpIds.add(acpId);
				return acpId;
			}
		}
		return call.id;
	}

	private readonly abort = () => {
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private send(line: string): void {
		if (this.stopping || this.closed) return;
		this.child.stdin.write(`${line}\n`);
	}

	private sendInitialize(): void {
		this.step = "initialize";
		this.expectedRpcId = this.nextRpcId++;
		this.send(acpInitializeRequest(this.expectedRpcId));
	}

	private sendNewSession(): void {
		this.step = "session_new";
		this.expectedRpcId = this.nextRpcId++;
		this.send(acpNewSessionRequest(this.expectedRpcId, this.files.cwd));
	}

	private sendSetModel(modelConfigId: string | undefined): void {
		this.step = "set_model";
		this.expectedRpcId = this.nextRpcId++;
		this.send(modelConfigId
			? acpSetConfigOptionRequest(this.expectedRpcId, this.acpSessionId!, modelConfigId, this.modelId)
			: acpSetModelRequest(this.expectedRpcId, this.acpSessionId!, this.modelId));
	}

	private sendSetEffortOrPrompt(): void {
		const rawEffort = this.effort ? this.thoughtOptionValues.get(this.effort) : undefined;
		if (this.thoughtConfigId && rawEffort) {
			this.step = "set_effort";
			this.expectedRpcId = this.nextRpcId++;
			this.send(acpSetConfigOptionRequest(this.expectedRpcId, this.acpSessionId!, this.thoughtConfigId, rawEffort));
			return;
		}
		this.sendPrompt();
	}

	private sendPrompt(): void {
		this.step = "prompt";
		this.expectedRpcId = this.nextRpcId++;
		this.send(acpPromptRequest(this.expectedRpcId, this.acpSessionId!, this.promptBlocks));
	}

	private handleLine(line: string): void {
		if (this.stopping || !line.trim()) return;
		const message = parseAcpLine(line);
		if (!message) return;

		switch (message.type) {
			case "permissionRequest": {
				const bridgeTool = extractBridgeToolName(message.toolCall.title, BRIDGE_SERVER_NAME, this.declaredToolNames);
				if (message.toolCall.toolCallId) {
					this.acpToolCalls.set(message.toolCall.toolCallId, message.toolCall);
				}
				const optionId = selectPermissionOption(message.options, bridgeTool !== null);
				this.send(acpPermissionResponse(message.id, optionId));
				return;
			}

			case "sessionUpdate":
				this.handleSessionUpdate(message.update);
				return;

			case "response":
				this.handleRpcResponse(message.id, message.result, message.error);
				return;
		}
	}

	private handleSessionUpdate(update: AcpSessionUpdate): void {
		if (update.type === "toolCall" || update.type === "toolCallUpdate") {
			const existing = this.acpToolCalls.get(update.toolCall.toolCallId);
			this.acpToolCalls.set(update.toolCall.toolCallId, {
				...existing,
				...update.toolCall,
				title: update.toolCall.title ?? existing?.title,
				rawInput: update.toolCall.rawInput ?? existing?.rawInput,
			});
			return;
		}
		if (update.type === "usageUpdate") {
			if (update.contextWindow !== undefined) {
				this.contextWindow = update.contextWindow;
				this.turn.setContextWindow(update.contextWindow);
			}
			if (update.usage) this.turn.updateUsage(update.usage);
			return;
		}
		// Moving on with assistant output while held tool calls are awaiting results means
		// the CLI did not honor the tool wait.
		if (this.turn.finished) {
			this.fail("agy CLI moved on while harness tool calls were waiting for results");
			return;
		}
		if (update.type === "textDelta") {
			this.turn.appendText(update.text);
		} else if (update.type === "thinkingDelta") {
			this.turn.appendThinking(update.thinking);
		}
	}

	private handleRpcResponse(id: number, result: unknown, error: { code?: number; message?: string } | undefined): void {
		if (id !== this.expectedRpcId) return;
		if (error) {
			this.fail(isAuthRequiredError(error) ? AntigravityError.NotSignedIn : error.message || "agy CLI request failed");
			return;
		}

		switch (this.step) {
			case "initialize":
				this.sendNewSession();
				return;

			case "session_new": {
				const setup = parseSessionSetup(result);
				if (!setup) {
					this.fail("agy CLI returned an invalid session/new response");
					return;
				}
				this.acpSessionId = setup.sessionId;
				this.thoughtConfigId = setup.thoughtConfigId;
				this.thoughtOptionValues = setup.thoughtOptionValues;
				this.sendSetModel(setup.modelConfigId);
				return;
			}

			case "set_model": {
				// Standard ACP session/set_config_option returns updated configOptions for the chosen model.
				if (result && typeof result === "object" && "configOptions" in result) {
					const thought = findThoughtConfig(parseConfigOptions((result as { configOptions?: unknown }).configOptions));
					this.thoughtConfigId = thought.configId;
					this.thoughtOptionValues = thought.optionValues;
				}
				this.sendSetEffortOrPrompt();
				return;
			}

			case "set_effort":
				this.sendPrompt();
				return;

			case "prompt": {
				if (this.turn.finished) {
					this.fail("agy CLI moved on while harness tool calls were waiting for results");
					return;
				}
				const payload = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
				const usage = extractAcpUsage(payload.usage);
				if (Object.keys(usage).length > 0) this.turn.updateUsage(usage);
				const stopReason = typeof payload.stopReason === "string" ? payload.stopReason : undefined;
				this.turn.complete(stopReason);
				this.kill();
				return;
			}
		}
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		removeLiveProcess(this);
		if (this.pendingError) addLiveProcess(this);
		if (!this.pendingError || !this.workerOwner) this.setSignal(undefined);
		if (this.stderr.trim()) console.error("agy CLI stderr:", this.stderr.trim());
		this.turn.fail(message, "error");
		removeTurnResources(this.bridge, this.files).catch((error: unknown) => {
			console.error("agy CLI cleanup failed:", error);
		});
	}
}

function continueLiveProcess(
	turn: AntigravityTurn,
	owner: symbol,
	sessionId: string | undefined,
	configuration: unknown,
	messages: Message[],
	signal: AbortSignal | undefined,
): boolean {
	const assistantIndex = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role !== "assistant") return false;
	const ids = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
	const process = getLiveProcess(ids, owner, sessionId);
	if (!(process instanceof AntigravityProcess)) return false;
	if (process.consumeFailure(owner, turn)) return true;
	const trailing = messages.slice(assistantIndex + 1);
	const results = trailing.filter((message) => message.role === "toolResult");
	if (trailing.length !== results.length || !process.canContinue(owner, sessionId, configuration, messages, results)) {
		process.kill();
		return false;
	}
	process.continueTurn(turn, messages, results, signal);
	return true;
}

function toAntigravityEnv(): NodeJS.ProcessEnv {
	return { ...externalCliEnv() };
}

async function startProcess(
	runAntigravity: RunAntigravity,
	turn: AntigravityTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (options?.signal?.aborted) { turn.fail(ABORT_MESSAGE, "aborted"); return; }
	const input = toAntigravityInput(context.messages);
	let cliProcess: AntigravityProcess | undefined;
	const bridge = await createToolBridge(input.tools, {
		onCall: () => cliProcess?.flushAdmissions(),
		onError: (error) => cliProcess?.fail(error.message),
		onCancel: (call) => cliProcess?.cancelCall(call),
	});
	let files: TurnFiles;
	try {
		files = await createTurnFiles(input.systemPrompt, bridge.mcpConfig);
	} catch (error) {
		await bridge.close();
		throw error;
	}
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await removeTurnResources(bridge, files);
		return;
	}

	let child: ChildProcessWithoutNullStreams | null;
	try {
		child = await runAntigravity(toAntigravityArgs(), { cwd: files.cwd, env, signal: options?.signal });
	} catch (error) {
		await removeTurnResources(bridge, files);
		throw error;
	}

	if (!child) {
		turn.fail(AntigravityError.CliNotFound, "error");
		await removeTurnResources(bridge, files);
		return;
	}

	const declaredToolNames = new Set(getCurrentTools(context.messages).map((tool) => tool.name));
	cliProcess = new AntigravityProcess(
		child,
		bridge,
		files,
		turn,
		owner,
		options?.sessionId,
		configuration,
		structuredClone(conversationForReuse(context.messages)),
		model.id,
		toEffort(options?.reasoning),
		input.promptBlocks,
		declaredToolNames,
	);
	cliProcess.start(options?.signal);
}

export function createAntigravityStreamFunction(runAntigravity: RunAntigravity): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("antigravity stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AntigravityTurn(stream, model);

		const env = toAntigravityEnv();
		const effort = toEffort(options?.reasoning) ?? "off";
		const configuration = { request: configurationForReuse(model, context, effort), env };
		if (continueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) return stream;

		startProcess(runAntigravity, turn, model, context, options, owner, configuration, env).catch((error: unknown) => {
			console.error("agy CLI turn failed:", error);
			turn.fail(
				options?.signal?.aborted
					? ABORT_MESSAGE
					: error instanceof AntigravityLaunchError
						? error.message
						: START_FAILED_MESSAGE,
				options?.signal?.aborted ? "aborted" : "error",
			);
		});

		return stream;
	};
}

export const streamAntigravity = createAntigravityStreamFunction(createAntigravityLauncher());
