import * as vscode from "vscode";

import { DEFAULT_MAX_CONTEXT_FILES } from "~/constants.ts";

const SWEEP_CONFIG_SECTION = "sweep";

export class SweepConfig {
	private get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(SWEEP_CONFIG_SECTION);
	}

	get apiKey(): string | null {
		return this.config.get<string | null>("apiKey", null);
	}

	get enabled(): boolean {
		return this.config.get<boolean>("enabled", true);
	}

	get privacyMode(): boolean {
		return this.config.get<boolean>("privacyMode", false);
	}

	get maxContextFiles(): number {
		return this.config.get<number>(
			"maxContextFiles",
			DEFAULT_MAX_CONTEXT_FILES,
		);
	}

	inspect<T>(key: string) {
		return this.config.inspect<T>(key);
	}

	setApiKey(
		value: string | null,
		target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
	): Thenable<void> {
		return this.config.update("apiKey", value, target);
	}

	setEnabled(
		value: boolean,
		target: vscode.ConfigurationTarget = this.getWorkspaceTarget(),
	): Thenable<void> {
		return this.config.update("enabled", value, target);
	}

	setPrivacyMode(
		value: boolean,
		target: vscode.ConfigurationTarget = this.getWorkspaceTarget(),
	): Thenable<void> {
		return this.config.update("privacyMode", value, target);
	}

	private getWorkspaceTarget(): vscode.ConfigurationTarget {
		return vscode.workspace.workspaceFolders
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
	}
}

export const config = new SweepConfig();
