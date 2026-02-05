import { describe, expect, test } from "bun:test";
import type * as vscode from "vscode";

import { formatRecentChangeDiff } from "~/telemetry/unified-diff.ts";

function range(line: number): vscode.Range {
	return {
		start: { line, character: 0 },
		end: { line, character: 0 },
	} as unknown as vscode.Range;
}

describe("formatRecentChangeDiff", () => {
	test("includes deleted and inserted lines for replacements", () => {
		const previous = "const x = 1;\nconst y = 2;\n";
		const start = previous.indexOf("const y = 2;");
		const diff = formatRecentChangeDiff({
			filepath: "src/example.ts",
			previousContent: previous,
			range: range(1),
			rangeOffset: start,
			rangeLength: "const y = 2;".length,
			newText: "const y = 3;",
		});

		expect(diff).toContain("@@ -");
		expect(diff).toContain("-const y = 2;");
		expect(diff).toContain("+const y = 3;");
		expect(diff).not.toContain("[deleted");
	});

	test("captures pure insertions as added lines", () => {
		const previous = "line1\nline2\n";
		const insertOffset = "line1\n".length;
		const diff = formatRecentChangeDiff({
			filepath: "src/example.ts",
			previousContent: previous,
			range: range(1),
			rangeOffset: insertOffset,
			rangeLength: 0,
			newText: "inserted\n",
		});

		expect(diff).toContain("+inserted");
		expect(diff).not.toContain("-inserted");
	});

	test("truncates oversized diffs", () => {
		const previous = "a\n";
		const longText = "x".repeat(200);
		const diff = formatRecentChangeDiff({
			filepath: "src/example.ts",
			previousContent: previous,
			range: range(0),
			rangeOffset: 0,
			rangeLength: 1,
			newText: longText,
			maxDiffChars: 220,
		});

		expect(diff).toContain("...[truncated]");
		expect((diff ?? "").length).toBeLessThanOrEqual(220);
	});
});
