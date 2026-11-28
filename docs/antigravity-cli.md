# Antigravity CLI

LearnHarness can use an externally installed **Antigravity CLI (`agy`)** as a model provider over the Agent Client Protocol (`agy acp`). This is separate from direct API keys and built-in subscription connections. The CLI owns authentication, routing, model access, and billing.

## Set up

1. [Install and authenticate Antigravity CLI](https://antigravity.google/docs/getting-started) outside LearnHarness, on **the machine running the LearnHarness server**, under its OS user. No always-running CLI process is needed.
2. Make the `agy` executable discoverable in that server's `PATH` or a common user installation location (`~/.local/bin/agy` on macOS/Linux, `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows). On Windows, a directly runnable `agy.exe` is required; `.cmd` shims do not qualify.
3. Enable **Settings → Providers → External CLI → Antigravity CLI**. This app-wide opt-in is **off by default**.
4. Enabling Antigravity CLI (or clicking **Check again**) checks `agy --version` and probes `agy acp` to load the models and thinking levels available to your signed-in account. If you are not signed in yet, run `agy` interactively in your terminal and then click **Check again**.

The minimum version is **1.5.15** ([contract](../src/core/contracts/antigravity.ts)). Fresh model processes verify the version again and refuse older or unverifiable installations.

Install, update, sign in, and change CLI accounts externally. Disabling the opt-in blocks future requests without rewriting saved model selections or signing out the CLI; it does not interrupt an already admitted turn.

## What goes through the CLI

LearnHarness keeps control of its agent loop, tools, questions, saved history, and jobs. It supplies prompts, relevant history (including images), and tool results to `agy acp`.

The launcher removes credentials injected **only by LearnHarness's key store**. Original launch-environment credentials, native CLI authentication, and routing remain available and may affect billing. LearnHarness does not copy its saved API keys into this provider.

Each child runs without a shell in an isolated temporary working directory containing:

- `.agents/agents/learnharness/agent.md` carrying the LearnHarness system prompt with `tools: []`
- `.agents/mcp_config.json` requesting eager loading for the declared tools and a 30-minute tool timeout

LearnHarness launches `agy acp --agent learnharness --process-per-session --include-default-customizations=false --disable-telemetry`. It registers the token-protected loopback Streamable HTTP MCP bridge in ACP `session/new` so the session can call tools such as `read` and `pdf`. Antigravity controls the effective tool timeout for servers registered via ACP.

LearnHarness approves ACP `session/request_permission` requests **only** for its `learnharness` MCP bridge and rejects all built-in tools (shell, filesystem, web, browser, subagents) and other MCP servers. Tool execution requires an authenticated MCP bridge request.

## Questions, reuse, and cancellation

The persisted LearnHarness transcript—not a CLI saved session—is authoritative. A child normally exits after its final response. It can stay alive while tools await results, including a learner question, and resume only for the same owner/session and compatible history, tools, model, prompt, effort, and environment.

Held children expire after **10 minutes** idle. If no eligible child remains after timeout, restart, or configuration change, the next call starts fresh and replays active history as labelled user/assistant/tool text, preserving user and tool images via native ACP image blocks.

Abort sends ACP `session/cancel`, terminates the child (escalating to `SIGKILL` if necessary), closes the MCP bridge, and removes temporary directories.

## Usage and billing

Tokens come from ACP usage updates and prompt results. Dollar costs remain **unpriced** and menus say **CLI billing**; internal zero rates are placeholders, not free inference.

## Maintainer entry points

[`src/agent/antigravity/`](../src/agent/antigravity/) contains binary discovery, version inspection, ACP codec/discovery, stream adaptation, loopback MCP bridging, and transcript replay. Settings status and model discovery persistence live in [`src/server/antigravity.ts`](../src/server/antigravity.ts) and [`src/server/antigravity-config.ts`](../src/server/antigravity-config.ts).
