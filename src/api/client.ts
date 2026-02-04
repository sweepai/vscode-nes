import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as zlib from "node:zlib";
import * as vscode from "vscode";

import { DEFAULT_API_ENDPOINT, DEFAULT_METRICS_ENDPOINT } from "~/constants.ts";
import {
	type AutocompleteMetricsRequest,
	AutocompleteMetricsRequestSchema,
	AutocompleteRequestSchema,
	AutocompleteResponseSchema,
	type AutocompleteResult,
	type FileChunk,
	type RecentBuffer,
	type RecentChange,
	type UserAction,
} from "./schemas.ts";

export interface AutocompleteInput {
	document: vscode.TextDocument;
	position: vscode.Position;
	originalContent: string;
	recentChanges: RecentChange[];
	recentBuffers: RecentBuffer[];
	diagnostics: vscode.Diagnostic[];
	userActions: UserAction[];
}

export class ApiClient {
	private apiUrl: string;
	private metricsUrl: string;

	constructor(
		apiUrl: string = DEFAULT_API_ENDPOINT,
		metricsUrl: string = DEFAULT_METRICS_ENDPOINT,
	) {
		this.apiUrl = apiUrl;
		this.metricsUrl = metricsUrl;
	}

	async getAutocomplete(
		input: AutocompleteInput,
	): Promise<AutocompleteResult | null> {
		const apiKey = this.apiKey;
		if (!apiKey) {
			return null;
		}

		const requestData = this.buildRequest(input);

		const parsedRequest = AutocompleteRequestSchema.safeParse(requestData);
		if (!parsedRequest.success) {
			console.error(
				"[Sweep] Invalid request data:",
				parsedRequest.error.message,
			);
			return null;
		}

		const compressed = await this.compress(JSON.stringify(parsedRequest.data));
		const responseData = await this.sendRequest(compressed, apiKey);

		if (!responseData) {
			return null;
		}

		const parsedResponse = AutocompleteResponseSchema.safeParse(responseData);
		if (!parsedResponse.success) {
			console.error(
				"[Sweep] Invalid API response:",
				parsedResponse.error.message,
			);
			return null;
		}

		const response = parsedResponse.data;
		return {
			id: response.autocomplete_id,
			startIndex: response.start_index,
			endIndex: response.end_index,
			completion: response.completion,
			confidence: response.confidence,
		};
	}

	async trackAutocompleteMetrics(
		request: AutocompleteMetricsRequest,
	): Promise<void> {
		const apiKey = this.apiKey;
		if (!apiKey) {
			return;
		}

		const parsedRequest = AutocompleteMetricsRequestSchema.safeParse(request);
		if (!parsedRequest.success) {
			console.error(
				"[Sweep] Invalid metrics data:",
				parsedRequest.error.message,
			);
			return;
		}

		await this.sendMetricsRequest(JSON.stringify(parsedRequest.data), apiKey);
	}

	get apiKey(): string | null {
		return vscode.workspace
			.getConfiguration("sweep")
			.get<string | null>("apiKey", null);
	}

	private buildRequest(input: AutocompleteInput): unknown {
		const {
			document,
			position,
			originalContent,
			recentChanges,
			recentBuffers,
			diagnostics,
			userActions,
		} = input;

		const filePath = toUnixPath(document.uri.fsPath) || "untitled";
		const recentChangesText = this.formatRecentChanges(recentChanges);
		const fileChunks = this.buildFileChunks(recentBuffers);
		const retrievalChunks = this.buildDiagnosticsChunk(filePath, diagnostics);

		return {
			debug_info: this.getDebugInfo(),
			repo_name: this.getRepoName(document),
			file_path: filePath,
			file_contents: document.getText(),
			original_file_contents: originalContent,
			cursor_position: document.offsetAt(position),
			recent_changes: recentChangesText,
			changes_above_cursor: true,
			multiple_suggestions: false,
			file_chunks: fileChunks,
			retrieval_chunks: retrievalChunks,
			recent_user_actions: userActions,
			use_bytes: false,
			privacy_mode_enabled: vscode.workspace
				.getConfiguration("sweep")
				.get<boolean>("privacyMode", false),
		};
	}

	private formatRecentChanges(changes: RecentChange[]): string {
		let result = "";
		for (const change of changes) {
			if (!change.diff) continue;

			const lines = change.diff
				.split("\n")
				.filter(
					(line) =>
						!line.startsWith("Index:") &&
						!line.startsWith("===") &&
						!line.startsWith("---") &&
						!line.startsWith("+++"),
				);
			const cleaned = lines.join("\n").trim();
			if (cleaned) {
				result += `File: ${change.path}:\n${cleaned}\n`;
			}
		}
		return result;
	}

