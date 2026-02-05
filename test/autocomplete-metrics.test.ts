import { describe, expect, test } from "bun:test";

import { applyContentChangeToTrackedOffsets } from "~/telemetry/edit-tracking-anchor.ts";

describe("applyContentChangeToTrackedOffsets", () => {
	test("shifts both offsets when text is inserted before the tracked range", () => {
		const result = applyContentChangeToTrackedOffsets(
			{ startOffset: 10, endOffset: 20 },
			{ rangeOffset: 3, rangeLength: 0, text: "abc" },
		);

		expect(result).toEqual({ startOffset: 13, endOffset: 23 });
	});

	test("expands the end offset when text is inserted inside the tracked range", () => {
		const result = applyContentChangeToTrackedOffsets(
			{ startOffset: 10, endOffset: 20 },
			{ rangeOffset: 12, rangeLength: 0, text: "abcd" },
		);

		expect(result).toEqual({ startOffset: 10, endOffset: 24 });
	});

	test("collapses to the replacement region when a change overlaps the start", () => {
		const result = applyContentChangeToTrackedOffsets(
			{ startOffset: 10, endOffset: 20 },
			{ rangeOffset: 8, rangeLength: 5, text: "xy" },
		);

		expect(result).toEqual({ startOffset: 8, endOffset: 17 });
	});
});
