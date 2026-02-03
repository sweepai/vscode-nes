import * as vscode from "vscode";

import { InlineEditProvider } from "~/provider/inline-edit-provider.ts";
import { JumpEditManager } from "~/provider/jump-edit-manager.ts";
import {
	initSyntaxHighlighter,
	reloadTheme,
} from "~/provider/syntax-highlight-renderer.ts";
import { registerStatusBarCommands, SweepStatusBar } from "~/status-bar.ts";
import { DocumentTracker } from "~/tracking/document-tracker.ts";

const API_KEY_PROMPT_SHOWN = "sweep.apiKeyPromptShown";

let tracker: DocumentTracker;
let jumpEditManager: JumpEditManager;
let provider: InlineEditProvider;
let statusBar: SweepStatusBar;

export function activate(context: vscode.ExtensionContext) {
	promptForApiKeyIfNeeded(context);

	initSyntaxHighlighter();

	tracker = new DocumentTracker();
	jumpEditManager = new JumpEditManager();
	provider = new InlineEditProvider(tracker, jumpEditManager);

	const providerDisposable =
		vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**/*" },
			provider,
		);

	const triggerCommand = vscode.commands.registerCommand(
		"sweep.triggerNextEdit",
		() => {
			vscode.commands.executeCommand("editor.action.inlineEdit.trigger");
		},
	);

	const setApiKeyCommand = vscode.commands.registerCommand(
		"sweep.setApiKey",
		promptSetApiKey,
	);

	const acceptJumpEditCommand = vscode.commands.registerCommand(
		"sweep.acceptJumpEdit",
		() => jumpEditManager.acceptJumpEdit(),
	);

	const dismissJumpEditCommand = vscode.commands.registerCommand(
		"sweep.dismissJumpEdit",
		() => jumpEditManager.dismissJumpEdit(),
	);

	statusBar = new SweepStatusBar(context);
	const statusBarCommands = registerStatusBarCommands(context);

	const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
		if (event.document === vscode.window.activeTextEditor?.document) {
			tracker.trackChange(event);
		}
	});

	const themeChangeListener = vscode.window.onDidChangeActiveColorTheme(() => {
		reloadTheme();
	});

	const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			if (editor) {
				tracker.trackFileVisit(editor.document);
			}
		},
	);

	const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(
		(event) => {
			if (event.textEditor === vscode.window.activeTextEditor) {
				for (const selection of event.selections) {
					tracker.trackCursorMovement(
						event.textEditor.document,
						selection.active,
					);
				}
			}
		},
	);

	if (vscode.window.activeTextEditor) {
		tracker.trackFileVisit(vscode.window.activeTextEditor.document);
	}

	context.subscriptions.push(
		providerDisposable,
		triggerCommand,
		setApiKeyCommand,
		acceptJumpEditCommand,
		dismissJumpEditCommand,
		changeListener,
		editorChangeListener,
		selectionChangeListener,
		themeChangeListener,
		tracker,
		jumpEditManager,
		statusBar,
		...statusBarCommands,
	);
}

export function deactivate() {}

async function promptForApiKeyIfNeeded(
	context: vscode.ExtensionContext,
): Promise<void> {
	const config = vscode.workspace.getConfiguration("sweep");
	const apiKey = config.get<string>("apiKey", "");

	if (apiKey) return;

	const hasPrompted = context.globalState.get<boolean>(
		API_KEY_PROMPT_SHOWN,
		false,
	);
	if (hasPrompted) return;

	await promptSetApiKey();

	await context.globalState.update(API_KEY_PROMPT_SHOWN, true);
}

async function promptSetApiKey(): Promise<void> {
	const config = vscode.workspace.getConfiguration("sweep");
	const currentKey = config.get<string>("apiKey", "");

	if (!currentKey) {
		vscode.env.openExternal(vscode.Uri.parse("https://app.sweep.dev/"));
	}

	const result = await vscode.window.showInputBox({
		prompt: "Enter your Sweep API key",
		placeHolder: currentKey ? `${currentKey.slice(0, 6)}...` : "sk-...",
		ignoreFocusOut: true,
		password: true,
	});

	if (result !== undefined) {
		await config.update("apiKey", result, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			result ? "Sweep API key saved!" : "Sweep API key cleared.",
		);
	}
}
