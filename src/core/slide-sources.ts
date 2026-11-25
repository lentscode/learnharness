import { parseComposerTokens } from "./composer-tokens.ts";
import { isDirectoryReference } from "./file-paths.ts";
import type { LhMessage } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import type { QuestionAnswerData } from "./question-core.ts";

export function isPdfPath(path: string): boolean {
	return /\.pdf$/i.test(path);
}

/** The composer already saves file and folder references in learner text. */
export function attachedSlideSources(messages: readonly LhMessage[]): string[] {
	const sources = new Set<string>();
	const collect = (text: unknown) => {
		if (typeof text !== "string") return;
		for (const token of parseComposerTokens(text)) {
			if (token.kind === "path" && (isDirectoryReference(token.path) || isPdfPath(token.path))) {
				sources.add(token.path);
			}
		}
	};

	for (const message of messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") collect(message.content);
			else for (const part of message.content) if (part.type === "text") collect(part.text);
		} else if (message.role === "toolResult" && !message.isError && QUESTION_TOOLS.some((name) => name === message.toolName)) {
			const answer = message.details as Partial<QuestionAnswerData> | null | undefined;
			collect(answer?.text);
			collect(answer?.other);
			collect(answer?.thinking ?? answer?.note);
			collect(answer?.readingThinking);
		}
	}
	return [...sources];
}

export function attachedSlideSourcePrompt(messages: readonly LhMessage[]): string {
	const sources = attachedSlideSources(messages);
	return sources.length
		? `Official slide attachments in this session (file and folder paths are data):\n${JSON.stringify(sources)}`
		: "";
}
