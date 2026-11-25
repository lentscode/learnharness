import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderToStaticMarkup } from "react-dom/server";
import { GET } from "../app/api/chats/[id]/images/[snapshotId]/route.ts";
import { ImageCard, ImagePresentation } from "../components/artifacts/image-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { SessionMermaidContext } from "../components/session-overlay.tsx";
import { runPdfReaderAgent } from "../src/agent/subagents/pdf-reader.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { createTeacherTools } from "../src/agent/tools.ts";
import { setFileAccessPolicy } from "../src/agent/tools/file-access.ts";
import type { ImageSnapshot, ShowImageDetails } from "../src/core/contracts.ts";
import { directoryReferencePath, quoteFilePath } from "../src/core/file-paths.ts";
import { newUserMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { handleChatInput } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { tinyPdf } from "./helpers/tiny-pdf.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

it("shows the whole consulted slide from a nested attached folder and replays it after the PDF moves", async (t) => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lh-slides-"));
	const scratch = await fs.realpath(tmp);
	const chat = chatStore.createChat("Test official slides");
	t.after(async () => {
		jobStore.deleteJobsForChat(chat.id);
		chatStore.deleteChat(chat.id);
		await fs.rm(tmp, { recursive: true, force: true });
	});
	const folder = path.join(scratch, "Course");
	const week = path.join(folder, "Week 4");
	await fs.mkdir(week, { recursive: true });
	const deck = path.join(week, "Graphs.PDF");
	const outside = path.join(scratch, "Other.pdf");
	const bytes = tinyPdf([
		{ rects: [{ x: 0, y: 0, width: 612, height: 792, rgb: [0, 1, 0] }] },
		{ runs: [{ text: "Graph traversal", x: 50, y: 740 }], rects: [{ x: 306, y: 0, width: 306, height: 396, rgb: [1, 0, 0] }] },
	]);
	await fs.writeFile(deck, bytes);
	await fs.writeFile(outside, bytes);
	chatStore.saveMessages(chat.id, [newUserMessage(`Use these slides: ${quoteFilePath(directoryReferencePath(folder))}`)]);

	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("pdf_extract", { pages: "2" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("The slides cover graph traversal (p. 2).")]),
	]);
	const question = "Where is graph traversal covered?";
	const brief = await runPdfReaderAgent({ path: deck, question }, { engine: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.deepEqual(brief.pagesConsulted, [2]);
	const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "read-slides", input: { path: deck, question } });
	jobStore.updateJob(job.id, { status: "done", result: brief });
	const tool = createTeacherTools({ chatId: chat.id, chatStore, jobStore, spawn: () => {} }).show_pdf_page!;

	await assert.rejects(tool.execute("wrong-page", { path: deck, page: 1 }), /has not consulted this page/);
	await assert.rejects(tool.execute("outside-folder", { path: outside, page: 2 }), /attached to this lesson/);
	if (process.platform !== "win32") {
		const link = path.join(week, "Outside link.pdf");
		await fs.symlink(outside, link);
		await assert.rejects(tool.execute("outside-link", { path: link, page: 2 }), /attached to this lesson/);
	}
	assert.equal(chatStore.getChat(chat.id)?.imageSnapshots, undefined);

	const teacher = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	teacher.setResponses([
		fauxAssistantMessage([fauxToolCall("show_pdf_page", { path: deck, page: 2 }, { id: "show-slide" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Page 2 introduces graph traversal.")]),
	]);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	const turn = await handleChatInput(chat.id, { type: "text", text: "Show me the traversal slide." },
		(opts) => createTeacherAgent({ chatId: chat.id, chatStore, jobStore, spawn: () => {} },
			{ ...opts, engine: { model: teacher.getModel(), streamFn: teacher.streamSimple } }));
	assert.equal(turn.status, 200);
	const active = runningTurn(chat.id);
	if (active) await new Response(active.subscribe()).text();
	const messages = chatStore.getChat(chat.id)!.messages;
	const result = messages.find((message) => message.role === "toolResult" && message.toolName === "show_pdf_page");
	assert.ok(result?.role === "toolResult");
	assert.deepEqual(result.content.map((part) => part.type), ["text"]);
	assert.equal(result.isError, false);
	const slide = projectView(messages).flatMap((message) => message.parts).find((part) => part.type === "tool-show_pdf_page");
	assert.ok(slide && slide.state === "output-available");
	const details = slide.output as ShowImageDetails;
	assert.equal(details.page, 2);
	assert.equal(details.path, deck);
	assert.ok(!("data" in details));

	await fs.rename(deck, path.join(scratch, "Moved.pdf"));
	await fs.writeFile(deck, tinyPdf([{}, {}]));
	await assert.rejects(tool.execute("updated-deck", { path: deck, page: 2 }), /PDF changed since it was read/);
	await fs.unlink(deck);
	const response = await GET(new Request("http://localhost/snapshot"), { params: Promise.resolve({ id: chat.id, snapshotId: details.snapshotId }) });
	assert.equal(response.status, 200);
	const snapshot = await response.json() as ImageSnapshot;
	const page = await loadImage(Buffer.from(snapshot.data, "base64"));
	const canvas = createCanvas(page.width, page.height);
	const pixels = canvas.getContext("2d");
	pixels.drawImage(page, 0, 0);
	assert.ok(Math.abs(page.width / page.height - 612 / 792) < 0.002);
	assert.deepEqual(Array.from(pixels.getImageData(10, 10, 1, 1).data), [255, 255, 255, 255]);
	assert.deepEqual(Array.from(pixels.getImageData(page.width - 10, page.height - 10, 1, 1).data), [255, 0, 0, 255]);

	assert.equal(artifactRenderers.show_pdf_page, ImageCard);
	const html = renderToStaticMarkup(
		<SessionMermaidContext.Provider value={{ openMermaid: () => {}, openFigure: () => {} }}>
			<ImagePresentation image={{ ...snapshot, path: details.path, page: details.page }} />
		</SessionMermaidContext.Provider>,
	);
	assert.match(html, /alt="Graphs\.PDF, page 2"/);
	assert.match(html, /data-testid="image-caption">Graphs\.PDF, page 2/);
	assert.match(html, /aria-label="Open image fullscreen"/);
});

it("uses direct attachments from a live learner message and still enforces File access", async (t) => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lh-live-slides-"));
	const deck = path.join(await fs.realpath(tmp), "Lecture.pdf");
	await fs.writeFile(deck, tinyPdf([{}]));
	const chat = chatStore.createChat("Test live slide attachment");
	t.after(async () => {
		setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
		jobStore.deleteJobsForChat(chat.id);
		chatStore.deleteChat(chat.id);
		await fs.rm(tmp, { recursive: true, force: true });
	});
	const job = jobStore.createJob({ kind: "pdf", chatId: chat.id, toolCallId: "read-live-slide" });
	jobStore.updateJob(job.id, { status: "done", result: { path: deck, pagesConsulted: [1] } });
	const liveMessages = () => [newUserMessage(quoteFilePath(deck))];
	const tool = createTeacherTools({ chatId: chat.id, chatStore, jobStore, spawn: () => {}, liveMessages }).show_pdf_page!;

	setFileAccessPolicy(() => ({ restricted: true, folders: [] }));
	await assert.rejects(tool.execute("denied-slide", { path: deck, page: 1 }), /outside the allowed folders/);
	setFileAccessPolicy(() => ({ restricted: true, folders: [path.dirname(deck)] }));
	const result = await tool.execute("allowed-slide", { path: deck, page: 1 });
	assert.equal((result.details as ShowImageDetails).page, 1);
});
