import * as vscode from "vscode";

import type { AutocompleteResult, SuggestionType } from "~/api/schemas.ts";

export interface AutocompleteMetricsPayload {
	id: string;
	additions: number;
	deletions: number;
	suggestionType: SuggestionType;
	numDefinitionsRetrieved?: number;
	numUsagesRetrieved?: number;
}

export class AutocompleteMetricsTracker implements vscode.Disposable {
	private shownIds = new Set<string>();

	dispose(): void {
		this.shownIds.clear();
	}

	trackShown(payload: AutocompleteMetricsPayload): void {
		this.shownIds.add(payload.id);
	}

	trackAccepted(_payload: AutocompleteMetricsPayload): void {}

	trackDisposed(_payload: AutocompleteMetricsPayload): void {}
}

export function buildMetricsPayload(
	document: vscode.TextDocument,
	result: AutocompleteResult,
	options?: { suggestionType?: SuggestionType },
): AutocompleteMetricsPayload {
	const { additions, deletions } = computeAdditionsDeletions(document, result);
	return {
		id: result.id,
		additions,
		deletions,
		suggestionType: options?.suggestionType ?? "GHOST_TEXT",
	};
}

export function computeAdditionsDeletions(
	document: vscode.TextDocument,
	result: AutocompleteResult,
): { additions: number; deletions: number } {
	const startLine = document.positionAt(result.startIndex).line;
	const endOffset =
		result.endIndex > result.startIndex
			? result.endIndex - 1
			: result.startIndex;
	const endLine = document.positionAt(endOffset).line;
	const deletions = Math.max(endLine - startLine + 1, 1);
	const additions = Math.max(result.completion.split("\n").length, 1);
	return { additions, deletions };
}
