import type { FileChunk } from "./schemas.ts";

export function truncateRetrievalChunk(
	chunk: FileChunk,
	maxLines: number,
): FileChunk {
	const lines = chunk.content.split("\n");
	if (lines.length <= maxLines) {
		return chunk;
	}
	const truncatedLines = lines.slice(0, maxLines);
	return {
		...chunk,
		end_line: Math.min(chunk.end_line, chunk.start_line + maxLines - 1),
		content: truncatedLines.join("\n"),
	};
}

export function fuseAndDedupRetrievalSnippets(
	snippets: FileChunk[],
): FileChunk[] {
	const fused: FileChunk[] = [];

	snippetsLoop: for (const snippet of snippets) {
		for (let i = 0; i < fused.length; i++) {
			const existing = fused[i];
			if (!existing) continue;

			if (
				existing.file_path === snippet.file_path &&
				rangesTouch(existing, snippet)
			) {
				fused[i] = mergeSnippet(existing, snippet);
				continue snippetsLoop;
			}

			if (
				existing.file_path === snippet.file_path &&
				existing.start_line === snippet.start_line &&
				existing.end_line === snippet.end_line &&
				existing.content === snippet.content
			) {
				continue snippetsLoop;
			}
		}

		fused.push(snippet);
	}

	return fused;
}

function rangesTouch(a: FileChunk, b: FileChunk): boolean {
	return b.start_line <= a.end_line + 1 && a.start_line <= b.end_line + 1;
}

function mergeSnippet(a: FileChunk, b: FileChunk): FileChunk {
	if (a.start_line <= b.start_line && a.end_line >= b.end_line) {
		return a;
	}
	if (b.start_line <= a.start_line && b.end_line >= a.end_line) {
		return b;
	}

	const startLine = Math.min(a.start_line, b.start_line);
	const endLine = Math.max(a.end_line, b.end_line);
	const content =
		a.start_line <= b.start_line
			? `${a.content}\n${b.content}`
			: `${b.content}\n${a.content}`;

	return {
		file_path: a.file_path,
		start_line: startLine,
		end_line: endLine,
		content: content.trim(),
		timestamp: Math.max(a.timestamp ?? 0, b.timestamp ?? 0),
	};
}
