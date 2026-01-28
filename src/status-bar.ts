import * as vscode from "vscode";

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
					e.affectsConfiguration("sweep.privacyMode")
				) {
					this.updateStatusBar();
				}
			}),
		);

		this.statusBarItem.show();
	}

	private updateStatusBar(): void {
		const config = vscode.workspace.getConfiguration("sweep");
		const isEnabled = config.get<boolean>("enabled", true);
		const privacyMode = config.get<boolean>("privacyMode", false);

		this.statusBarItem.text = "$(sweep-icon) Sweep";
		this.statusBarItem.tooltip = this.buildTooltip(isEnabled, privacyMode);

		if (!isEnabled) {
			this.statusBarItem.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
		} else {
			this.statusBarItem.backgroundColor = undefined;
		}
	}

	private buildTooltip(isEnabled: boolean, privacyMode: boolean): string {
		const status = isEnabled ? "Enabled" : "Disabled";
		const privacy = privacyMode ? "On" : "Off";
		return `Sweep Next Edit\nStatus: ${status}\nPrivacy Mode: ${privacy}\n\nClick to open menu`;
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
): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		vscode.commands.registerCommand("sweep.showMenu", async () => {
			const config = vscode.workspace.getConfiguration("sweep");
			const isEnabled = config.get<boolean>("enabled", true);
			const privacyMode = config.get<boolean>("privacyMode", false);

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
					label: "$(key) Set API Key",
					description: "Configure your Sweep API key",
					action: "setApiKey",
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
					case "setApiKey":
						await vscode.commands.executeCommand("sweep.setApiKey");
						break;
					case "openDashboard":
						await vscode.env.openExternal(
							vscode.Uri.parse("https://app.sweep.dev"),
						);
						break;
				}
			}
		}),
	);

	disposables.push(
		vscode.commands.registerCommand("sweep.toggleEnabled", async () => {
			const config = vscode.workspace.getConfiguration("sweep");
			const inspection = config.inspect<boolean>("enabled");
			const current =
				inspection?.workspaceValue ??
				inspection?.globalValue ??
				inspection?.defaultValue ??
				true;
			// Update at workspace level if workspace is open, otherwise global
			const target = vscode.workspace.workspaceFolders
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
			await config.update("enabled", !current, target);

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
			const config = vscode.workspace.getConfiguration("sweep");
			const inspection = config.inspect<boolean>("privacyMode");
			const current =
				inspection?.workspaceValue ??
				inspection?.globalValue ??
				inspection?.defaultValue ??
				false;
			const target = vscode.workspace.workspaceFolders
				? vscode.ConfigurationTarget.Workspace
				: vscode.ConfigurationTarget.Global;
			await config.update("privacyMode", !current, target);
			vscode.window.showInformationMessage(
				`Privacy mode ${!current ? "enabled" : "disabled"}`,
			);
		}),
	);

	return disposables;
}
