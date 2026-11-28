import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { externalCliEnv } from "../../core/auth-env.ts";
import type { AntigravityDiscoveredModel, AntigravityStatus } from "../../core/contracts/antigravity.ts";
import {
	acpInitializeRequest,
	acpNewSessionRequest,
	isAuthRequiredError,
	parseAcpLine,
	parseSessionSetup,
} from "./acp-protocol.ts";
import { getAntigravityBinary } from "./binary.ts";

const DISCOVERY_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 1_000;

export type AntigravityDiscoveryResult = Pick<AntigravityStatus, "authState" | "models" | "error">;

export type SpawnDiscoveryProcess = (
	binary: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

const defaultSpawnDiscovery: SpawnDiscoveryProcess = (binary, args, options) =>
	spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });

export const DISCOVERY_ACP_ARGS = [
	"acp",
	"--include-default-customizations=false",
	"--disable-telemetry",
] as const;

export async function discoverAntigravityModels({
	binary = getAntigravityBinary(),
	spawnProcess = defaultSpawnDiscovery,
	timeoutMs = DISCOVERY_TIMEOUT_MS,
}: {
	binary?: string | null;
	spawnProcess?: SpawnDiscoveryProcess;
	timeoutMs?: number;
} = {}): Promise<AntigravityDiscoveryResult> {
	if (!binary) return { authState: "unchecked", models: [] };

	const cwd = await mkdtemp(join(tmpdir(), "antigravity-discover-"));
	let child: ChildProcessWithoutNullStreams | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	let timeoutTimer: NodeJS.Timeout | undefined;

	const stopChild = () => {
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		child.kill();
		killTimer = setTimeout(() => child?.kill("SIGKILL"), KILL_GRACE_MS);
		killTimer.unref();
	};

	try {
		child = spawnProcess(binary, [...DISCOVERY_ACP_ARGS], { cwd, env: externalCliEnv() });
		const proc = child;

		const result = await new Promise<AntigravityDiscoveryResult>((resolve) => {
			let settled = false;
			let stderr = "";
			const finish = (value: AntigravityDiscoveryResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutTimer);
				stopChild();
				resolve(value);
			};

			timeoutTimer = setTimeout(() => {
				finish({ authState: "error", models: [], error: "Timed out probing Antigravity CLI models." });
			}, timeoutMs);
			timeoutTimer.unref();

			proc.once("error", () => finish({ authState: "error", models: [], error: "Failed to start Antigravity CLI." }));
			proc.once("close", () => finish({
				authState: "error",
				models: [],
				error: stderr.trim() ? "Antigravity CLI exited before returning models." : "Antigravity CLI closed before returning models.",
			}));
			proc.stderr.setEncoding("utf8");
			proc.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_192); });
			proc.stdin.on("error", () => { /* child closed early; close handler settles */ });

			createInterface({ input: proc.stdout }).on("line", (line) => {
				if (settled || !line.trim()) return;
				let message;
				try {
					message = parseAcpLine(line);
				} catch {
					return;
				}
				if (!message || message.type !== "response") return;

				if (message.id === 1) {
					if (message.error) {
						finish(isAuthRequiredError(message.error)
							? { authState: "not-signed-in", models: [] }
							: { authState: "error", models: [], error: message.error.message ?? "Antigravity ACP initialize failed." });
						return;
					}
					proc.stdin.write(`${acpNewSessionRequest(2, cwd)}\n`);
					return;
				}

				if (message.id === 2) {
					if (message.error) {
						finish(isAuthRequiredError(message.error)
							? { authState: "not-signed-in", models: [] }
							: { authState: "error", models: [], error: message.error.message ?? "Antigravity ACP session/new failed." });
						return;
					}
					const setup = parseSessionSetup(message.result);
					if (!setup) {
						finish({ authState: "error", models: [], error: "Antigravity CLI returned an invalid session response." });
						return;
					}
					const models: AntigravityDiscoveredModel[] = setup.models;
					finish({ authState: "authenticated", models });
				}
			});

			proc.stdin.write(`${acpInitializeRequest(1)}\n`);
		});

		return result;
	} finally {
		clearTimeout(timeoutTimer);
		clearTimeout(killTimer);
		stopChild();
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}
