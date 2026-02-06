import * as vscode from "vscode";

import type { ActionType, UserAction } from "~/api/schemas.ts";
import { formatRecentChangeDiff } from "~/telemetry/unified-diff.ts";
import { toUnixPath } from "~/utils/path.ts";
import { utf8ByteOffsetAt } from "~/utils/text.ts";

interface FileSnapshot {
	uri: string;
	content: string;
	timestamp: number;
	mtime?: number;
}

interface CursorSnapshot {
	line: number;
	timestamp: number;
}

interface ChangeSummary {
	timestamp: number;
	totalChars: number;
	totalLines: number;
}

export interface EditRecord {
	filepath: string;
	diff: string;
	timestamp: number;
}

export interface ContextFile {
	filepath: string;
	content: string;
	mtime?: number;
	cursorLine?: number;
}

export class DocumentTracker implements vscode.Disposable {
	private recentFiles = new Map<string, FileSnapshot>();
	private editHistory: EditRecord[] = [];
	private userActions: UserAction[] = [];
	private originalContents = new Map<string, string>();
	private documentContents = new Map<string, string>();
	private cursorPositions = new Map<string, CursorSnapshot>();
	private lastChangeSummaries = new Map<string, ChangeSummary>();
	private lastMultiLineSelections = new Map<string, number>();
	private maxRecentFiles = 10;
	private maxEditHistory = 10;
	private maxUserActions = 50;

	constructor() {
		for (const doc of vscode.workspace.textDocuments) {
			this.originalContents.set(doc.uri.toString(), doc.getText());
			this.documentContents.set(doc.uri.toString(), doc.getText());
		}
	}

	async trackFileVisit(document: vscode.TextDocument): Promise<void> {
		const uri = document.uri.toString();

		if (!this.originalContents.has(uri)) {
			this.originalContents.set(uri, document.getText());
		}
		this.documentContents.set(uri, document.getText());

		let mtime: number | undefined;
		try {
			const stat = await vscode.workspace.fs.stat(document.uri);
			mtime = Math.floor(stat.mtime / 1000);
		} catch {
			// File may not exist on disk (untitled, etc.)
		}

		const snapshot: FileSnapshot = {
			uri,
			content: document.getText(),
			timestamp: Date.now(),
			...(mtime !== undefined ? { mtime } : {}),
		};
		this.recentFiles.set(uri, snapshot);

		this.pruneRecentFiles();
	}

	trackChange(event: vscode.TextDocumentChangeEvent): void {
		const filepath = toUnixPath(event.document.fileName);
		const uri = event.document.uri.toString();
		const now = Date.now();
		const previousDocumentContent = this.documentContents.get(uri);
		let totalChars = 0;
		let totalLines = 0;
		const undoRedoActionType = this.getUndoRedoActionType(event.reason);
		let undoRedoPosition: vscode.Position | null = null;

		for (const change of event.contentChanges) {
			if (!change.text && change.rangeLength === 0) continue;
			const actionPosition = this.getPostChangePosition(event.document, change);

			this.cursorPositions.set(uri, {
				line: actionPosition.line,
				timestamp: now,
			});

			const diff = previousDocumentContent
				? formatRecentChangeDiff({
						filepath,
						previousContent: previousDocumentContent,
						range: change.range,
						rangeOffset: change.rangeOffset,
						rangeLength: change.rangeLength,
						newText: change.text,
					})
				: this.formatDiff(
						filepath,
						change.range,
						change.text,
						change.rangeLength,
					);
			if (diff) {
				this.editHistory.push({ filepath, diff, timestamp: now });
				this.pruneEditHistory();
			}

			if (undoRedoActionType) {
				undoRedoPosition = actionPosition;
			} else {
				const actionType = this.getActionType(change);
				const offset = utf8ByteOffsetAt(event.document, actionPosition);

				this.userActions.push({
					action_type: actionType,
					line_number: actionPosition.line,
					offset,
					file_path: filepath,
					timestamp: now,
				});
				this.pruneUserActions();
			}

			totalChars += change.text.length + change.rangeLength;
			const insertedLines = Math.max(0, change.text.split("\n").length - 1);
			const removedLines = change.range.end.line - change.range.start.line;
			totalLines += insertedLines + removedLines;
		}

		if (totalChars > 0 || totalLines > 0) {
			this.lastChangeSummaries.set(uri, {
				timestamp: now,
				totalChars,
				totalLines,
			});
		}

		if (undoRedoActionType && undoRedoPosition) {
			this.userActions.push({
				action_type: undoRedoActionType,
				line_number: undoRedoPosition.line,
				offset: utf8ByteOffsetAt(event.document, undoRedoPosition),
				file_path: filepath,
				timestamp: now,
			});
			this.pruneUserActions();
		}

		this.documentContents.set(uri, event.document.getText());
	}

