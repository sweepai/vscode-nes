import * as vscode from "vscode";
import type { ApiClient, AutocompleteInput } from "~/api/client.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { DEFAULT_MAX_CONTEXT_FILES } from "~/constants";
import type { JumpEditManager } from "~/provider/jump-edit-manager.ts";
import {
	type AutocompleteMetricsPayload,
	type AutocompleteMetricsTracker,
	computeAdditionsDeletions,
} from "~/tracking/autocomplete-metrics.ts";
import type { DocumentTracker } from "~/tracking/document-tracker.ts";

const API_KEY_PROMPT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class InlineEditProvider implements vscode.InlineCompletionItemProvider {
	private tracker: DocumentTracker;
	private jumpEditManager: JumpEditManager;
	private api: ApiClient;
	private metricsTracker: AutocompleteMetricsTracker;
	private lastApiKeyPrompt = 0;
	private lastInlineEdit: {
		uri: string;
		line: number;
	} | null = null;

	constructor(
		tracker: DocumentTracker,
		jumpEditManager: JumpEditManager,
		api: ApiClient,
		metricsTracker: AutocompleteMetricsTracker,
	) {
		this.tracker = tracker;
		this.jumpEditManager = jumpEditManager;
		this.api = api;
		this.metricsTracker = metricsTracker;
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

			const cursorOffset = document.offsetAt(position);
			const isBeforeCursor = result.startIndex < cursorOffset;
			const isFarAway = this.jumpEditManager.isJumpEdit(
				document,
				position,
				result,
			);

			if (isBeforeCursor || isFarAway) {
				console.log("[Sweep] Edit detected as jump edit, showing decoration", {
					isBeforeCursor,
					isFarAway,
				});
				this.jumpEditManager.setPendingJumpEdit(document, result);
				return undefined;
			}

			// Clear any stale jump indicator
			this.jumpEditManager.clearJumpEdit();

			console.log("[Sweep] Rendering edit inline", {
				cursorLine: position.line,
				editStartLine: document.positionAt(result.startIndex).line,
			});
			const metricsPayload = this.buildMetricsPayload(document, result, {
				suggestionType: "GHOST_TEXT",
			});
			return this.buildCompletionItems(
				document,
				position,
				result,
				metricsPayload,
			);
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
		metricsPayload: AutocompleteMetricsPayload,
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
			completionPreview: result.completion.slice(0, 100),
		});

		// Use plain ghost text only for edits that start at or after the cursor
		// (standard API limitation). Edits before the cursor should be handled
		// via jump edit decoration.
		if (result.startIndex < cursorOffset) {
			console.log("[Sweep] Edit before cursor cannot be shown as ghost text");
			return undefined;
		}

		const item = new vscode.InlineCompletionItem(result.completion, editRange);
		item.command = {
			title: "Accept Sweep Inline Edit",
			command: "sweep.acceptInlineEdit",
			arguments: [metricsPayload],
		};
		this.lastInlineEdit = {
			uri: document.uri.toString(),
			line: position.line,
		};

		this.metricsTracker.trackShown(metricsPayload);
		return { items: [item] };
	}

	async handleCursorMove(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<void> {
		if (!this.lastInlineEdit) return;
		const currentUri = document.uri.toString();
		if (currentUri !== this.lastInlineEdit.uri) {
			this.lastInlineEdit = null;
			await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
			return;
		}

		if (position.line !== this.lastInlineEdit.line) {
			console.log("[Sweep] Clearing inline edit: cursor moved away", {
				originalLine: this.lastInlineEdit.line,
				currentLine: position.line,
			});
			this.lastInlineEdit = null;
			await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
		}
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

	private buildMetricsPayload(
		document: vscode.TextDocument,
		result: AutocompleteResult,
		options?: { suggestionType?: AutocompleteMetricsPayload["suggestionType"] },
	): AutocompleteMetricsPayload {
		const { additions, deletions } = computeAdditionsDeletions(
			document,
			result,
		);
		return {
			id: result.id,
			additions,
			deletions,
			suggestionType: options?.suggestionType ?? "GHOST_TEXT",
		};
	}
}
