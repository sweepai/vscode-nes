import * as vscode from "vscode";

import { InlineEditProvider } from "~/provider/inline-edit-provider.ts";
import { registerStatusBarCommands, SweepStatusBar } from "~/status-bar.ts";
import { DocumentTracker } from "~/tracking/document-tracker.ts";

const API_KEY_PROMPT_SHOWN = "sweep.apiKeyPromptShown";

let tracker: DocumentTracker;
let provider: InlineEditProvider;
let statusBar: SweepStatusBar;

export function activate(context: vscode.ExtensionContext) {
	promptForApiKeyIfNeeded(context);

	tracker = new DocumentTracker();
	provider = new InlineEditProvider(tracker);

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

	statusBar = new SweepStatusBar(context);
	const statusBarCommands = registerStatusBarCommands(context);

	const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
		if (event.document === vscode.window.activeTextEditor?.document) {
			tracker.trackChange(event);
		}
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
		changeListener,
		editorChangeListener,
		selectionChangeListener,
		tracker,
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

	const result = await vscode.window.showInputBox({
		prompt: "Enter your Sweep API key to enable autocomplete suggestions",
		placeHolder: "sk-...",
		ignoreFocusOut: true,
		password: true,
	});

	if (result) {
		await config.update("apiKey", result, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage("Sweep API key saved successfully!");
	} else {
		const choice = await vscode.window.showWarningMessage(
			"No API key provided. Get your API key at https://app.sweep.dev/",
			"Open https://app.sweep.dev/",
			"Set API Key Later",
		);

		if (choice === "Open https://app.sweep.dev/") {
			vscode.env.openExternal(vscode.Uri.parse("https://app.sweep.dev/"));
		}
	}

	await context.globalState.update(API_KEY_PROMPT_SHOWN, true);
}

async function promptSetApiKey(): Promise<void> {
	const config = vscode.workspace.getConfiguration("sweep");
	const currentKey = config.get<string>("apiKey", "");

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
