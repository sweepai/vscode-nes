import { describe, expect, test } from "bun:test";

import { classifyEditDisplay } from "~/editor/edit-display-classifier.ts";

describe("classifyEditDisplay", () => {
	test("returns JUMP when edit is far from cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 20,
			editStartLine: 5,
			editEndLine: 6,
			cursorOffset: 500,
			startIndex: 120,
			completion: "x",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "far-from-cursor",
		});
	});

	test("returns JUMP for multiline edits before cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 9,
			editEndLine: 9,
			cursorOffset: 200,
			startIndex: 120,
			completion: "foo\nbar",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "before-cursor-multiline",
		});
	});

	test("returns JUMP for same-line single-line edits before cursor", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 120,
			completion: "replacement",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "JUMP",
			reason: "before-cursor-single-line",
		});
	});

	test("returns INLINE for safe at-cursor suggestions", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 200,
			completion: "suffix",
			isOnSingleNewlineBoundary: false,
		});

		expect(result).toEqual({
			decision: "INLINE",
			reason: "inline-safe",
		});
	});

	test("returns SUPPRESS on single-newline boundary for multiline at-cursor edit", () => {
		const result = classifyEditDisplay({
			cursorLine: 10,
			editStartLine: 10,
			editEndLine: 10,
			cursorOffset: 200,
			startIndex: 200,
			completion: "foo\nbar",
			isOnSingleNewlineBoundary: true,
		});

		expect(result).toEqual({
			decision: "SUPPRESS",
			reason: "single-newline-boundary",
		});
	});
});
