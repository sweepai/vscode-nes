import * as vscode from "vscode";

import type { AutocompleteInput } from "~/api/client.ts";
import { ApiClient } from "~/api/client.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { DEFAULT_MAX_CONTEXT_FILES } from "~/constants";
import type { JumpEditManager } from "~/provider/jump-edit-manager.ts";
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
	private jumpEditManager: JumpEditManager;
	private nesApiAvailable: boolean;
	private api: ApiClient;
	private lastApiKeyPrompt = 0;

	constructor(
		tracker: DocumentTracker,
		jumpEditManager: JumpEditManager,
		nesApiAvailable: boolean,
	) {
		this.tracker = tracker;
		this.jumpEditManager = jumpEditManager;
		this.nesApiAvailable = nesApiAvailable;
		this.api = new ApiClient();
		console.log(`[Sweep] NES inline edit API available: ${nesApiAvailable}`);
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

			// When NES API is available, isInlineEdit + showRange handles
			// edits at any distance natively (user presses Tab to accept).
			// When not available, fall back to jump edit decoration + keybinding
			// for any edit that can't be shown with the standard ghost text API
			// (i.e., far-away edits OR edits that start before the cursor).
			if (!this.nesApiAvailable) {
				const cursorOffset = document.offsetAt(position);
				const isBeforeCursor = result.startIndex < cursorOffset;
				const isFarAway = this.jumpEditManager.isJumpEdit(
					document,
					position,
					result,
				);

				if (isBeforeCursor || isFarAway) {
					console.log(
						"[Sweep] Edit detected as jump edit, showing decoration",
						{
							isBeforeCursor,
							isFarAway,
						},
					);
					this.jumpEditManager.setPendingJumpEdit(document, result);
					return undefined;
				}
			}

			// Clear any stale jump indicator
			this.jumpEditManager.clearJumpEdit();

			console.log("[Sweep] Rendering edit inline", {
				nesApi: this.nesApiAvailable,
				cursorLine: position.line,
				editStartLine: document.positionAt(result.startIndex).line,
			});
			return this.buildCompletionItems(document, position, result);
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

	private buildCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): vscode.InlineCompletionList | undefined {
		const startPosition = document.positionAt(result.startIndex);
		const endPosition = document.positionAt(result.endIndex);
		const editRange = new vscode.Range(startPosition, endPosition);
		const cursorOffset = document.offsetAt(position);

		console.log("[Sweep] Creating inline edit:", {
			startPosition: `${startPosition.line}:${startPosition.character}`,
			endPosition: `${endPosition.line}:${endPosition.character}`,
			cursorPosition: `${position.line}:${position.character}`,
			cursorOffset,
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			nesApi: this.nesApiAvailable,
			completionPreview: result.completion.slice(0, 100),
		});

		// When NES API is not available, use plain ghost text only for edits
		// that start at or after the cursor (standard API limitation).
		// Edits before cursor cannot be shown with the standard API.
		if (!this.nesApiAvailable) {
			if (result.startIndex >= cursorOffset) {
				const item = new vscode.InlineCompletionItem(
					result.completion,
					editRange,
				);
				return { items: [item] };
			}
			// Edit starts before cursor - cannot show with standard API
			// This should have been caught as a jump edit earlier, but return
			// undefined as a fallback.
			console.log("[Sweep] Edit before cursor cannot be shown without NES API");
			return undefined;
		}

		// With NES API: use isInlineEdit + showRange so VS Code's NES UI
		// handles both nearby and far-away edits (jump indicator + Tab to accept).
		const showRangeStartLine = Math.min(position.line, startPosition.line);
		const showRangeEndLine = Math.max(position.line, endPosition.line);
		const showRangeEnd = document.lineAt(showRangeEndLine).range.end;

		const item: ExtendedInlineCompletionItem = new vscode.InlineCompletionItem(
			result.completion,
			editRange,
		);

		item.isInlineEdit = true;
		item.showRange = new vscode.Range(
			new vscode.Position(showRangeStartLine, 0),
			showRangeEnd,
		);

		return { items: [item] };
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