	private buildFileChunks(buffers: RecentBuffer[]): FileChunk[] {
		return buffers.slice(0, 3).map((buffer) => {
			const lines = buffer.content.split("\n");
			const endLine = Math.min(30, lines.length);
			return {
				file_path: toUnixPath(buffer.path),
				start_line: 0,
				end_line: endLine,
				content: lines.slice(0, endLine).join("\n"),
				timestamp: buffer.mtime,
			};
		});
	}

	private buildDiagnosticsChunk(
		filePath: string,
		diagnostics: vscode.Diagnostic[],
	): FileChunk[] {
		if (diagnostics.length === 0) return [];

		let content = "";
		for (const d of diagnostics) {
			const severity = this.formatSeverity(d.severity);
			const line = d.range.start.line + 1;
			const col = d.range.start.character + 1;
			content += `${filePath}:${line}:${col}: ${severity}: ${d.message}\n`;
		}

		return [
			{
				file_path: "diagnostics",
				start_line: 1,
				end_line: diagnostics.length,
				content,
			},
		];
	}

	private formatSeverity(
		severity: vscode.DiagnosticSeverity | undefined,
	): string {
		switch (severity) {
			case vscode.DiagnosticSeverity.Error:
				return "error";
			case vscode.DiagnosticSeverity.Warning:
				return "warning";
			case vscode.DiagnosticSeverity.Information:
				return "info";
			case vscode.DiagnosticSeverity.Hint:
				return "hint";
			default:
				return "info";
		}
	}

	getDebugInfo(): string {
		const extensionVersion =
			vscode.extensions.getExtension("SweepAI.sweep-nes")?.packageJSON
				?.version ?? "unknown";
		return `VSCode (${vscode.version}) - OS: ${os.platform()} ${os.arch()} - Sweep v${extensionVersion}`;
	}

	private getRepoName(document: vscode.TextDocument): string {
		return (
			vscode.workspace.getWorkspaceFolder(document.uri)?.name || "untitled"
		);
	}

	private compress(data: string): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			zlib.brotliCompress(
				Buffer.from(data, "utf-8"),
				{
					params: {
						[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
						[zlib.constants.BROTLI_PARAM_LGWIN]: 22,
					},
				},
				(error, result) => (error ? reject(error) : resolve(result)),
			);
		});
	}

	private sendRequest(body: Buffer, apiKey: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const url = new URL(this.apiUrl);
			const isHttps = url.protocol === "https:";
			const defaultPort = isHttps ? 443 : 80;

			const options: http.RequestOptions = {
				hostname: url.hostname,
				port: url.port || defaultPort,
				path: `${url.pathname}${url.search}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
					"Content-Encoding": "br",
					"Content-Length": body.length,
				},
			};

			const transport = isHttps ? https : http;
			const req = transport.request(options, (res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk.toString();
				});
				res.on("end", () => {
					if (res.statusCode !== 200) {
						console.error(
							`[Sweep] API request failed with status ${res.statusCode}: ${data}`,
						);
						reject(
							new Error(`API request failed with status ${res.statusCode}`),
						);
						return;
					}
					try {
						resolve(JSON.parse(data));
					} catch {
						reject(new Error("Failed to parse API response JSON"));
					}
				});
			});

			req.on("error", (error) =>
				reject(new Error(`API request error: ${error.message}`)),
			);
			req.write(body);
			req.end();
		});
	}

	private sendMetricsRequest(body: string, apiKey: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const url = new URL(this.metricsUrl);
			const isHttps = url.protocol === "https:";
			const defaultPort = isHttps ? 443 : 80;

			const options: http.RequestOptions = {
				hostname: url.hostname,
				port: url.port || defaultPort,
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
				let data = "";
				res.on("data", (chunk) => {
					data += chunk.toString();
				});
				res.on("end", () => {
					if (
						!res.statusCode ||
						res.statusCode < 200 ||
						res.statusCode >= 300
					) {
						console.error(
							`[Sweep] Metrics request failed with status ${res.statusCode}: ${data}`,
						);
						reject(
							new Error(
								`Metrics request failed with status ${res.statusCode}: ${data}`,
							),
						);
						return;
					}
					resolve();
				});
			});

			req.on("error", (error) =>
				reject(new Error(`Metrics request error: ${error.message}`)),
			);
			req.write(body);
			req.end();
		});
	}
}

function toUnixPath(path: string): string {
	return path.replace(/\\/g, "/");
}
