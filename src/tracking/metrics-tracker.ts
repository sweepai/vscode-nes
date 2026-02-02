import * as http from "node:http";
import * as https from "node:https";
import * as vscode from "vscode";
import {
	type AutocompleteResult,
	type MetricsPayload,
	MetricsPayloadSchema,
	type SuggestionType,
} from "~/api/schemas.ts";
import { getDebugInfo, METRICS_API_ENDPOINT } from "~/constants.ts";

export class MetricsTracker {
	private readonly metricsUrl: string;

	constructor(metricsUrl: string = METRICS_API_ENDPOINT) {
		this.metricsUrl = metricsUrl;
	}

	suggestionShown(
		result: AutocompleteResult,
		suggestionType: SuggestionType,
		documentText: string,
	): void {
		const { additions, deletions } = this.computeEditMetrics(
			result,
			documentText,
		);

		this.sendMetrics({
			event_type: "autocomplete_suggestion_shown",
			suggestion_type: suggestionType,
			additions,
			deletions,
			autocomplete_id: result.id,
			edit_tracking: "",
			edit_tracking_line: null,
			lifespan: 0,
			debug_info: getDebugInfo(),
			device_id: this.getDeviceId(),
			privacy_mode_enabled: this.isPrivacyModeEnabled(),
		});
	}

	suggestionAccepted(
		result: AutocompleteResult,
		suggestionType: SuggestionType,
		documentText: string,
	): void {
		const { additions, deletions } = this.computeEditMetrics(
			result,
			documentText,
		);

		this.sendMetrics({
			event_type: "autocomplete_suggestion_accepted",
			suggestion_type: suggestionType,
			additions,
			deletions,
			autocomplete_id: result.id,
			edit_tracking: "",
			edit_tracking_line: null,
			lifespan: 0,
			debug_info: getDebugInfo(),
			device_id: this.getDeviceId(),
			privacy_mode_enabled: this.isPrivacyModeEnabled(),
		});
	}

	/**
	 * Count line-level additions and deletions, matching the Zed
	 * `compute_edit_metrics` logic: lines in the replaced range = deletions,
	 * lines in the completion = additions, each at minimum 1.
	 */
	private computeEditMetrics(
		result: AutocompleteResult,
		documentText: string,
	): { additions: number; deletions: number } {
		const oldText = documentText.slice(result.startIndex, result.endIndex);
		const deletions = Math.max(1, oldText.split("\n").length);
		const additions = Math.max(1, result.completion.split("\n").length);
		return { additions, deletions };
	}

	private getDeviceId(): string {
		return vscode.env.machineId;
	}

	private isPrivacyModeEnabled(): boolean {
		return vscode.workspace
			.getConfiguration("sweep")
			.get<boolean>("privacyMode", false);
	}

	/**
	 * Fire-and-forget POST to the metrics endpoint.
	 * Plain JSON (no Brotli), matching the Zed implementation.
	 * Errors are logged only — metrics must never disrupt the user.
	 */
	private sendMetrics(payload: MetricsPayload): void {
		const apiKey = vscode.workspace
			.getConfiguration("sweep")
			.get<string>("apiKey", "");
		if (!apiKey) return;

		const parsed = MetricsPayloadSchema.safeParse(payload);
		if (!parsed.success) {
			console.error("[Sweep] Invalid metrics payload:", parsed.error.message);
			return;
		}

		const body = JSON.stringify(parsed.data);
		const url = new URL(this.metricsUrl);
		const isHttps = url.protocol === "https:";

		const options: http.RequestOptions = {
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: url.pathname,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Length": Buffer.byteLength(body),
			},
		};

		const transport = isHttps ? https : http;
		const req = transport.request(options, (res) => {
			res.resume();
			if (res.statusCode !== 200) {
				console.warn(
					`[Sweep] Metrics request returned status ${res.statusCode}`,
				);
			}
		});

		req.on("error", (error) => {
			console.warn(`[Sweep] Metrics request failed: ${error.message}`);
		});

		req.write(body);
		req.end();
	}
}
