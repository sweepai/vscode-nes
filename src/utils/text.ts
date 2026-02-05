import * as vscode from "vscode";
import {
	AUTOCOMPLETE_AVG_LINE_LENGTH_THRESHOLD,
	AUTOCOMPLETE_MAX_FILE_SIZE,
	AUTOCOMPLETE_MAX_LINES,
} from "~/core/constants.ts";

export function utf8ByteOffsetAt(
	document: vscode.TextDocument,
	position: vscode.Position,
): number {
	if (position.line === 0 && position.character === 0) {
		return 0;
	}

	const prefix = document.getText(
		new vscode.Range(new vscode.Position(0, 0), position),
	);
	return Buffer.byteLength(prefix, "utf8");
}

export function utf8ByteOffsetToUtf16Offset(
	text: string,
	byteOffset: number,
): number {
	if (byteOffset <= 0) return 0;

	let utf16Offset = 0;
	let bytes = 0;

	for (const ch of text) {
		const chBytes = Buffer.byteLength(ch, "utf8");
		if (bytes + chBytes > byteOffset) {
			return utf16Offset;
		}
		bytes += chBytes;
		utf16Offset += ch.length;
	}

	return utf16Offset;
}

export function isFileTooLarge(text: string): boolean {
	if (text.length > AUTOCOMPLETE_MAX_FILE_SIZE) return true;

	const lines = text.split("\n");
	if (lines.length > AUTOCOMPLETE_MAX_LINES) return true;

	const avgLineLength = text.length / (lines.length + 1);
	if (avgLineLength > AUTOCOMPLETE_AVG_LINE_LENGTH_THRESHOLD) return true;

	return false;
}
