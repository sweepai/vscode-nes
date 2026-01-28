import * as vscode from "vscode";

import type { AutocompleteInput } from "~/api/client.ts";
import { ApiClient } from "~/api/client.ts";
import { DEFAULT_MAX_CONTEXT_FILES } from "~/constants";
import type { DocumentTracker } from "~/tracking/document-tracker.ts";

const API_KEY_PROMPT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extended InlineCompletionItem interface with proposed API properties.
 * These properties are part of the `inlineCompletionsAdditions` proposed API
 * and enable NES (Next Edit Suggestions) style rendering.
 *
 * Note: These features require running in extension development mode or
 * with the --enable-proposed-api flag to work properly.
 */
interface ExtendedInlineCompletionItem extends vscode.InlineCompletionItem {
	/** If true, this item is treated as an inline edit (NES-style) */
	isInlineEdit?: boolean;
	/** Range where the edit is visible based on cursor position */
	showRange?: vscode.Range;
}

export class InlineEditProvider implements vscode.InlineCompletionItemProvider {
	private tracker: DocumentTracker;
	private api: ApiClient;
	private lastApiKeyPrompt = 0;

	constructor(tracker: DocumentTracker) {
		this.tracker = tracker;
		this.api = new ApiClient();
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionList | undefined> {
		if (!this.isEnabled()) {
			return undefined;
		}

		if (!this.api.apiKey) {
			this.promptForApiKey();
			return undefined;
		}

		const uri = document.uri.toString();
		const currentContent = document.getText();
		const originalContent =
			this.tracker.getOriginalContent(uri) ?? currentContent;

		if (currentContent === originalContent) {
			return undefined;
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		try {
			const input = this.buildInput(document, position, originalContent);
			const result = await this.api.getAutocomplete(input);

			if (
				!this.isEnabled() ||
				token.isCancellationRequested ||
				!result?.completion
			) {
				return undefined;
			}

			const startPosition = document.positionAt(result.startIndex);
			const endPosition = document.positionAt(result.endIndex);
			const editRange = new vscode.Range(startPosition, endPosition);

			// Determine the relationship between cursor and edit range
			const cursorOffset = document.offsetAt(position);
			const cursorOnSameLine =
				position.line >= startPosition.line &&
				position.line <= endPosition.line;
			const cursorWithinRange =
				cursorOffset >= result.startIndex && cursorOffset <= result.endIndex;
			const cursorAfterRangeStart = cursorOffset >= result.startIndex;

			console.log("[Sweep] Creating inline edit:", {
				startPosition: `${startPosition.line}:${startPosition.character}`,
				endPosition: `${endPosition.line}:${endPosition.character}`,
				cursorPosition: `${position.line}:${position.character}`,
				cursorOffset,
				startIndex: result.startIndex,
				endIndex: result.endIndex,
				cursorOnSameLine,
				cursorWithinRange,
				cursorAfterRangeStart,
				completionPreview: result.completion.slice(0, 100),
			});

			// Strategy for displaying inline completions:
			// 1. If edit starts at or after cursor position -> standard ghost text (insertion)
			// 2. If edit includes cursor position -> use NES-style inline edit
			// 3. If edit is completely before cursor -> use NES-style inline edit

			if (result.startIndex >= cursorOffset) {
				// Case 1: Edit is at or after cursor - simple insertion
				// This is the standard ghost text case
				const item = new vscode.InlineCompletionItem(
					result.completion,
					editRange,
				);
				return { items: [item] };
			}

			// Cases 2 & 3: Edit involves replacing text before or around cursor
			// Use NES-style inline edit with isInlineEdit flag
			// The showRange determines when the edit is visible based on cursor position
			//
			// Note: isInlineEdit and showRange are proposed API features that require:
			// - Running in extension development mode, OR
			// - Using --enable-proposed-api flag
			// If these aren't available, VSCode will ignore these properties and
			// the inline completion may not render as expected.

			// Create a showRange that covers the edit location and current cursor
			// This allows the edit to be shown when the cursor is anywhere in this range
			const showRangeStartLine = Math.min(position.line, startPosition.line);
			const showRangeEndLine = Math.max(position.line, endPosition.line);
			const showRangeEnd = document.lineAt(showRangeEndLine).range.end;

			const item: ExtendedInlineCompletionItem =
				new vscode.InlineCompletionItem(result.completion, editRange);

			// Add proposed API properties for NES-style rendering
			item.isInlineEdit = true;
			item.showRange = new vscode.Range(
				new vscode.Position(showRangeStartLine, 0),
				showRangeEnd,
			);

			return { items: [item] };
		} catch (error) {
			console.error("[Sweep] InlineEditProvider error:", error);
			return undefined;
		}
	}

	private isEnabled(): boolean {
		return vscode.workspace
			.getConfiguration("sweep")
			.get<boolean>("enabled", true);
	}

	private promptForApiKey(): void {
		const now = Date.now();
		if (now - this.lastApiKeyPrompt < API_KEY_PROMPT_INTERVAL_MS) {
			return;
		}
		this.lastApiKeyPrompt = now;
		vscode.commands.executeCommand("sweep.setApiKey");
	}

	private getMaxContextFiles(): number {
		return vscode.workspace
			.getConfiguration("sweep")
			.get<number>("maxContextFiles", DEFAULT_MAX_CONTEXT_FILES);
	}

	private buildInput(
		document: vscode.TextDocument,
		position: vscode.Position,
		originalContent: string,
	): AutocompleteInput {
		const uri = document.uri.toString();
		const maxContextFiles = this.getMaxContextFiles();

		const recentBuffers = this.tracker
			.getRecentContextFiles(uri, maxContextFiles)
			.map((file) => ({
				path: file.filepath,
				content: file.content,
				mtime: file.mtime,
			}));

		const recentChanges = this.tracker.getEditDiffHistory().map((record) => ({
			path: record.filepath,
			diff: record.diff,
		}));

		const userActions = this.tracker.getUserActions(document.fileName);

		return {
			document,
			position,
			originalContent,
			recentChanges,
			recentBuffers,
			diagnostics: vscode.languages.getDiagnostics(document.uri),
			userActions,
		};
	}
}
