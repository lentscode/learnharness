import assert from "node:assert/strict";
import test from "node:test";
import { resolveAntigravityBinary } from "../src/agent/antigravity/binary.ts";

test("finds agy on PATH before known installation directories on POSIX", () => {
	const found = resolveAntigravityBinary({
		env: { PATH: "/custom/bin:/usr/bin" },
		platform: "darwin",
		homeDir: "/Users/alice",
		isExecutable: (candidate) => candidate === "/custom/bin/agy" || candidate === "/Users/alice/.local/bin/agy",
	});
	assert.equal(found, "/custom/bin/agy");
});

test("falls back to ~/.local/bin and Homebrew/Nix locations when absent from PATH", () => {
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "/usr/bin" },
			platform: "darwin",
			homeDir: "/Users/alice",
			isExecutable: (candidate) => candidate === "/Users/alice/.local/bin/agy",
		}),
		"/Users/alice/.local/bin/agy",
	);
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "", USER: "alice" },
			platform: "linux",
			homeDir: "/home/alice",
			isExecutable: (candidate) => candidate === "/etc/profiles/per-user/alice/bin/agy",
		}),
		"/etc/profiles/per-user/alice/bin/agy",
	);
});

test("resolves agy.exe on Windows in LOCALAPPDATA\\agy\\bin and rejects .cmd shims", () => {
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "", LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
			platform: "win32",
			homeDir: "C:\\Users\\alice",
			isExecutable: (candidate) => candidate === "C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy.exe",
		}),
		"C:\\Users\\alice\\AppData\\Local\\agy\\bin\\agy.exe",
	);
	assert.equal(
		resolveAntigravityBinary({
			env: { PATH: "C:\\tools" },
			platform: "win32",
			homeDir: "C:\\Users\\alice",
			isExecutable: (candidate) => candidate === "C:\\tools\\agy.cmd",
		}),
		null,
	);
});
