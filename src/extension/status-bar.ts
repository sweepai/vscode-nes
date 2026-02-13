import * as vscode from "vscode";

import { config } from "~/core/config";
import type { LocalAutocompleteServer } from "~/services/local-server.ts";

export class SweepStatusBar implements vscode.Disposable {
	private statusBarItem: vscode.StatusBarItem;
	private disposables: vscode.Disposable[] = [];

	constructor(_context: vscode.ExtensionContext) {
		this.statusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100,
		);
		this.statusBarItem.command = "sweep.showMenu";
		this.updateStatusBar();

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration("sweep.enabled") ||
					e.affectsConfiguration("sweep.privacyMode") ||
					e.affectsConfiguration("sweep.autocompleteSnoozeUntil") ||
					e.affectsConfiguration("sweep.localMode")
				) {
					this.updateStatusBar();
				}
			}),
		);

		this.statusBarItem.show();
	}

	private updateStatusBar(): void {
		const isEnabled = config.enabled;
		const privacyMode = config.privacyMode;
		const isSnoozed = config.isAutocompleteSnoozed();

		this.statusBarItem.text = "$(sweep-icon) Sweep";
		this.statusBarItem.tooltip = this.buildTooltip(
			isEnabled,
			privacyMode,
			isSnoozed,
		);

		if (!isEnabled || isSnoozed) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
		} else {
			this.statusBarItem.backgroundColor = undefined;
		}
	}

	private buildTooltip(
		isEnabled: boolean,
		privacyMode: boolean,
		isSnoozed: boolean,
	): string {
		const status = isEnabled ? "Enabled" : "Disabled";
		const privacy = privacyMode ? "On" : "Off";
		const localMode = config.localMode ? "On" : "Off";
		const snoozeUntil = config.autocompleteSnoozeUntil;
		const snoozeLine = isSnoozed
			? `Snoozed Until: ${formatSnoozeTime(snoozeUntil)}`
			: "Snoozed: Off";
		return `Sweep Next Edit\nStatus: ${status}\nPrivacy Mode: ${privacy}\nLocal Mode: ${localMode}\n${snoozeLine}\n\nClick to open menu`;
	}

	dispose(): void {
		this.statusBarItem.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

export function registerStatusBarCommands(
	_context: vscode.ExtensionContext,
	localServer?: LocalAutocompleteServer,
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.commands.registerCommand("sweep.showMenu", async () => {
			const isEnabled = config.enabled;
			const privacyMode = config.privacyMode;
			const localMode = config.localMode;
			const isSnoozed = config.isAutocompleteSnoozed();

			interface MenuItem extends vscode.QuickPickItem {
				action: string;
			}

			const items: MenuItem[] = [
				{
					label: `$(${isEnabled ? "check" : "circle-outline"}) Autocomplete`,
					description: isEnabled ? "Enabled" : "Disabled",
					action: "toggleEnabled",
				},
				{
					label: `$(${privacyMode ? "check" : "circle-outline"}) Privacy Mode`,
					description: privacyMode
						? "Completions not used for training"
						: "Completions may be used for training",
					action: "togglePrivacy",
				},
				{
					label: `$(${localMode ? "check" : "circle-outline"}) Local Mode`,
					description: localMode
						? "Using local autocomplete server"
						: "Using cloud API",
					action: "toggleLocalMode",
				},
				{
					label: "$(key) Set API Key",
					description: "Configure your Sweep API key",
					action: "setApiKey",
				},
				{
					label: isSnoozed
						? "$(play-circle) Resume Autocomplete"
						: "$(clock) Snooze Autocomplete",
					description: isSnoozed
						? "Resume suggestions immediately"
						: "Pause suggestions temporarily",
					action: isSnoozed ? "resumeSnooze" : "snooze",
				},
				{
					label: "$(server) Start Local Server",
					description: "Manually start the local autocomplete server",
					action: "startLocalServer",
				},
				{
					label: "$(link-external) Open Sweep Dashboard",
					description: "https://app.sweep.dev",
					action: "openDashboard",
				},
			];

			const selection = await vscode.window.showQuickPick(items, {
				placeHolder: "Sweep Settings",
				title: "Sweep AI",
			});

			if (selection) {
				switch (selection.action) {
					case "toggleEnabled":
						await vscode.commands.executeCommand("sweep.toggleEnabled");
						break;
					case "togglePrivacy":
						await vscode.commands.executeCommand("sweep.togglePrivacyMode");
						break;
					case "toggleLocalMode": {
						const current = config.localMode;
						await config.setLocalMode(!current);
						vscode.window.showInformationMessage(
							`Sweep local mode ${!current ? "enabled" : "disabled"}`,
						);
						break;
					}
					case "setApiKey":
						await vscode.commands.executeCommand("sweep.setApiKey");
						break;
					case "openDashboard":
						await vscode.env.openExternal(
							vscode.Uri.parse("https://app.sweep.dev"),
						);
						break;
					case "snooze":
						await handleSnooze();
						break;
					case "resumeSnooze":
						await handleResumeSnooze();
						break;
					case "startLocalServer":
						if (localServer) {
							try {
								await localServer.startServer();
								vscode.window.showInformationMessage(
									"Sweep local server started.",
								);
							} catch (error) {
								vscode.window.showErrorMessage(
									`Failed to start local server: ${(error as Error).message}`,
								);
							}
						} else {
							vscode.window.showWarningMessage(
								"Local server is not available.",
							);
						}
						break;
				}
			}
		}),
	);

	disposables.push(
		vscode.commands.registerCommand("sweep.toggleEnabled", async () => {
			const inspection = config.inspect<boolean>("enabled");
			const current =
				inspection?.workspaceValue ??
				inspection?.globalValue ??
				inspection?.defaultValue ??
				true;
			await config.setEnabled(!current);

			// Hide any existing inline suggestions when disabling
			if (current) {
				await vscode.commands.executeCommand(
					"editor.action.inlineSuggest.hide",
				);
			}

			vscode.window.showInformationMessage(
				`Sweep autocomplete ${!current ? "enabled" : "disabled"}`,
			);
		}),
	);

	disposables.push(
		vscode.commands.registerCommand("sweep.togglePrivacyMode", async () => {
			const inspection = config.inspect<boolean>("privacyMode");
			const current =
				inspection?.workspaceValue ??
				inspection?.globalValue ??
				inspection?.defaultValue ??
				false;
			await config.setPrivacyMode(!current);
			vscode.window.showInformationMessage(
				`Privacy mode ${!current ? "enabled" : "disabled"}`,
			);
		}),
	);

	return disposables;
}

function formatSnoozeTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString();
}

async function handleSnooze(): Promise<void> {
	const options: Array<{ label: string; minutes: number }> = [
		{ label: "15 minutes", minutes: 15 },
		{ label: "30 minutes", minutes: 30 },
		{ label: "1 hour", minutes: 60 },
		{ label: "4 hours", minutes: 240 },
	];

	const selection = await vscode.window.showQuickPick(
		options.map((option) => ({
			label: option.label,
			description: `Pause autocomplete for ${option.label}`,
		})),
		{ title: "Snooze Sweep Autocomplete", placeHolder: "Choose duration" },
	);

	if (!selection) return;

	const selected = options.find((option) => option.label === selection.label);
	if (!selected) return;

	const until = Date.now() + selected.minutes * 60 * 1000;
	await config.setAutocompleteSnoozeUntil(
		until,
		vscode.ConfigurationTarget.Global,
	);
	await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");
	vscode.window.showInformationMessage(
		`Sweep autocomplete snoozed until ${formatSnoozeTime(until)}.`,
	);
}

async function handleResumeSnooze(): Promise<void> {
	await config.setAutocompleteSnoozeUntil(0, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage("Sweep autocomplete resumed.");
}
