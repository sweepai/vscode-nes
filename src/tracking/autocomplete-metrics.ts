import * as vscode from "vscode";

import type { ApiClient } from "~/api/client.ts";
import type {
	AutocompleteEventType,
	AutocompleteMetricsRequest,
	AutocompleteResult,
	SuggestionType,
} from "~/api/schemas.ts";

export interface AutocompleteMetricsPayload {
	id: string;
	additions: number;
	deletions: number;
	suggestionType: SuggestionType;
	numDefinitionsRetrieved?: number;
	numUsagesRetrieved?: number;
}

const EVENT_SHOWN: AutocompleteEventType = "autocomplete_suggestion_shown";
const EVENT_ACCEPTED: AutocompleteEventType =
	"autocomplete_suggestion_accepted";
const EVENT_DISPOSED: AutocompleteEventType =
	"autocomplete_suggestion_disposed";
const EVENT_EDIT_TRACKING: AutocompleteEventType = "autocomplete_edit_tracking";
const MAX_SHOWN_IDS = 1000;
const EDIT_TRACKING_INTERVALS_SECONDS = [15, 30, 60, 120, 300];

interface EditTrackingContext {
	uri: vscode.Uri;
	startLine: number;
	endLine: number;
}

export class AutocompleteMetricsTracker implements vscode.Disposable {
	private api: ApiClient;
	private shownIds = new Set<string>();
	private shownAt = new Map<string, number>();
	private editTrackingTimers = new Map<string, NodeJS.Timeout[]>();

	constructor(api: ApiClient) {
		this.api = api;
	}

	dispose(): void {
		this.shownIds.clear();
		this.shownAt.clear();
		for (const timers of this.editTrackingTimers.values()) {
			for (const timer of timers) {
				clearTimeout(timer);
			}
		}
		this.editTrackingTimers.clear();
	}

	trackShown(
		payload: AutocompleteMetricsPayload,
		context?: EditTrackingContext,
	): void {
		if (this.shownIds.has(payload.id)) {
			return;
		}
		this.shownIds.add(payload.id);
		this.shownAt.set(payload.id, Date.now());
		if (this.shownIds.size > MAX_SHOWN_IDS) {
			const oldestId = this.shownIds.values().next().value as
				| string
				| undefined;
			if (oldestId) {
				this.shownIds.delete(oldestId);
				this.shownAt.delete(oldestId);
				this.clearEditTrackingTimers(oldestId);
			}
		}
		this.trackEvent(EVENT_SHOWN, payload);
		this.scheduleEditTracking(payload, context);
	}

	trackAccepted(payload: AutocompleteMetricsPayload): void {
		this.trackEvent(EVENT_ACCEPTED, payload);
	}

	trackDisposed(payload: AutocompleteMetricsPayload): void {
		const shownTime = this.shownAt.get(payload.id);
		const lifespan = shownTime ? Date.now() - shownTime : undefined;
		this.clearEditTrackingTimers(payload.id);
		this.trackEvent(EVENT_DISPOSED, payload, {
			lifespan,
		});
	}

	private trackEvent(
		eventType: AutocompleteEventType,
		payload: AutocompleteMetricsPayload,
		extra?: AutocompleteMetricsExtras,
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

		const numDefinitionsRetrieved = payload.numDefinitionsRetrieved ?? -1;
		const numUsagesRetrieved = payload.numUsagesRetrieved ?? -1;

		void this.api
			.trackAutocompleteMetrics({
				event_type: eventType,
				suggestion_type: payload.suggestionType,
				additions: payload.additions,
				deletions: payload.deletions,
				autocomplete_id: payload.id,
				...extra,
				debug_info: this.api.getDebugInfo(),
				device_id: vscode.env.machineId,
				privacy_mode_enabled: privacyModeEnabled,
				num_definitions_retrieved: numDefinitionsRetrieved,
				num_usages_retrieved: numUsagesRetrieved,
			})
			.catch((error) => {
				console.error("[Sweep] Metrics tracking failed:", error);
			});
	}

	private scheduleEditTracking(
		payload: AutocompleteMetricsPayload,
		context?: EditTrackingContext,
	): void {
		if (!context) return;

		const privacyModeEnabled = vscode.workspace
			.getConfiguration("sweep")
			.get<boolean>("privacyMode", false);
		if (privacyModeEnabled) return;

		const timers = EDIT_TRACKING_INTERVALS_SECONDS.map((intervalSeconds) =>
			setTimeout(() => {
				void this.captureEditTrackingSnapshot(
					payload,
					context,
					intervalSeconds,
				);
			}, intervalSeconds * 1000),
		);
		this.editTrackingTimers.set(payload.id, timers);
	}

	private clearEditTrackingTimers(autocompleteId: string): void {
		const timers = this.editTrackingTimers.get(autocompleteId);
		if (!timers) return;
		for (const timer of timers) {
			clearTimeout(timer);
		}
		this.editTrackingTimers.delete(autocompleteId);
	}

	private async captureEditTrackingSnapshot(
		payload: AutocompleteMetricsPayload,
		context: EditTrackingContext,
		intervalSeconds: number,
	): Promise<void> {
		try {
			const document = await vscode.workspace.openTextDocument(context.uri);
			const text = document.getText();
			const editTrackingLine = this.buildEditTrackingLine(
				document,
				context.startLine,
				context.endLine,
			);
			const snapshotPayload: AutocompleteMetricsExtras = {
				edit_tracking: intervalSeconds === 30 ? text : undefined,
				edit_tracking_15: intervalSeconds === 15 ? text : undefined,
				edit_tracking_30: intervalSeconds === 30 ? text : undefined,
				edit_tracking_60: intervalSeconds === 60 ? text : undefined,
				edit_tracking_120: intervalSeconds === 120 ? text : undefined,
				edit_tracking_300: intervalSeconds === 300 ? text : undefined,
				edit_tracking_line: editTrackingLine ?? undefined,
			};

			this.trackEvent(EVENT_EDIT_TRACKING, payload, snapshotPayload);
		} catch (error) {
			console.error("[Sweep] Edit tracking snapshot failed:", error);
		}
	}

	private buildEditTrackingLine(
		document: vscode.TextDocument,
		startLine: number,
		endLine: number,
	): AutocompleteMetricsExtras["edit_tracking_line"] | null {
		if (document.lineCount === 0) return null;
		const safeStart = Math.max(0, Math.min(startLine, document.lineCount - 1));
		const safeEnd = Math.max(
			safeStart,
			Math.min(endLine, document.lineCount - 1),
		);
		const startPos = new vscode.Position(safeStart, 0);
		const endPos = new vscode.Position(
			safeEnd,
			document.lineAt(safeEnd).text.length,
		);
		const content = document.getText(new vscode.Range(startPos, endPos));
		return {
			file_path: document.uri.fsPath.replace(/\\/g, "/"),
			start_line: safeStart,
			end_line: safeEnd,
			content,
		};
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

type AutocompleteMetricsExtras = Partial<
	Pick<
		AutocompleteMetricsRequest,
		| "edit_tracking"
		| "edit_tracking_15"
		| "edit_tracking_30"
		| "edit_tracking_60"
		| "edit_tracking_120"
		| "edit_tracking_300"
		| "edit_tracking_line"
		| "lifespan"
	>
>;
