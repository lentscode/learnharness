import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PdfResult, ShowImageDetails } from "../../core/contracts.ts";
import { isDirectoryReference } from "../../core/file-paths.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import type { ChatStore, JobStore } from "../../core/ports.ts";
import { attachedSlideSources, isPdfPath } from "../../core/slide-sources.ts";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { isWithin, resolvePolicy } from "./file-access.ts";
import { resolveSourcePath } from "./fs-shared.ts";
import { loadPdfFigureSource } from "./pdf-figure.ts";

const showPdfPageInput = Type.Object({
	path: Type.String({ minLength: 1, description: "Path of the official slide PDF from the PDF reader's brief" }),
	page: Type.Integer({ minimum: 1, description: "The cited PDF page number, counting from 1" }),
});

interface ShowPdfPageContext {
	chatId: string;
	chatStore: Pick<ChatStore, "getChat" | "saveImageSnapshot">;
	jobStore: Pick<JobStore, "listJobs">;
	liveMessages?: () => readonly LhMessage[];
}

export function createShowPdfPageTool(ctx: ShowPdfPageContext): AgentTool<typeof showPdfPageInput> {
	return {
		name: "show_pdf_page",
		label: "show_pdf_page",
		description: "Show an original whole page from the learner's official slides inline in the lesson. " +
			"Use the path and page from a completed PDF brief in this session. " +
			"The PDF must be attached to the lesson or inside an attached folder. " +
			"Call this when using that page to teach. The result confirms the display.",
		parameters: showPdfPageInput,
		execute: serverExecute("show_pdf_page", showPdfPageInput, async ({ path, page }, { signal }): Promise<ImageFileResult> => {
			signal?.throwIfAborted();
			if (!Number.isSafeInteger(page) || page < 1) throw new Error("Use a PDF page number counting from 1.");
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) throw new Error("This lesson is unavailable.");
			const policy = resolvePolicy();
			const absolute = resolveSourcePath(path, policy);
			const attachments = attachedSlideSources([...record.messages, ...(ctx.liveMessages?.() ?? [])]);
			const attached = attachments.some((reference) => {
				try {
					const source = resolveSourcePath(reference, policy);
					return isDirectoryReference(reference) ? isPdfPath(absolute) && isWithin(absolute, source) : absolute === source;
				} catch {
					// Other missing or blocked attachments do not prevent this citation.
					return false;
				}
			});
			if (!attached) throw new Error("Use a PDF attached to this lesson or inside one of its attached folders.");

			const readJob = ctx.jobStore.listJobs(ctx.chatId).find((job) => {
				if (job.chatId !== ctx.chatId || job.kind !== "pdf" || job.status !== "done") return false;
				const result = job.result as Partial<PdfResult> | null | undefined;
				return result?.path === absolute && Array.isArray(result.pagesConsulted) && result.pagesConsulted.includes(page);
			});
			if (!readJob) throw new Error("The PDF reader has not consulted this page in this lesson. Read the page with the PDF tool first.");

			const source = await loadPdfFigureSource(absolute, page, signal, (readJob.result as PdfResult).sourceRevision);
			await source.close();
			signal?.throwIfAborted();
			if (source.path !== absolute) throw new Error("The PDF path changed while opening the slide. Read it again.");
			const { snapshotId, mimeType, width, height } = source.pageImage;
			ctx.chatStore.saveImageSnapshot(ctx.chatId, snapshotId, source.pageImage);
			const details: ShowImageDetails = { path: absolute, page, snapshotId, mimeType, width, height };
			return { text: `Shown to the learner: ${absolute}, page ${page}.`, details };
		}),
	};
}
