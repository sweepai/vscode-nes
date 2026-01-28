import * as vscode from "vscode";

import type { AutocompleteResult } from "~/api/schemas.ts";

/**
 * Padding rows around the edit range. Matches Zed's behavior:
 * the edit range is expanded by this many rows on each side,
 * and if the cursor falls outside the padded range, it's a jump edit.
 */
const EDIT_RANGE_PADDING_ROWS = 2;

// Decoration at cursor showing jump hint
const HINT_DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
	after: {
		color: new vscode.ThemeColor("editorGhostText.foreground"),
		margin: "0 0 0 1em",
	},
	isWholeLine: true,
});

// Decoration at target showing deleted text (strikethrough)
const DELETE_DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
	textDecoration: "line-through",
});

// Decoration at target showing inserted text (ghost text style)
const INSERT_DECORATION_TYPE = vscode.window.createTextEditorDecorationType({
	after: {
		color: new vscode.ThemeColor("editorGhostText.foreground"),
	},
});

interface DiffRange {
	/** Offset from result.startIndex where the diff begins */
	startOffset: number;
	/** Text being deleted (from original) */
	deleteText: string;
	/** Text being inserted (from completion) */
	insertText: string;
}

interface PendingJumpEdit {
	result: AutocompleteResult;
	uri: string;
	targetLine: number;
	targetCharacter: number;
	diff: DiffRange;
}

