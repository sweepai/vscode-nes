import { describe, expect, test } from "bun:test";

import {
	fuseAndDedupRetrievalSnippets,
	truncateRetrievalChunk,
} from "~/api/retrieval-chunks.ts";
import type { FileChunk } from "~/api/schemas.ts";

function chunk(overrides: Partial<FileChunk>): FileChunk {
	return {
		file_path: "src/example.ts",
		start_line: 1,
		end_line: 1,
		content: "line",
		timestamp: 1,
		...overrides,
	};
}

describe("truncateRetrievalChunk", () => {
	test("truncates long chunks and updates end_line", () => {
		const input = chunk({
			start_line: 10,
			end_line: 20,
			content: "a\nb\nc\nd\ne",
		});

		const result = truncateRetrievalChunk(input, 3);

		expect(result.content).toBe("a\nb\nc");
		expect(result.end_line).toBe(12);
	});

	test("returns original chunk when already within max lines", () => {
		const input = chunk({
			start_line: 2,
			end_line: 3,
			content: "a\nb",
		});

		const result = truncateRetrievalChunk(input, 3);

		expect(result).toEqual(input);
	});
});

describe("fuseAndDedupRetrievalSnippets", () => {
	test("fuses touching ranges from the same file", () => {
		const result = fuseAndDedupRetrievalSnippets([
			chunk({ start_line: 5, end_line: 6, content: "a\nb", timestamp: 10 }),
			chunk({ start_line: 7, end_line: 8, content: "c\nd", timestamp: 15 }),
		]);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(
			chunk({
				start_line: 5,
				end_line: 8,
				content: "a\nb\nc\nd",
				timestamp: 15,
			}),
		);
	});

	test("deduplicates identical chunks", () => {
		const duplicate = chunk({
			start_line: 3,
			end_line: 4,
			content: "x\ny",
		});

		const result = fuseAndDedupRetrievalSnippets([duplicate, duplicate]);

		expect(result).toEqual([duplicate]);
	});

	test("does not fuse snippets across different files", () => {
		const result = fuseAndDedupRetrievalSnippets([
			chunk({
				file_path: "src/a.ts",
				start_line: 1,
				end_line: 2,
				content: "a",
			}),
			chunk({
				file_path: "src/b.ts",
				start_line: 2,
				end_line: 3,
				content: "b",
			}),
		]);

		expect(result).toHaveLength(2);
		expect(result[0]?.file_path).toBe("src/a.ts");
		expect(result[1]?.file_path).toBe("src/b.ts");
	});

	test("keeps larger containing range when one snippet fully covers the other", () => {
		const large = chunk({
			start_line: 10,
			end_line: 20,
			content: "large",
			timestamp: 2,
		});
		const small = chunk({
			start_line: 12,
			end_line: 13,
			content: "small",
			timestamp: 3,
		});

		const result = fuseAndDedupRetrievalSnippets([large, small]);

		expect(result).toEqual([large]);
	});
});
