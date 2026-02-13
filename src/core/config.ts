import * as path from "node:path";
import * as vscode from "vscode";

import { DEFAULT_MAX_CONTEXT_FILES } from "~/core/constants.ts";

const SWEEP_CONFIG_SECTION = "sweep";

export class SweepConfig {
	private get config(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(SWEEP_CONFIG_SECTION);
	}

	get enabled(): boolean {
		return this.config.get<boolean>("enabled", true);
	}

	get maxContextFiles(): number {
		return this.config.get<number>(
			"maxContextFiles",
			DEFAULT_MAX_CONTEXT_FILES,
		);
	}

	get autocompleteExclusionPatterns(): string[] {
		return this.config.get<string[]>("autocompleteExclusionPatterns", []);
	}

	get autocompleteSnoozeUntil(): number {
		return this.config.get<number>("autocompleteSnoozeUntil", 0);
	}

	get localPort(): number {
		return this.config.get<number>("localPort", 8081);
	}

	isAutocompleteSnoozed(now = Date.now()): boolean {
		const snoozeUntil = this.autocompleteSnoozeUntil;
		return snoozeUntil > now;
	}

	getAutocompleteSnoozeRemainingMs(now = Date.now()): number | null {
		const snoozeUntil = this.autocompleteSnoozeUntil;
		if (!snoozeUntil) return null;
		return Math.max(0, snoozeUntil - now);
	}

	shouldExcludeFromAutocomplete(filePath: string): boolean {
		const patterns = this.autocompleteExclusionPatterns.filter(Boolean);
		if (patterns.length === 0) return false;
		const fileName = path.basename(filePath);
		const normalizedPath = filePath.replace(/\\/g, "/");
		return patterns.some((pattern) => {
			const trimmed = pattern.trim();
			if (!trimmed) return false;
			if (trimmed.includes("*")) {
				const regex = globToRegex(trimmed);
				return regex.test(normalizedPath);
			}
			return fileName.endsWith(trimmed) || normalizedPath.endsWith(trimmed);
		});
	}

	inspect<T>(key: string) {
		return this.config.inspect<T>(key);
	}

	setEnabled(
		value: boolean,
		target: vscode.ConfigurationTarget = this.getWorkspaceTarget(),
	): Thenable<void> {
		return this.config.update("enabled", value, target);
	}

	setAutocompleteSnoozeUntil(
		value: number,
		target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
	): Thenable<void> {
		return this.config.update("autocompleteSnoozeUntil", value, target);
	}

	setLocalPort(
		value: number,
		target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global,
	): Thenable<void> {
		return this.config.update("localPort", value, target);
	}

	private getWorkspaceTarget(): vscode.ConfigurationTarget {
		return vscode.workspace.workspaceFolders
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
	}
}

export const config = new SweepConfig();

function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const placeholder = "__DOUBLE_STAR__";
	const withPlaceholder = escaped.replace(/\*\*/g, placeholder);
	const withStar = withPlaceholder.replace(/\*/g, "[^/]*");
	const withDoubleStar = withStar.replace(new RegExp(placeholder, "g"), ".*");
	return new RegExp(`^${withDoubleStar}$`);
}