export class JumpEditManager implements vscode.Disposable {
	private pendingJumpEdit: PendingJumpEdit | null = null;
	private disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (
					this.pendingJumpEdit &&
					event.document.uri.toString() === this.pendingJumpEdit.uri &&
					event.contentChanges.length > 0
				) {
					console.log("[Sweep] Jump edit cleared: source document changed");
					this.clearJumpEdit();
				}
			}),
			vscode.window.onDidChangeActiveTextEditor(() => {
				if (this.pendingJumpEdit) {
					console.log("[Sweep] Jump edit cleared: active editor changed");
					this.clearJumpEdit();
				}
			}),
		);
	}

	/**
	 * Returns true if the edit is far enough from the cursor to be a jump edit.
	 * Mirrors Zed's logic: pad the edit range by 2 rows on each side,
	 * and if the cursor is outside that padded range, it's a jump.
	 */
	isJumpEdit(
		document: vscode.TextDocument,
		cursorPosition: vscode.Position,
		result: AutocompleteResult,
	): boolean {
		const editStartLine = document.positionAt(result.startIndex).line;
		const editEndLine = document.positionAt(result.endIndex).line;
		const cursorLine = cursorPosition.line;

		const paddedStart = Math.max(0, editStartLine - EDIT_RANGE_PADDING_ROWS);
		const paddedEnd = Math.min(
			document.lineCount - 1,
			editEndLine + EDIT_RANGE_PADDING_ROWS,
		);

		const isJump = cursorLine < paddedStart || cursorLine > paddedEnd;

		console.log("[Sweep] Jump edit check:", {
			cursorLine,
			editStartLine,
			editEndLine,
			paddedStart,
			paddedEnd,
			isJump,
		});

		return isJump;
	}

	setPendingJumpEdit(
		document: vscode.TextDocument,
		result: AutocompleteResult,
	): void {
		this.clearJumpEdit();

		// Find the actual diff within the replacement range
		const diff = this.computeDiff(document, result);
		const targetPosition = document.positionAt(
			result.startIndex + diff.startOffset,
		);

		this.pendingJumpEdit = {
			result,
			uri: document.uri.toString(),
			targetLine: targetPosition.line,
			targetCharacter: targetPosition.character,
			diff,
		};

		console.log("[Sweep] Jump edit set:", {
			targetLine: targetPosition.line + 1,
			targetChar: targetPosition.character,
			deleteText: diff.deleteText.slice(0, 40),
			insertText: diff.insertText.slice(0, 40),
			startIndex: result.startIndex,
			endIndex: result.endIndex,
		});

		vscode.commands.executeCommand("setContext", "sweep.hasJumpEdit", true);
		this.showDecorations(document);
	}

	/**
	 * Compute the minimal diff between original and completion text.
	 * Finds common prefix and suffix to isolate the actual change.
	 */
	private computeDiff(
		document: vscode.TextDocument,
		result: AutocompleteResult,
	): DiffRange {
		const originalText = document.getText(
			new vscode.Range(
				document.positionAt(result.startIndex),
				document.positionAt(result.endIndex),
			),
		);
		const newText = result.completion;

		// Find common prefix
		let prefixLen = 0;
		const minLen = Math.min(originalText.length, newText.length);
		while (
			prefixLen < minLen &&
			originalText[prefixLen] === newText[prefixLen]
		) {
			prefixLen++;
		}

		// Find common suffix (but don't overlap with prefix)
		let suffixLen = 0;
		while (
			suffixLen < minLen - prefixLen &&
			originalText[originalText.length - 1 - suffixLen] ===
				newText[newText.length - 1 - suffixLen]
		) {
			suffixLen++;
		}

		return {
			startOffset: prefixLen,
			deleteText: originalText.slice(
				prefixLen,
				originalText.length - suffixLen,
			),
			insertText: newText.slice(prefixLen, newText.length - suffixLen),
		};
	}

	async acceptJumpEdit(): Promise<void> {
		if (!this.pendingJumpEdit) {
			console.log("[Sweep] acceptJumpEdit called but no pending jump edit");
			return;
		}

		const editor = vscode.window.activeTextEditor;
		if (
			!editor ||
			editor.document.uri.toString() !== this.pendingJumpEdit.uri
		) {
			console.log(
				"[Sweep] acceptJumpEdit: editor mismatch, clearing jump edit",
			);
			this.clearJumpEdit();
			return;
		}

		const { result } = this.pendingJumpEdit;
		const targetPos = new vscode.Position(
			this.pendingJumpEdit.targetLine,
			this.pendingJumpEdit.targetCharacter,
		);

		console.log("[Sweep] Accepting jump edit, applying change", {
			targetLine: targetPos.line + 1,
			targetChar: targetPos.character,
			startIndex: result.startIndex,
		});

		// Apply the edit directly using WorkspaceEdit
		const editRange = new vscode.Range(
			editor.document.positionAt(result.startIndex),
			editor.document.positionAt(result.endIndex),
		);

		const workspaceEdit = new vscode.WorkspaceEdit();
		workspaceEdit.replace(editor.document.uri, editRange, result.completion);

		// Clear state before applying edit (to avoid triggering our own change listener)
		const pendingEdit = this.pendingJumpEdit;
		this.pendingJumpEdit = null;
		this.clearDecorations();
		vscode.commands.executeCommand("setContext", "sweep.hasJumpEdit", false);

		// Apply the edit
		const success = await vscode.workspace.applyEdit(workspaceEdit);

		if (success) {
			// Move cursor to where the change was made
			const newTargetPos = new vscode.Position(
				pendingEdit.targetLine,
				pendingEdit.targetCharacter + pendingEdit.diff.insertText.length,
			);
			editor.selection = new vscode.Selection(newTargetPos, newTargetPos);
			editor.revealRange(
				new vscode.Range(newTargetPos, newTargetPos),
				vscode.TextEditorRevealType.InCenter,
			);
			console.log("[Sweep] Jump edit applied successfully");
		} else {
			console.error("[Sweep] Failed to apply jump edit");
		}
	}

	consumePendingInlineEdit(_documentUri: string): AutocompleteResult | null {
		// No longer used in compat mode, but kept for potential future use
		return null;
	}

	dismissJumpEdit(): void {
		console.log("[Sweep] Jump edit dismissed by user");
		this.clearJumpEdit();
	}

	clearJumpEdit(): void {
		const hadPending = this.pendingJumpEdit !== null;
		this.pendingJumpEdit = null;
		this.clearDecorations();
		vscode.commands.executeCommand("setContext", "sweep.hasJumpEdit", false);
		if (hadPending) {
			console.log("[Sweep] Jump edit state cleared");
		}
	}

	private showDecorations(document: vscode.TextDocument): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !this.pendingJumpEdit) {
			return;
		}

		const { result, diff, targetLine } = this.pendingJumpEdit;
		const cursorLine = editor.selection.active.line;

		// Hint at cursor location
		const hintDecoration: vscode.DecorationOptions = {
			range: new vscode.Range(cursorLine, 0, cursorLine, 0),
			renderOptions: {
				after: {
					contentText: `→ Edit at line ${targetLine + 1} (Tab to apply)`,
				},
			},
		};
		editor.setDecorations(HINT_DECORATION_TYPE, [hintDecoration]);

		// Preview at target location
		const diffStartPos = document.positionAt(
			result.startIndex + diff.startOffset,
		);

		// Show strikethrough for deleted text (if any)
		if (diff.deleteText.length > 0) {
			const deleteEndPos = document.positionAt(
				result.startIndex + diff.startOffset + diff.deleteText.length,
			);
			const deleteDecoration: vscode.DecorationOptions = {
				range: new vscode.Range(diffStartPos, deleteEndPos),
			};
			editor.setDecorations(DELETE_DECORATION_TYPE, [deleteDecoration]);
		} else {
			editor.setDecorations(DELETE_DECORATION_TYPE, []);
		}

		// Show ghost text for inserted text (if any)
		if (diff.insertText.length > 0) {
			// Truncate long insertions for display
			const displayText =
				diff.insertText.length > 60
					? `${diff.insertText.slice(0, 57)}...`
					: diff.insertText;

			// For pure insertions, show after the position
			// For replacements, show after the deleted text position
			const insertPos =
				diff.deleteText.length > 0
					? document.positionAt(
							result.startIndex + diff.startOffset + diff.deleteText.length,
						)
					: diffStartPos;

			const insertDecoration: vscode.DecorationOptions = {
				range: new vscode.Range(insertPos, insertPos),
				renderOptions: {
					after: {
						contentText: displayText.replace(/\n/g, "↵"),
					},
				},
			};
			editor.setDecorations(INSERT_DECORATION_TYPE, [insertDecoration]);
		} else {
			editor.setDecorations(INSERT_DECORATION_TYPE, []);
		}
	}

	private clearDecorations(): void {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			editor.setDecorations(HINT_DECORATION_TYPE, []);
			editor.setDecorations(DELETE_DECORATION_TYPE, []);
			editor.setDecorations(INSERT_DECORATION_TYPE, []);
		}
	}

	dispose(): void {
		this.clearJumpEdit();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}
}