	trackCursorMovement(
		document: vscode.TextDocument,
		position: vscode.Position,
	): void {
		const filepath = toUnixPath(document.fileName);
		const offset = utf8ByteOffsetAt(document, position);
		const uri = document.uri.toString();
		const timestamp = Date.now();

		this.cursorPositions.set(uri, {
			line: position.line,
			timestamp,
		});

		this.userActions.push({
			action_type: "CURSOR_MOVEMENT",
			line_number: position.line,
			offset,
			file_path: filepath,
			timestamp,
		});
		this.pruneUserActions();
	}

	trackSelectionChange(
		document: vscode.TextDocument,
		selections: readonly vscode.Selection[],
	): void {
		let hasMultiLine = false;
		for (const selection of selections) {
			if (selection.isEmpty) continue;
			if (selection.start.line !== selection.end.line) {
				hasMultiLine = true;
				break;
			}
		}

		if (hasMultiLine) {
			this.lastMultiLineSelections.set(document.uri.toString(), Date.now());
		}
	}

	private getActionType(
		change: vscode.TextDocumentContentChangeEvent,
	): ActionType {
		const isMultiChar = change.text.length > 1 || change.rangeLength > 1;

		if (change.rangeLength > 0 && change.text.length > 0) {
			return isMultiChar ? "INSERT_SELECTION" : "INSERT_CHAR";
		}
		if (change.rangeLength > 0) {
			return isMultiChar ? "DELETE_SELECTION" : "DELETE_CHAR";
		}
		return isMultiChar ? "INSERT_SELECTION" : "INSERT_CHAR";
	}

	private getPostChangePosition(
		document: vscode.TextDocument,
		change: vscode.TextDocumentContentChangeEvent,
	): vscode.Position {
		const insertionEndOffset = change.rangeOffset + change.text.length;
		const documentLength = document.getText().length;
		const clampedOffset = Math.max(
			0,
			Math.min(insertionEndOffset, documentLength),
		);
		return document.positionAt(clampedOffset);
	}

	private getUndoRedoActionType(
		reason: vscode.TextDocumentChangeReason | undefined,
	): Extract<ActionType, "UNDO" | "REDO"> | null {
		if (reason === vscode.TextDocumentChangeReason.Undo) {
			return "UNDO";
		}
		if (reason === vscode.TextDocumentChangeReason.Redo) {
			return "REDO";
		}
		return null;
	}

	getRecentContextFiles(excludeUri: string, maxFiles: number): ContextFile[] {
		return Array.from(this.recentFiles.entries())
			.filter(([uri]) => uri !== excludeUri)
			.sort((a, b) => b[1].timestamp - a[1].timestamp)
			.slice(0, maxFiles)
			.map(([, snapshot]) => {
				const cursor = this.cursorPositions.get(snapshot.uri);
				return {
					filepath: this.getRelativePath(snapshot.uri),
					content: snapshot.content,
					...(snapshot.mtime !== undefined ? { mtime: snapshot.mtime } : {}),
					...(cursor ? { cursorLine: cursor.line } : {}),
				};
			});
	}

	getEditDiffHistory(): EditRecord[] {
		return [...this.editHistory].sort((a, b) => b.timestamp - a.timestamp);
	}

