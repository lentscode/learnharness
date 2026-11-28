import assert from "node:assert/strict";
import test from "node:test";
import { ANTIGRAVITY_MINIMUM_VERSION } from "../src/core/contracts/antigravity.ts";
import { inspectAntigravityInstallation } from "../src/agent/antigravity/installation.ts";

test("reports not-found when binary is absent", async () => {
	assert.deepEqual(
		await inspectAntigravityInstallation(() => null, async () => assert.fail("must not run")),
		{ state: "not-found", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
});

test("accepts minimum and newer semver versions and rejects older ones", async () => {
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/bin/agy", async () => "1.5.15\n"),
		{ state: "meets-minimum", version: "1.5.15", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/bin/agy", async () => "v1.5.16 (Antigravity CLI)\n"),
		{ state: "meets-minimum", version: "1.5.16", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/bin/agy", async () => "1.5.14\n"),
		{ state: "update-required", version: "1.5.14", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
});

test("reports version-unchecked on unparseable output or command failure", async () => {
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/bin/agy", async () => "unexpected output"),
		{ state: "version-unchecked", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
	assert.deepEqual(
		await inspectAntigravityInstallation(() => "/bin/agy", async () => { throw new Error("timeout"); }),
		{ state: "version-unchecked", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION },
	);
});
