import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../../core/auth-env.ts";
import { ANTIGRAVITY_MINIMUM_VERSION, type AntigravityStatus } from "../../core/contracts/antigravity.ts";
import { getAntigravityBinary } from "./binary.ts";

export type ReadAntigravityVersion = (binary: string) => Promise<string>;

export type AntigravityInstallation = Pick<AntigravityStatus, "state" | "version" | "minimumVersion">;

/** No shell, auth-status command, model call, or credential-file inspection. */
export const readAntigravityVersion: ReadAntigravityVersion = (binary) => new Promise((resolve, reject) => {
	execFile(binary, ["--version"], {
		cwd: tmpdir(), env: externalCliEnv(), windowsHide: true,
		timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4_096,
	}, (error, stdout) => error ? reject(error) : resolve(stdout));
});

export async function inspectAntigravityInstallation(
	findBinary: () => string | null = getAntigravityBinary,
	readVersion: ReadAntigravityVersion = readAntigravityVersion,
): Promise<AntigravityInstallation> {
	const base = { version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION };
	const binary = findBinary();
	if (!binary) return { ...base, state: "not-found" };
	try {
		const output = await readVersion(binary);
		// Expose only a semver triple, never arbitrary CLI stdout/stderr or a binary path.
		const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\s*\(Antigravity(?:\s+CLI)?\))?$/.exec(output.trim());
		if (!match) return { ...base, state: "version-unchecked" };
		const parts = match.slice(1).map(Number);
		if (!parts.every(Number.isSafeInteger)) return { ...base, state: "version-unchecked" };
		const minimum = ANTIGRAVITY_MINIMUM_VERSION.split(".").map(Number);
		const differing = parts.findIndex((part, index) => part !== minimum[index]);
		const meetsMinimum = differing === -1 || parts[differing]! > minimum[differing]!;
		return { ...base, version: parts.join("."), state: meetsMinimum ? "meets-minimum" : "update-required" };
	} catch {
		return { ...base, state: "version-unchecked" };
	}
}
