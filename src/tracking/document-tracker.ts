import * as vscode from "vscode";

import type { ActionType, UserAction } from "~/api/schemas.ts";
import { toUnixPath } from "~/utils/path.ts";

interface FileSnapshot {
	uri: string;
	content: string;
	timestamp: number;
	mtime?: number;
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
}

export class DocumentTracker implements vscode.Disposable {
	private recentFiles = new Map<string, FileSnapshot>();
	private editHistory: EditRecord[] = [];
	private userActions: UserAction[] = [];
	private originalContents = new Map<string, string>();
	private maxRecentFiles = 10;
	private maxEditHistory = 10;
	private maxUserActions = 50;

	constructor() {
		for (const doc of vscode.workspace.textDocuments) {
			this.originalContents.set(doc.uri.toString(), doc.getText());
		}
	}

	async trackFileVisit(document: vscode.TextDocument): Promise<void> {
		const uri = document.uri.toString();

		if (!this.originalContents.has(uri)) {
			this.originalContents.set(uri, document.getText());
		}

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
		const now = Date.now();

		for (const change of event.contentChanges) {
			if (!change.text && change.rangeLength === 0) continue;

			const diff = this.formatDiff(
				filepath,
				change.range,
				change.text,
				change.rangeLength,
			);
			if (diff) {
				this.editHistory.push({ filepath, diff, timestamp: now });
				this.pruneEditHistory();
			}

			const actionType = this.getActionType(change);
			const offset = event.document.offsetAt(change.range.start);

			this.userActions.push({
				action_type: actionType,
				line_number: change.range.start.line,
				offset,
				file_path: filepath,
				timestamp: now,
			});
			this.pruneUserActions();
		}
	}

	trackCursorMovement(
		document: vscode.TextDocument,
		position: vscode.Position,
	): void {
		const filepath = toUnixPath(document.fileName);
		const offset = document.offsetAt(position);

		this.userActions.push({
			action_type: "CURSOR_MOVEMENT",
			line_number: position.line,
			offset,
			file_path: filepath,
			timestamp: Date.now(),
		});
		this.pruneUserActions();
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

	getRecentContextFiles(excludeUri: string, maxFiles: number): ContextFile[] {
		return Array.from(this.recentFiles.entries())
			.filter(([uri]) => uri !== excludeUri)
			.sort((a, b) => b[1].timestamp - a[1].timestamp)
			.slice(0, maxFiles)
			.map(([, snapshot]) => ({
				filepath: this.getRelativePath(snapshot.uri),
				content: snapshot.content,
				...(snapshot.mtime !== undefined ? { mtime: snapshot.mtime } : {}),
			}));
	}

	getEditDiffHistory(): EditRecord[] {
		return [...this.editHistory].sort((a, b) => b.timestamp - a.timestamp);
	}

	getUserActions(filePath: string): UserAction[] {
		const normalizedPath = toUnixPath(filePath);
		return this.userActions.filter((a) => a.file_path === normalizedPath);
	}

	getOriginalContent(uri: string): string | undefined {
		return this.originalContents.get(uri);
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
	}
}
