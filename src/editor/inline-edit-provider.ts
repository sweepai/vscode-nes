import * as vscode from "vscode";
import type { ApiClient, AutocompleteInput } from "~/api/client.ts";
import type { AutocompleteResult } from "~/api/schemas.ts";
import { config } from "~/core/config";
import type { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import {
	type AutocompleteMetricsPayload,
	type AutocompleteMetricsTracker,
	buildMetricsPayload,
} from "~/telemetry/autocomplete-metrics.ts";
import type { DocumentTracker } from "~/telemetry/document-tracker.ts";

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
		character: number;
		version: number;
		payload: AutocompleteMetricsPayload;
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
		if (!config.enabled) return undefined;

		if (!this.api.apiKey) {
			this.promptForApiKey();
			return undefined;
		}

		const uri = document.uri.toString();
		const currentContent = document.getText();
		const requestSnapshot = {
			uri,
			version: document.version,
			position,
			content: currentContent,
		};
		const originalContent =
			this.tracker.getOriginalContent(uri) ?? currentContent;

		if (currentContent === originalContent) return undefined;

		if (token.isCancellationRequested) return undefined;

		try {
			const input = this.buildInput(document, position, originalContent);
			const result = await this.api.getAutocomplete(input);

			if (
				!config.enabled ||
				token.isCancellationRequested ||
				!result?.completion
			) {
				return undefined;
			}

			if (this.isRequestStale(requestSnapshot, token)) {
				console.log("[Sweep] Inline edit response stale; skipping render", {
					uri,
					requestVersion: requestSnapshot.version,
					currentVersion: document.version,
					requestLine: requestSnapshot.position.line,
					requestCharacter: requestSnapshot.position.character,
					contentMatches: requestSnapshot.content === document.getText(),
				});
				return undefined;
			}

			const normalizedResult = this.normalizeInlineResult(
				document,
				position,
				result,
			);
			if (!normalizedResult) return undefined;

			const oldContent = document.getText(
				new vscode.Range(
					document.positionAt(normalizedResult.startIndex),
					document.positionAt(normalizedResult.endIndex),
				),
			);
			if (
				this.trimNewlines(oldContent) ===
				this.trimNewlines(normalizedResult.completion)
			) {
				console.log(
					"[Sweep] Inline edit response is a no-op after trimming newlines; skipping render",
				);
				return undefined;
			}

			const cursorOffset = document.offsetAt(position);
			const isBeforeCursor = normalizedResult.startIndex < cursorOffset;
			const isFarAway = this.jumpEditManager.isJumpEdit(
				document,
				position,
				normalizedResult,
			);

			if (isBeforeCursor || isFarAway) {
				console.log("[Sweep] Edit detected as jump edit, showing decoration", {
					isBeforeCursor,
					isFarAway,
				});
				this.jumpEditManager.setPendingJumpEdit(document, normalizedResult);
				return undefined;
			}

			// Clear any stale jump indicator
			this.jumpEditManager.clearJumpEdit();

			console.log("[Sweep] Rendering edit inline", {
				cursorLine: position.line,
				editStartLine: document.positionAt(result.startIndex).line,
			});
			const metricsPayload = buildMetricsPayload(document, normalizedResult, {
				suggestionType: "GHOST_TEXT",
			});
			return this.buildCompletionItems(
				document,
				position,
				normalizedResult,
				metricsPayload,
			);
		} catch (error) {
			console.error("[Sweep] InlineEditProvider error:", error);
			return undefined;
		}
	}

	private promptForApiKey(): void {
		const now = Date.now();
		if (now - this.lastApiKeyPrompt < API_KEY_PROMPT_INTERVAL_MS) return;
		this.lastApiKeyPrompt = now;
		vscode.commands.executeCommand("sweep.setApiKey");
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

		if (this.lastInlineEdit?.payload.id !== metricsPayload.id) {
			void this.clearInlineEdit("replaced by new inline edit", {
				hideSuggestion: false,
			});
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
			character: position.character,
			version: document.version,
			payload: metricsPayload,
		};

		this.metricsTracker.trackShown(metricsPayload, {
			uri: document.uri,
			startLine: editRange.start.line,
			endLine: editRange.end.line,
		});
		return { items: [item] };
	}

	async handleCursorMove(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<void> {
		if (!this.lastInlineEdit) return;
		const currentUri = document.uri.toString();
		if (currentUri !== this.lastInlineEdit.uri) {
			console.log("[Sweep] Clearing inline edit: active document changed");
			this.clearInlineEdit("active document changed");
			return;
		}

		if (
			position.line !== this.lastInlineEdit.line ||
			position.character !== this.lastInlineEdit.character ||
			document.version !== this.lastInlineEdit.version
		) {
			console.log("[Sweep] Clearing inline edit: cursor moved away", {
				originalLine: this.lastInlineEdit.line,
				currentLine: position.line,
				originalCharacter: this.lastInlineEdit.character,
				currentCharacter: position.character,
				originalVersion: this.lastInlineEdit.version,
				currentVersion: document.version,
			});
			this.clearInlineEdit("cursor moved away");
		}
	}

	handleInlineAccept(payload: AutocompleteMetricsPayload): void {
		if (this.lastInlineEdit?.payload.id === payload.id) {
			this.lastInlineEdit = null;
		}
	}

	private clearInlineEdit(
		reason: string,
		options?: { trackDisposed?: boolean; hideSuggestion?: boolean },
	): void {
		if (!this.lastInlineEdit) return;
		const payload = this.lastInlineEdit.payload;
		const shouldTrackDisposed = options?.trackDisposed ?? true;
		const shouldHideSuggestion = options?.hideSuggestion ?? true;

		if (shouldTrackDisposed) {
			this.metricsTracker.trackDisposed(payload);
		}
		this.lastInlineEdit = null;

		if (shouldHideSuggestion) {
			void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
		}

		if (reason) {
			console.log("[Sweep] Inline edit cleared:", reason);
		}
	}

	private buildInput(
		document: vscode.TextDocument,
		position: vscode.Position,
		originalContent: string,
	): AutocompleteInput {
		const uri = document.uri.toString();
		const maxContextFiles = config.maxContextFiles;

		const recentBuffers = this.tracker
			.getRecentContextFiles(uri, maxContextFiles)
			.map((file) => ({
				path: file.filepath,
				content: file.content,
				...(file.mtime !== undefined ? { mtime: file.mtime } : {}),
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

	private normalizeInlineResult(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): AutocompleteResult | null {
		const cursorOffset = document.offsetAt(position);

		if (result.startIndex >= cursorOffset)
			return this.trimSuffixOverlap(document, position, result);

		const prefixBeforeCursor = document.getText(
			new vscode.Range(document.positionAt(result.startIndex), position),
		);

		if (!result.completion.startsWith(prefixBeforeCursor)) return result;

		const trimmedCompletion = result.completion.slice(
			prefixBeforeCursor.length,
		);
		if (trimmedCompletion.length === 0) return null;

		const trimmedResult: AutocompleteResult = {
			...result,
			startIndex: cursorOffset,
			endIndex: cursorOffset,
			completion: trimmedCompletion,
		};
		return this.trimSuffixOverlap(document, position, trimmedResult);
	}

	private trimSuffixOverlap(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): AutocompleteResult | null {
		if (!result.completion) return null;

		const cursorOffset = document.offsetAt(position);
		const documentLength = document.getText().length;
		const maxLookahead = Math.min(
			documentLength - cursorOffset,
			result.completion.length,
		);
		if (maxLookahead <= 0) return result;

		const followingText = document.getText(
			new vscode.Range(
				position,
				document.positionAt(cursorOffset + maxLookahead),
			),
		);

		let overlap = 0;
		for (let i = maxLookahead; i > 0; i--) {
			if (result.completion.endsWith(followingText.slice(0, i))) {
				overlap = i;
				break;
			}
		}

		if (overlap === 0) return result;

		const trimmedCompletion = result.completion.slice(
			0,
			result.completion.length - overlap,
		);
		if (trimmedCompletion.length === 0) return null;

		return { ...result, completion: trimmedCompletion };
	}

	private isRequestStale(
		snapshot: {
			uri: string;
			version: number;
			position: vscode.Position;
			content: string;
		},
		token: vscode.CancellationToken,
	): boolean {
		if (token.isCancellationRequested) return true;
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) return true;
		if (!vscode.window.state.focused) return true;
		if (activeEditor.document.uri.toString() !== snapshot.uri) return true;
		if (activeEditor.document.version !== snapshot.version) return true;
		if (activeEditor.document.getText() !== snapshot.content) return true;
		const activePosition = activeEditor.selection.active;
		return (
			activePosition.line !== snapshot.position.line ||
			activePosition.character !== snapshot.position.character
		);
	}

	private trimNewlines(text: string): string {
		return text.replace(/^\n+|\n+$/g, "");
	}
}
