export type EditDisplayDecision = "INLINE" | "JUMP" | "SUPPRESS";

export interface EditDisplayClassification {
	decision: EditDisplayDecision;
	reason:
		| "far-from-cursor"
		| "before-cursor-multiline"
		| "before-cursor-single-line"
		| "single-newline-boundary"
		| "inline-safe";
}

export interface EditDisplayClassifierInput {
	cursorLine: number;
	editStartLine: number;
	editEndLine: number;
	cursorOffset: number;
	startIndex: number;
	completion: string;
	isOnSingleNewlineBoundary: boolean;
}

export const EDIT_RANGE_PADDING_ROWS = 2;

export function classifyEditDisplay(
	input: EditDisplayClassifierInput,
): EditDisplayClassification {
	const lineDifference = Math.abs(input.cursorLine - input.editStartLine);
	const isBeforeCursor = input.startIndex < input.cursorOffset;
	const hasMultilineCompletion = input.completion.includes("\n");

	const paddedStart = Math.max(
		0,
		input.editStartLine - EDIT_RANGE_PADDING_ROWS,
	);
	const paddedEnd = input.editEndLine + EDIT_RANGE_PADDING_ROWS;
	const isFarFromCursor =
		input.cursorLine < paddedStart || input.cursorLine > paddedEnd;

	if (isFarFromCursor) {
		return {
			decision: "JUMP",
			reason: "far-from-cursor",
		};
	}

	if (isBeforeCursor && hasMultilineCompletion) {
		return {
			decision: "JUMP",
			reason: "before-cursor-multiline",
		};
	}

	if (isBeforeCursor) {
		return {
			decision: "JUMP",
			reason: "before-cursor-single-line",
		};
	}

	if (
		hasMultilineCompletion &&
		input.startIndex === input.cursorOffset &&
		input.isOnSingleNewlineBoundary &&
		lineDifference <= 1
	) {
		return {
			decision: "SUPPRESS",
			reason: "single-newline-boundary",
		};
	}

	return {
		decision: "INLINE",
		reason: "inline-safe",
	};
}
