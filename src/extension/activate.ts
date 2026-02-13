import * as vscode from "vscode";

import { ApiClient } from "~/api/client.ts";
import { config } from "~/core/config";
import { InlineEditProvider } from "~/editor/inline-edit-provider.ts";
import { JumpEditManager } from "~/editor/jump-edit-manager.ts";
import {
	initSyntaxHighlighter,
	reloadTheme,
} from "~/editor/syntax-highlight-renderer.ts";
import {
	registerStatusBarCommands,
	SweepStatusBar,
} from "~/extension/status-bar.ts";
import { LocalAutocompleteServer } from "~/services/local-server.ts";
import {
	type AutocompleteMetricsPayload,
	AutocompleteMetricsTracker,
} from "~/telemetry/autocomplete-metrics.ts";
import { DocumentTracker } from "~/telemetry/document-tracker.ts";

const API_KEY_PROMPT_SHOWN = "sweep.apiKeyPromptShown";

let tracker: DocumentTracker;
let jumpEditManager: JumpEditManager;
let provider: InlineEditProvider;
let statusBar: SweepStatusBar;
let metricsTracker: AutocompleteMetricsTracker;
let localServer: LocalAutocompleteServer;

export function activate(context: vscode.ExtensionContext) {
	promptForApiKeyIfNeeded(context);

	initSyntaxHighlighter();

	tracker = new DocumentTracker();
	localServer = new LocalAutocompleteServer();
	const apiClient = new ApiClient(undefined, undefined, localServer);
	metricsTracker = new AutocompleteMetricsTracker(apiClient);
	jumpEditManager = new JumpEditManager(metricsTracker);
	provider = new InlineEditProvider(
		tracker,
		jumpEditManager,
		apiClient,
		metricsTracker,
	);
	const refreshTheme = () => {
		reloadTheme();
		jumpEditManager.refreshJumpEditDecorations();
	};

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

	const acceptInlineEditCommand = vscode.commands.registerCommand(
		"sweep.acceptInlineEdit",
		(
			payload: AutocompleteMetricsPayload | undefined,
			acceptedSuggestion:
				| {
						id: string;
						startIndex: number;
						endIndex: number;
						completion: string;
				  }
				| undefined,
		) => {
			if (!payload) return;
			provider.handleInlineAccept(payload, acceptedSuggestion);
			metricsTracker.trackAccepted(payload);
		},
	);

	const dismissJumpEditCommand = vscode.commands.registerCommand(
		"sweep.dismissJumpEdit",
		() => jumpEditManager.dismissJumpEdit(),
	);

	statusBar = new SweepStatusBar(context);
	const statusBarCommands = registerStatusBarCommands(context, localServer);

	const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
		if (event.document === vscode.window.activeTextEditor?.document) {
			tracker.trackChange(event);
		}
	});

	const themeChangeListener = vscode.window.onDidChangeActiveColorTheme(() => {
		refreshTheme();
	});
	const themeConfigListener = vscode.workspace.onDidChangeConfiguration(
		(event) => {
			if (!event.affectsConfiguration("workbench.colorTheme")) return;
			// The colorTheme setting can update slightly after the active theme event.
			setTimeout(() => {
				refreshTheme();
			}, 0);
		},
	);

	const handleCursorMove = (editor: vscode.TextEditor): void => {
		void provider.handleCursorMove(editor.document, editor.selection.active);
		jumpEditManager.handleCursorMove(editor.selection.active);
	};

	const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			if (editor) {
				tracker.trackFileVisit(editor.document);
				handleCursorMove(editor);
			}
		},
	);

	const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(
		(event) => {
			if (event.textEditor === vscode.window.activeTextEditor) {
				tracker.trackSelectionChange(
					event.textEditor.document,
					event.selections,
				);
				for (const selection of event.selections) {
					tracker.trackCursorMovement(
						event.textEditor.document,
						selection.active,
					);
				}
				handleCursorMove(event.textEditor);
			}
		},
	);

	if (vscode.window.activeTextEditor) {
		tracker.trackFileVisit(vscode.window.activeTextEditor.document);
		handleCursorMove(vscode.window.activeTextEditor);
	}

	context.subscriptions.push(
		providerDisposable,
		triggerCommand,
		setApiKeyCommand,
		acceptJumpEditCommand,
		acceptInlineEditCommand,
		dismissJumpEditCommand,
		changeListener,
		editorChangeListener,
		selectionChangeListener,
		themeChangeListener,
		themeConfigListener,
		tracker,
		jumpEditManager,
		metricsTracker,
		statusBar,
		localServer,
		...statusBarCommands,
	);

	// Auto-start local server if local mode is enabled
	if (config.localMode) {
		localServer.ensureServerRunning().catch((error) => {
			console.error("[Sweep] Failed to auto-start local server:", error);
		});
	}
}

export function deactivate() {}

async function promptForApiKeyIfNeeded(
	context: vscode.ExtensionContext,
): Promise<void> {
	const apiKey = config.apiKey;

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
	const currentKey = config.apiKey ?? "";

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
		await config.setApiKey(result, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			result ? "Sweep API key saved!" : "Sweep API key cleared.",
		);
	}
}
