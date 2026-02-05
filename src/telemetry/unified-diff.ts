import type * as vscode from "vscode";

const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_DIFF_CHARS = 20_000;

interface FormatRecentChangeDiffInput {
	filepath: string;
	previousContent: string;
	range: vscode.Range;
	rangeOffset: number;
	rangeLength: number;
	newText: string;
	contextLines?: number;
	maxDiffChars?: number;
}

export function formatRecentChangeDiff(
	input: FormatRecentChangeDiffInput,
): string | null {
	const {
		filepath,
		previousContent,
		range,
		rangeOffset,
		rangeLength,
		newText,
		contextLines = DEFAULT_CONTEXT_LINES,
		maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
	} = input;

	const start = rangeOffset;
	const end = rangeOffset + rangeLength;

	if (start < 0 || end < start || end > previousContent.length) {
		return null;
	}

	const deletedText = previousContent.slice(start, end);
	if (deletedText === newText) {
		return null;
	}

	const beforeText = previousContent.slice(0, start);
	const afterText = previousContent.slice(end);

	const beforeContext = getLastLines(beforeText, contextLines);
	const afterContext = getFirstLines(afterText, contextLines);
	const deletedLines = toLines(deletedText);
	const addedLines = toLines(newText);

	const oldStartLine = Math.max(1, range.start.line + 1 - beforeContext.length);
	const newStartLine = oldStartLine;
	const oldCount =
		beforeContext.length + deletedLines.length + afterContext.length;
	const newCount =
		beforeContext.length + addedLines.length + afterContext.length;

	const bodyLines = [
		...beforeContext.map((line) => ` ${line}`),
		...deletedLines.map((line) => `-${line}`),
		...addedLines.map((line) => `+${line}`),
		...afterContext.map((line) => ` ${line}`),
	];

	const header = [
		`Index: ${filepath}`,
		"===================================================================",
		`@@ -${oldStartLine},${oldCount} +${newStartLine},${newCount} @@`,
	];
	const full = [...header, ...bodyLines].join("\n");

	if (full.length <= maxDiffChars) {
		return full;
	}

	return truncateDiff(header, bodyLines, maxDiffChars);
}

function truncateDiff(
	header: readonly string[],
	bodyLines: readonly string[],
	maxDiffChars: number,
): string {
	const marker = "...[truncated]";
	const headerText = header.join("\n");
	const minLength = headerText.length + 1 + marker.length;
	if (maxDiffChars <= minLength) {
		return headerText;
	}

	const bodyBudget = maxDiffChars - (headerText.length + 1 + marker.length + 1);
	const body = bodyLines.join("\n");
	let truncated = body.slice(0, Math.max(0, bodyBudget));
	const lastNewline = truncated.lastIndexOf("\n");
	if (lastNewline > 0) {
		truncated = truncated.slice(0, lastNewline);
	}

	if (!truncated) {
		return `${headerText}\n${marker}`;
	}

	return `${headerText}\n${truncated}\n${marker}`;
}

function toLines(text: string): string[] {
	if (!text) return [];
	return text.split("\n");
}

function getLastLines(text: string, count: number): string[] {
	if (!text || count <= 0) return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) {
		lines.pop();
	}
	return lines.slice(-count);
}

function getFirstLines(text: string, count: number): string[] {
	if (!text || count <= 0) return [];
	const lines = text.split("\n");
	return lines.slice(0, count);
}
