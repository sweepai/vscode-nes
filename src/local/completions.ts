import { SWEEP_FILE_SEP_TOKEN } from "~/core/constants.ts";
import { toUnixPath } from "~/utils/path.ts";

export interface LocalPromptInput {
	filePath: string;
	originalText: string;
	currentText: string;
}

export interface ReplacementSpan {
	start: number;
	end: number;
	replacement: string;
}

export function buildLocalPrompt(input: LocalPromptInput): string {
	const filePath = toUnixPath(input.filePath) || input.filePath || "untitled";
	const originalText = input.originalText ?? "";
	const currentText = input.currentText ?? "";

	return [
		`${SWEEP_FILE_SEP_TOKEN}original/${filePath}`,
		originalText,
		`${SWEEP_FILE_SEP_TOKEN}current/${filePath}`,
		currentText,
		`${SWEEP_FILE_SEP_TOKEN}updated/${filePath}`,
		"",
	].join("\n");
}

export function computeReplacementSpan(
	currentText: string,
	updatedText: string,
): ReplacementSpan | null {
	if (currentText === updatedText) return null;

	let start = 0;
	const minLen = Math.min(currentText.length, updatedText.length);
	while (start < minLen && currentText[start] === updatedText[start]) {
		start += 1;
	}

	let endCurrent = currentText.length;
	let endUpdated = updatedText.length;
	while (
		endCurrent > start &&
		endUpdated > start &&
		currentText[endCurrent - 1] === updatedText[endUpdated - 1]
	) {
		endCurrent -= 1;
		endUpdated -= 1;
	}

	return {
		start,
		end: endCurrent,
		replacement: updatedText.slice(start, endUpdated),
	};
}
