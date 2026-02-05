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
import {
	type AutocompleteMetricsPayload,
	AutocompleteMetricsTracker,
} from "~/telemetry/autocomplete-metrics.ts";
import { DocumentTracker } from "~/telemetry/document-tracker.ts";

const API_KEY_PROMPT_SHOWN = "sweep.apiKeyPromptShown";
const ONBOARDING_COMPLETE = "sweep.onboardingComplete";
const MODE_COMMAND = "sweep.chooseMode";

let tracker: DocumentTracker;
let jumpEditManager: JumpEditManager;
let provider: InlineEditProvider;
let statusBar: SweepStatusBar;
let metricsTracker: AutocompleteMetricsTracker;

export async function activate(context: vscode.ExtensionContext) {
	const chosen = await maybeRunOnboarding(context);
	if (chosen !== "local") {
		promptForApiKeyIfNeeded(context);
	}

	initSyntaxHighlighter();

	tracker = new DocumentTracker();
	const apiClient = new ApiClient();
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
			vscode.commands
				.executeCommand("editor.action.inlineEdit.trigger")
				.then((result) => {
					if (result === undefined) {
						console.log(
							"[Sweep] Triggered inline edit command successfully",
						);
					}
				})
				.catch((error) => {
					console.error(
						"[Sweep] Failed to trigger inline edit command:",
						error,
					);
				});
		},
	);

	const setApiKeyCommand = vscode.commands.registerCommand(
		"sweep.setApiKey",
		promptSetApiKey,
	);

	const chooseModeCommand = vscode.commands.registerCommand(
		MODE_COMMAND,
		async () => {
			await chooseMode(context);
		},
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
	const statusBarCommands = registerStatusBarCommands(context);

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
		chooseModeCommand,
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
		...statusBarCommands,
	);
}

export function deactivate() {}

type ModeQuickPickItem = vscode.QuickPickItem & {
	mode: "local" | "hosted";
};

const MODE_QUICK_PICK_ITEMS: ModeQuickPickItem[] = [
	{
		label: "Local (llama.cpp)",
		description: "Use a local OpenAI-compatible server",
		mode: "local",
	},
	{
		label: "Hosted (Sweep API)",
		description: "Use Sweep's hosted service",
		mode: "hosted",
	},
];

async function chooseMode(
	context: vscode.ExtensionContext,
): Promise<"local" | "hosted" | null> {
	const pick = await vscode.window.showQuickPick(MODE_QUICK_PICK_ITEMS, {
		placeHolder: "Choose Sweep mode",
	});
	if (!pick) return null;
	await config.setMode(pick.mode, vscode.ConfigurationTarget.Global);
	await context.globalState.update(ONBOARDING_COMPLETE, true);
	return pick.mode;
}

async function maybeRunOnboarding(
	context: vscode.ExtensionContext,
): Promise<"local" | "hosted" | null> {
	const done = context.globalState.get<boolean>(ONBOARDING_COMPLETE, false);
	if (done) return null;
	return chooseMode(context);
}

async function promptForApiKeyIfNeeded(
	context: vscode.ExtensionContext,
): Promise<void> {
	if (config.mode === "local") return;

	const apiKey = config.apiKey;

	if (apiKey) return;

	const hasPrompted = context.globalState.get<boolean>(
		API_KEY_PROMPT_SHOWN,
		false,
	);
	if (hasPrompted) return;

	console.log("[Sweep] Prompting for API key");
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