	getUserActions(
		filePath: string,
		currentCursor?: { line: number; offset: number },
	): UserAction[] {
		const normalizedPath = toUnixPath(filePath);
		const actions = this.userActions.filter(
			(a) => a.file_path === normalizedPath,
		);

		if (!currentCursor) {
			return actions;
		}

		const lastAction = actions.at(-1);
		const cursorChanged =
			!lastAction ||
			lastAction.action_type !== "CURSOR_MOVEMENT" ||
			lastAction.line_number !== currentCursor.line ||
			lastAction.offset !== currentCursor.offset;
		if (!cursorChanged) {
			return actions;
		}

		return [
			...actions,
			{
				action_type: "CURSOR_MOVEMENT",
				line_number: currentCursor.line,
				offset: currentCursor.offset,
				file_path: normalizedPath,
				timestamp: Date.now(),
			},
		];
	}

	getOriginalContent(uri: string): string | undefined {
		return this.originalContents.get(uri);
	}

	wasRecentBulkChange(
		uri: string,
		options: {
			windowMs: number;
			charThreshold: number;
			lineThreshold: number;
		},
	): boolean {
		const summary = this.lastChangeSummaries.get(uri);
		if (!summary) return false;
		if (Date.now() - summary.timestamp > options.windowMs) return false;
		return (
			summary.totalChars >= options.charThreshold ||
			summary.totalLines >= options.lineThreshold
		);
	}

	wasRecentMultiLineSelection(uri: string, windowMs: number): boolean {
		const timestamp = this.lastMultiLineSelections.get(uri);
		if (!timestamp) return false;
		return Date.now() - timestamp <= windowMs;
	}

	resetOriginalContent(uri: string, content: string): void {
		this.originalContents.set(uri, content);
	}

	private formatDiff(
		filepath: string,
		range: vscode.Range,
		newText: string,
		deletedLength: number,
	): string | null {
		const deletedLines = deletedLength > 0 ? 1 : 0;
		const addedLines = newText ? newText.split("\n").length : 0;

		const lines = [
			`Index: ${filepath}`,
			"===================================================================",
			`@@ -${range.start.line + 1},${deletedLines} +${range.start.line + 1},${addedLines} @@`,
		];

		if (deletedLength > 0) {
			lines.push(`-[deleted ${deletedLength} characters]`);
		}
		if (newText) {
			for (const line of newText.split("\n")) {
				lines.push(`+${line}`);
			}
		}

		return lines.join("\n");
	}

	private getRelativePath(uri: string): string {
		try {
			const parsedUri = vscode.Uri.parse(uri);
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(parsedUri);
			if (workspaceFolder) {
				const relativePath = parsedUri.fsPath.slice(
					workspaceFolder.uri.fsPath.length + 1,
				);
				return toUnixPath(relativePath);
			}
			return toUnixPath(parsedUri.fsPath);
		} catch {
			return uri;
		}
	}

	private pruneRecentFiles(): void {
		if (this.recentFiles.size <= this.maxRecentFiles) return;

		const sorted = Array.from(this.recentFiles.entries()).sort(
			(a, b) => b[1].timestamp - a[1].timestamp,
		);
		this.recentFiles = new Map(sorted.slice(0, this.maxRecentFiles));
	}

	private pruneEditHistory(): void {
		if (this.editHistory.length > this.maxEditHistory) {
			this.editHistory = this.editHistory.slice(-this.maxEditHistory);
		}
	}

	private pruneUserActions(): void {
		if (this.userActions.length > this.maxUserActions) {
			this.userActions = this.userActions.slice(-this.maxUserActions);
		}
	}

	dispose(): void {
		this.recentFiles.clear();
		this.editHistory = [];
		this.userActions = [];
		this.originalContents.clear();
		this.documentContents.clear();
		this.cursorPositions.clear();
		this.lastChangeSummaries.clear();
		this.lastMultiLineSelections.clear();
	}
}
