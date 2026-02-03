import * as vscode from "vscode";

import type { ApiClient } from "~/api/client.ts";
import type {
	AutocompleteEventType,
	AutocompleteResult,
	SuggestionType,
} from "~/api/schemas.ts";

export interface AutocompleteMetricsPayload {
	id: string;
	additions: number;
	deletions: number;
	suggestionType: SuggestionType;
}

const EVENT_SHOWN: AutocompleteEventType = "autocomplete_suggestion_shown";
const EVENT_ACCEPTED: AutocompleteEventType =
	"autocomplete_suggestion_accepted";
const MAX_SHOWN_IDS = 1000;

export class AutocompleteMetricsTracker implements vscode.Disposable {
	private api: ApiClient;
	private shownIds = new Set<string>();

	constructor(api: ApiClient) {
		this.api = api;
	}

	dispose(): void {
		this.shownIds.clear();
	}

	trackShown(payload: AutocompleteMetricsPayload): void {
		if (this.shownIds.has(payload.id)) {
			return;
		}
		this.shownIds.add(payload.id);
		if (this.shownIds.size > MAX_SHOWN_IDS) {
			const oldestId = this.shownIds.values().next().value as
				| string
				| undefined;
			if (oldestId) {
				this.shownIds.delete(oldestId);
			}
		}
		this.trackEvent(EVENT_SHOWN, payload);
	}

	trackAccepted(payload: AutocompleteMetricsPayload): void {
		this.trackEvent(EVENT_ACCEPTED, payload);
	}

	private trackEvent(
		eventType: AutocompleteEventType,
		payload: AutocompleteMetricsPayload,
	) {
		if (!payload.id) {
			return;
		}

		if (!this.api.apiKey) {
			return;
		}

		const privacyModeEnabled = vscode.workspace
			.getConfiguration("sweep")
			.get<boolean>("privacyMode", false);

		void this.api
			.trackAutocompleteMetrics({
				event_type: eventType,
				suggestion_type: payload.suggestionType,
				additions: payload.additions,
				deletions: payload.deletions,
				autocomplete_id: payload.id,
				debug_info: this.api.getDebugInfo(),
				device_id: vscode.env.machineId,
				privacy_mode_enabled: privacyModeEnabled,
			})
			.catch((error) => {
				console.error("[Sweep] Metrics tracking failed:", error);
			});
	}
}

export function computeAdditionsDeletions(
	document: vscode.TextDocument,
	result: AutocompleteResult,
): { additions: number; deletions: number } {
	const startLine = document.positionAt(result.startIndex).line;
	const endOffset =
		result.endIndex > result.startIndex
			? result.endIndex - 1
			: result.startIndex;
	const endLine = document.positionAt(endOffset).line;
	const deletions = Math.max(endLine - startLine + 1, 1);
	const additions = Math.max(result.completion.split("\n").length, 1);
	return { additions, deletions };
}
