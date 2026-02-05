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
import { toUnixPath } from "~/utils/path.ts";
import { isFileTooLarge, utf8ByteOffsetAt } from "~/utils/text.ts";

const API_KEY_PROMPT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INLINE_REQUEST_DEBOUNCE_MS = 300;
const MAX_FILE_CHUNK_LINES = 60;
const BULK_CHANGE_LOOKBACK_MS = 1500;
const BULK_CHANGE_CHAR_THRESHOLD = 200;
const BULK_CHANGE_LINE_THRESHOLD = 8;
const SELECTION_LOOKBACK_MS = 5000;

interface QueuedSuggestionState {
	uri: string;
	suggestions: AutocompleteResult[];
}

interface AcceptedInlineSuggestion {
	id: string;
	startIndex: number;
	endIndex: number;
	completion: string;
}

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
	private queuedSuggestions: QueuedSuggestionState | null = null;
	private shouldConsumeQueuedSuggestion = false;
	private requestCounter = 0;
	private latestRequestId = 0;
	private inFlightRequest: {
		id: number;
		controller: AbortController;
		uri: string;
	} | null = null;
	private lastRequestTimestamp = 0;

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
		const requestId = ++this.requestCounter;
		this.latestRequestId = requestId;
		this.cancelInFlightRequest("superseded by new request");

		if (!config.enabled) return undefined;
		if (config.isAutocompleteSnoozed()) return undefined;

		if (!this.api.apiKey) {
			this.promptForApiKey();
			return undefined;
		}

		const suppressionReason = await this.getSuppressionReason(document);
		if (suppressionReason) {
			console.log("[Sweep] Suppressing inline edit:", suppressionReason);
			return undefined;
		}

		const uri = document.uri.toString();
		const filePath = document.uri.fsPath;
		if (filePath && config.shouldExcludeFromAutocomplete(filePath)) {
			return undefined;
		}
		const currentContent = document.getText();
		const requestSnapshot = {
			uri,
			version: document.version,
			position,
			content: currentContent,
		};
		const originalContent =
			this.tracker.getOriginalContent(uri) ?? currentContent;

		if (isFileTooLarge(currentContent) || isFileTooLarge(originalContent)) {
			console.log("[Sweep] Skipping inline edit: file too large", {
				uri,
				currentLength: currentContent.length,
				originalLength: originalContent.length,
			});
			return undefined;
		}

		if (currentContent === originalContent) return undefined;
		if (this.shouldConsumeQueuedSuggestion) {
			const queuedItems = this.consumeQueuedSuggestion(document, position);
			if (queuedItems) {
				return queuedItems;
			}
		}

		if (token.isCancellationRequested) return undefined;

		const shouldContinue = await this.waitForDebounce(requestId, token);
		if (!shouldContinue) return undefined;
		if (!this.isLatestRequest(requestId)) return undefined;

		const controller = new AbortController();
		this.inFlightRequest = { id: requestId, controller, uri };
		const cancellation = token.onCancellationRequested(() => {
			controller.abort();
		});

		try {
			const input = this.buildInput(document, position, originalContent);
			const responseResults = await this.api.getAutocomplete(
				input,
				controller.signal,
			);

			if (
				!config.enabled ||
				token.isCancellationRequested ||
				controller.signal.aborted ||
				!responseResults?.length
			) {
				return undefined;
			}

			const isLatestRequest = this.isLatestRequest(requestId);
			let results = responseResults;
			if (!isLatestRequest) {
				const extendedResults = this.tryBuildGhostTextExtension(
					requestSnapshot,
					document,
					responseResults,
				);
				if (!extendedResults?.length) {
					return undefined;
				}
				results = extendedResults;
			}

			if (isLatestRequest && this.isRequestStale(requestSnapshot, token)) {
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

			const renderSuppressionReason = await this.getSuppressionReason(document);
			if (renderSuppressionReason) {
				console.log(
					"[Sweep] Suppressing inline edit render:",
					renderSuppressionReason,
				);
				return undefined;
			}

			this.clearSuggestionQueue("superseded by fresh response");

			let renderMode: "INLINE" | "JUMP" | null = null;
			const inlineResults: AutocompleteResult[] = [];
			let jumpResult: AutocompleteResult | null = null;

			for (const result of results) {
				const normalizedResult = this.normalizeInlineResult(
					document,
					position,
					result,
				);
				if (!normalizedResult) {
					continue;
				}

				if (this.isNoOpSuggestion(document, normalizedResult)) {
					continue;
				}

				const classification = this.jumpEditManager.classifyEditDisplay(
					document,
					position,
					normalizedResult,
				);
				if (classification.decision === "SUPPRESS") {
					console.log(
						"[Sweep] Suppressing suggestion after display classification",
						{
							reason: classification.reason,
							id: normalizedResult.id,
						},
					);
					continue;
				}

				if (classification.decision === "JUMP") {
					if (!renderMode) {
						renderMode = "JUMP";
						jumpResult = normalizedResult;
					}
					continue;
				}

				if (!renderMode) {
					renderMode = "INLINE";
				}
				if (renderMode === "INLINE") {
					inlineResults.push(normalizedResult);
				}
			}

			if (renderMode === "JUMP" && jumpResult) {
				this.clearSuggestionQueue("jump suggestion takes precedence");
				console.log(
					"[Sweep] Edit classified as jump edit, showing decoration",
					{
						id: jumpResult.id,
					},
				);
				this.jumpEditManager.setPendingJumpEdit(document, jumpResult);
				return undefined;
			}

			if (inlineResults.length === 0) {
				this.jumpEditManager.clearJumpEdit();
				this.clearSuggestionQueue("no renderable inline suggestions");
				return undefined;
			}
			const firstInlineResult = inlineResults[0];
			if (!firstInlineResult) {
				this.jumpEditManager.clearJumpEdit();
				this.clearSuggestionQueue("missing first inline suggestion");
				return undefined;
			}
			this.setSuggestionQueue(uri, inlineResults.slice(1));

			// Clear any stale jump indicator
			this.jumpEditManager.clearJumpEdit();

			console.log("[Sweep] Rendering inline edit suggestions", {
				count: inlineResults.length,
				cursorLine: position.line,
				firstEditStartLine: document.positionAt(firstInlineResult.startIndex)
					.line,
			});
			return this.buildCompletionItem(document, position, firstInlineResult);
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				return undefined;
			}
			console.error("[Sweep] InlineEditProvider error:", error);
			return undefined;
		} finally {
			cancellation.dispose();
			if (this.inFlightRequest?.id === requestId) {
				this.inFlightRequest = null;
			}
		}
	}

	private promptForApiKey(): void {
		const now = Date.now();
		if (now - this.lastApiKeyPrompt < API_KEY_PROMPT_INTERVAL_MS) return;
		this.lastApiKeyPrompt = now;
		vscode.commands.executeCommand("sweep.setApiKey");
	}

	private cancelInFlightRequest(reason: string): void {
		if (!this.inFlightRequest) return;
		console.log("[Sweep] Cancelling in-flight inline edit request:", reason);
		this.inFlightRequest.controller.abort();
		this.inFlightRequest = null;
	}

	private async getSuppressionReason(
		document: vscode.TextDocument,
	): Promise<string | null> {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) return "no active editor";
		if (activeEditor.document.uri.toString() !== document.uri.toString()) {
			return "inactive document";
		}
		if (!vscode.window.state.focused) return "window not focused";

		if (
			this.hasMultiLineSelection(activeEditor, document) ||
			this.tracker.wasRecentMultiLineSelection(
				document.uri.toString(),
				SELECTION_LOOKBACK_MS,
			)
		) {
			return "multi-line selection";
		}

		const editorTextFocus =
			await this.getContextKeyValue<boolean>("editorTextFocus");
		if (editorTextFocus === false) return "editor not focused";

		const isWritable = vscode.workspace.fs.isWritableFileSystem(
			document.uri.scheme,
		);
		if (isWritable === false) return "read-only document";

		const inSnippetMode =
			await this.getContextKeyValue<boolean>("inSnippetMode");
		if (inSnippetMode) return "snippet/template mode";

		const uri = document.uri.toString();
		if (
			this.tracker.wasRecentBulkChange(uri, {
				windowMs: BULK_CHANGE_LOOKBACK_MS,
				charThreshold: BULK_CHANGE_CHAR_THRESHOLD,
				lineThreshold: BULK_CHANGE_LINE_THRESHOLD,
			})
		) {
			return "recent bulk edit";
		}

		return null;
	}

	private async getContextKeyValue<T>(key: string): Promise<T | undefined> {
		try {
			return (await vscode.commands.executeCommand(
				"getContextKeyValue",
				key,
			)) as T | undefined;
		} catch {
			return undefined;
		}
	}

	private hasMultiLineSelection(
		editor: vscode.TextEditor,
		document: vscode.TextDocument,
	): boolean {
		for (const selection of editor.selections) {
			if (selection.isEmpty) continue;
			if (selection.start.line !== selection.end.line) return true;
			const selectedText = document.getText(selection);
			if (selectedText.includes("\n")) return true;
		}
		return false;
	}

	private async waitForDebounce(
		requestId: number,
		token: vscode.CancellationToken,
	): Promise<boolean> {
		const now = Date.now();
		const elapsed = now - this.lastRequestTimestamp;
		this.lastRequestTimestamp = now;

		const delay = Math.max(0, INLINE_REQUEST_DEBOUNCE_MS - elapsed);
		if (delay === 0) return !token.isCancellationRequested;

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				resolve();
			}, delay);
			const disposable = token.onCancellationRequested(() => {
				clearTimeout(timeout);
				disposable.dispose();
				resolve();
			});
		});
		if (token.isCancellationRequested) return false;
		return this.isLatestRequest(requestId);
	}

	private isLatestRequest(requestId: number): boolean {
		return requestId === this.latestRequestId;
	}

	private buildCompletionItem(
		document: vscode.TextDocument,
		position: vscode.Position,
		result: AutocompleteResult,
	): vscode.InlineCompletionList | undefined {
		const cursorOffset = document.offsetAt(position);
		const startPosition = document.positionAt(result.startIndex);
		const endPosition = document.positionAt(result.endIndex);
		const editRange = new vscode.Range(startPosition, endPosition);
		const metricsPayload = buildMetricsPayload(document, result, {
			suggestionType: "GHOST_TEXT",
		});

		console.log("[Sweep] Creating inline edit:", {
			id: result.id,
			startPosition: `${startPosition.line}:${startPosition.character}`,
			endPosition: `${endPosition.line}:${endPosition.character}`,
			cursorPosition: `${position.line}:${position.character}`,
			cursorOffset,
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completionPreview: result.completion.slice(0, 100),
		});

		if (result.startIndex < cursorOffset) {
			console.log("[Sweep] Edit before cursor cannot be shown as ghost text", {
				id: result.id,
			});
			return undefined;
		}

		if (this.lastInlineEdit?.payload.id !== metricsPayload.id) {
			void this.clearInlineEdit("replaced by new inline edit", {
				hideSuggestion: false,
			});
		}

		const acceptedSuggestion: AcceptedInlineSuggestion = {
			id: result.id,
			startIndex: result.startIndex,
			endIndex: result.endIndex,
			completion: result.completion,
		};
		const item = new vscode.InlineCompletionItem(result.completion, editRange);
		item.command = {
			title: "Accept Sweep Inline Edit",
			command: "sweep.acceptInlineEdit",
			arguments: [metricsPayload, acceptedSuggestion],
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
			startOffset: result.startIndex,
			endOffset: result.endIndex,
		});
		return { items: [item] };
	}

	async handleCursorMove(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<void> {
		if (
			this.queuedSuggestions &&
			this.queuedSuggestions.uri !== document.uri.toString()
		) {
			this.clearSuggestionQueue("active document changed");
		}

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

	handleInlineAccept(
		payload: AutocompleteMetricsPayload,
		acceptedSuggestion?: AcceptedInlineSuggestion,
	): void {
		if (this.lastInlineEdit?.payload.id === payload.id) {
			this.lastInlineEdit = null;
		}
		if (!acceptedSuggestion) return;
		this.adjustQueuedSuggestionsAfterAccept(acceptedSuggestion);
		if (this.queuedSuggestions?.suggestions.length) {
			this.shouldConsumeQueuedSuggestion = true;
			void vscode.commands.executeCommand(
				"editor.action.inlineSuggest.trigger",
			);
			return;
		}
		this.clearSuggestionQueue("accepted suggestion exhausted queue");
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
		this.clearSuggestionQueue(reason ? `inline cleared: ${reason}` : undefined);

		if (shouldHideSuggestion) {
			void vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
		}

		if (reason) {
			console.log("[Sweep] Inline edit cleared:", reason);
		}
	}

	private setSuggestionQueue(
		uri: string,
		suggestions: AutocompleteResult[],
	): void {
		if (suggestions.length === 0) {
			this.queuedSuggestions = null;
			this.shouldConsumeQueuedSuggestion = false;
			return;
		}
		this.queuedSuggestions = { uri, suggestions: [...suggestions] };
		this.shouldConsumeQueuedSuggestion = false;
	}

	private clearSuggestionQueue(reason?: string): void {
		const hadQueuedSuggestions = this.queuedSuggestions !== null;
		this.queuedSuggestions = null;
		this.shouldConsumeQueuedSuggestion = false;
		if (reason && hadQueuedSuggestions) {
			console.log("[Sweep] Cleared queued suggestions:", reason);
		}
	}

	private consumeQueuedSuggestion(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.InlineCompletionList | undefined {
		const queue = this.queuedSuggestions;
		if (!queue || queue.suggestions.length === 0) return undefined;
		const uri = document.uri.toString();
		if (queue.uri !== uri) {
			this.clearSuggestionQueue("active document changed");
			return undefined;
		}

		while (queue.suggestions.length > 0) {
			const next = queue.suggestions.shift();
			if (!next) break;
			const normalized = this.normalizeInlineResult(document, position, next);
			if (!normalized) continue;
			if (this.isNoOpSuggestion(document, normalized)) continue;

			const classification = this.jumpEditManager.classifyEditDisplay(
				document,
				position,
				normalized,
			);
			if (classification.decision === "SUPPRESS") {
				continue;
			}
			if (classification.decision === "JUMP") {
				console.log("[Sweep] Rendering queued suggestion as jump edit", {
					id: normalized.id,
					remaining: queue.suggestions.length,
				});
				this.jumpEditManager.setPendingJumpEdit(document, normalized);
				this.shouldConsumeQueuedSuggestion = false;
				return undefined;
			}

			console.log("[Sweep] Rendering queued inline edit suggestion", {
				id: normalized.id,
				remaining: queue.suggestions.length,
			});
			this.shouldConsumeQueuedSuggestion = false;
			return this.buildCompletionItem(document, position, normalized);
		}

		this.clearSuggestionQueue("queue exhausted");
		return undefined;
	}

	private adjustQueuedSuggestionsAfterAccept(
		acceptedSuggestion: AcceptedInlineSuggestion,
	): void {
		if (!this.queuedSuggestions?.suggestions.length) return;
		const replacementLength =
			acceptedSuggestion.endIndex - acceptedSuggestion.startIndex;
		const adjustment = acceptedSuggestion.completion.length - replacementLength;
		if (adjustment === 0) return;

		this.queuedSuggestions.suggestions = this.queuedSuggestions.suggestions
			.map((suggestion) => {
				if (suggestion.startIndex < acceptedSuggestion.startIndex) {
					return suggestion;
				}
				return {
					...suggestion,
					startIndex: suggestion.startIndex + adjustment,
					endIndex: suggestion.endIndex + adjustment,
				};
			})
			.filter((suggestion) => suggestion.completion.length > 0);
	}

	private isNoOpSuggestion(
		document: vscode.TextDocument,
		result: AutocompleteResult,
	): boolean {
		const oldContent = document.getText(
			new vscode.Range(
				document.positionAt(result.startIndex),
				document.positionAt(result.endIndex),
			),
		);
		const isNoOp =
			this.trimNewlines(oldContent) === this.trimNewlines(result.completion);
		if (isNoOp) {
			console.log(
				"[Sweep] Inline edit response is a no-op after trimming newlines; skipping render",
				{ id: result.id },
			);
		}
		return isNoOp;
	}

	private tryBuildGhostTextExtension(
		snapshot: {
			uri: string;
			version: number;
			position: vscode.Position;
			content: string;
		},
		document: vscode.TextDocument,
		results: AutocompleteResult[],
	): AutocompleteResult[] | null {
		const firstResult = results[0];
		if (!firstResult) return null;

		const currentText = document.getText();
		const snapshotCursorOffset = Math.min(
			document.offsetAt(snapshot.position),
			snapshot.content.length,
		);
		const userInsertedText = this.extractInsertedTextAtCursor(
			snapshot.content,
			currentText,
			snapshotCursorOffset,
		);
		if (!userInsertedText) return null;

		const suggestedText =
			snapshot.content.slice(0, firstResult.startIndex) +
			firstResult.completion +
			snapshot.content.slice(firstResult.endIndex);
		const suggestedInsertedText = this.extractInsertedTextAtCursor(
			snapshot.content,
			suggestedText,
			snapshotCursorOffset,
		);
		if (
			!suggestedInsertedText ||
			!suggestedInsertedText.startsWith(userInsertedText)
		) {
			return null;
		}

		const extendedCompletion = suggestedInsertedText.slice(
			userInsertedText.length,
		);
		if (!extendedCompletion) {
			return null;
		}

		const activeEditor = vscode.window.activeTextEditor;
		const currentCursorOffset =
			activeEditor?.document.uri.toString() === snapshot.uri
				? activeEditor.document.offsetAt(activeEditor.selection.active)
				: snapshotCursorOffset + userInsertedText.length;

		const adjustedFirst: AutocompleteResult = {
			...firstResult,
			startIndex: currentCursorOffset,
			endIndex: currentCursorOffset,
			completion: extendedCompletion,
		};
		const adjustmentOffset = userInsertedText.length;
		const adjustedRemainder = results.slice(1).map((result) => ({
			...result,
			startIndex: result.startIndex + adjustmentOffset,
			endIndex: result.endIndex + adjustmentOffset,
		}));

		console.log("[Sweep] Rendering extension from stale inline response", {
			id: adjustedFirst.id,
			adjustmentOffset,
		});

		return [adjustedFirst, ...adjustedRemainder];
	}

	private extractInsertedTextAtCursor(
		originalText: string,
		updatedText: string,
		cursorOffset: number,
	): string | null {
		const prefix = originalText.slice(0, cursorOffset);
		const suffix = originalText.slice(cursorOffset);
		if (!updatedText.startsWith(prefix) || !updatedText.endsWith(suffix)) {
			return null;
		}
		const insertedText = updatedText.slice(
			prefix.length,
			updatedText.length - suffix.length,
		);
		return insertedText.length > 0 ? insertedText : null;
	}

	private buildInput(
		document: vscode.TextDocument,
		position: vscode.Position,
		originalContent: string,
	): AutocompleteInput {
		const maxContextFiles = config.maxContextFiles;

		const recentBuffers = this.buildRecentBuffers(document, maxContextFiles);

		const recentChanges = this.tracker.getEditDiffHistory().map((record) => ({
			path: record.filepath,
			diff: record.diff,
		}));

		const userActions = this.tracker.getUserActions(document.fileName, {
			line: position.line,
			offset: utf8ByteOffsetAt(document, position),
		});

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

	private buildRecentBuffers(
		document: vscode.TextDocument,
		maxFiles: number,
	): AutocompleteInput["recentBuffers"] {
		const currentUri = document.uri.toString();
		const buffers: AutocompleteInput["recentBuffers"] = [];
		const seen = new Set<string>();

		const addBuffer = (buffer: AutocompleteInput["recentBuffers"][number]) => {
			if (seen.has(buffer.path)) return;
			seen.add(buffer.path);
			buffers.push(buffer);
		};

		for (const buffer of this.buildVisibleEditorBuffers(currentUri)) {
			addBuffer(buffer);
		}

		const recentFiles = this.tracker.getRecentContextFiles(
			currentUri,
			maxFiles * 2,
		);
		for (const file of recentFiles) {
			const buffer = this.buildBufferFromSnapshot(file);
			if (!buffer) continue;
			addBuffer(buffer);
		}

		return buffers.slice(0, maxFiles);
	}

	private buildVisibleEditorBuffers(
		currentUri: string,
	): AutocompleteInput["recentBuffers"] {
		const buffers: AutocompleteInput["recentBuffers"] = [];

		for (const editor of vscode.window.visibleTextEditors) {
			const document = editor.document;
			if (document.uri.toString() === currentUri) continue;

			const range = this.getPrimaryVisibleRange(editor);
			const focusLine = editor.selection.active.line;
			const chunk = this.buildChunkFromDocument(document, {
				visibleRange: range,
				focusLine,
			});
			if (!chunk) continue;

			buffers.push({
				path: this.getRelativePathForUri(document.uri),
				content: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
			});
		}

		return buffers;
	}

	private getPrimaryVisibleRange(
		editor: vscode.TextEditor,
	): vscode.Range | null {
		const ranges = editor.visibleRanges;
		if (ranges.length === 0) return null;

		const activeLine = editor.selection.active.line;
		const containingRange = ranges.find(
			(range) => activeLine >= range.start.line && activeLine <= range.end.line,
		);
		return containingRange ?? ranges[0] ?? null;
	}

	private buildBufferFromSnapshot(file: {
		filepath: string;
		content: string;
		mtime?: number;
		cursorLine?: number;
	}): AutocompleteInput["recentBuffers"][number] | null {
		if (isFileTooLarge(file.content)) return null;
		const lines = file.content.split("\n");
		const totalLines = lines.length;
		if (totalLines === 0) return null;

		const focusLine = file.cursorLine ?? 0;
		const { startLine, endLine } = this.buildLineWindow(
			0,
			totalLines,
			focusLine,
		);
		const content = lines.slice(startLine, endLine).join("\n");

		return {
			path: file.filepath,
			content,
			startLine,
			endLine,
			...(file.mtime !== undefined ? { mtime: file.mtime } : {}),
		};
	}

	private buildChunkFromDocument(
		document: vscode.TextDocument,
		options: {
			visibleRange: vscode.Range | null;
			focusLine: number;
		},
	): { content: string; startLine: number; endLine: number } | null {
		const totalLines = document.lineCount;
		if (totalLines === 0) return null;

		if (options.visibleRange) {
			const rangeStart = options.visibleRange.start.line;
			const rangeEnd = Math.min(totalLines, options.visibleRange.end.line + 1);
			if (rangeEnd - rangeStart <= MAX_FILE_CHUNK_LINES) {
				return this.buildChunkFromRange(document, rangeStart, rangeEnd);
			}
			const { startLine, endLine } = this.buildLineWindow(
				rangeStart,
				rangeEnd,
				options.focusLine,
			);
			return this.buildChunkFromRange(document, startLine, endLine);
		}

		const { startLine, endLine } = this.buildLineWindow(
			0,
			totalLines,
			options.focusLine,
		);
		return this.buildChunkFromRange(document, startLine, endLine);
	}

	private buildChunkFromRange(
		document: vscode.TextDocument,
		startLine: number,
		endLine: number,
	): { content: string; startLine: number; endLine: number } {
		const clampedStart = Math.max(0, Math.min(startLine, document.lineCount));
		const clampedEnd = Math.max(
			clampedStart,
			Math.min(endLine, document.lineCount),
		);
		const range = new vscode.Range(
			new vscode.Position(clampedStart, 0),
			new vscode.Position(clampedEnd, 0),
		);
		const content = document.getText(range);
		return { content, startLine: clampedStart, endLine: clampedEnd };
	}

	private buildLineWindow(
		minLine: number,
		maxLine: number,
		focusLine: number,
	): { startLine: number; endLine: number } {
		const span = Math.min(MAX_FILE_CHUNK_LINES, maxLine - minLine);
		if (span <= 0) return { startLine: minLine, endLine: minLine };

		const clampedFocus = Math.min(
			Math.max(focusLine, minLine),
			Math.max(minLine, maxLine - 1),
		);
		let startLine = clampedFocus - Math.floor(span / 2);
		startLine = Math.max(minLine, Math.min(startLine, maxLine - span));
		const endLine = startLine + span;
		return { startLine, endLine };
	}

	private getRelativePathForUri(uri: vscode.Uri): string {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
		if (workspaceFolder) {
			const relativePath = uri.fsPath.slice(
				workspaceFolder.uri.fsPath.length + 1,
			);
			return toUnixPath(relativePath);
		}
		return toUnixPath(uri.fsPath);
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
