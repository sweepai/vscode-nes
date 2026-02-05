import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as zlib from "node:zlib";
import * as vscode from "vscode";
import type { ZodType } from "zod";
import { config } from "~/core/config.ts";
import {
	DEFAULT_METRICS_ENDPOINT,
	LOCAL_CONTEXT_LINE_RADIUS,
	MODEL_NAME,
	MAX_TOKENS,
	STOP_TOKENS,
	TEMPERATURE,
} from "~/core/constants.ts";
import { resolveApiUrl, shouldRequireApiKey } from "~/core/mode.ts";
import {
	buildAutocompleteTransport,
	type AutocompleteTransport,
} from "~/api/request-mode.ts";
import {
	buildLocalPrompt,
	computeReplacementSpan,
} from "~/local/completions.ts";
import { toUnixPath } from "~/utils/path.ts";
import {
	isFileTooLarge,
	utf8ByteOffsetAt,
	utf8ByteOffsetToUtf16Offset,
} from "~/utils/text.ts";
import {
	type AutocompleteMetricsRequest,
	AutocompleteMetricsRequestSchema,
	type AutocompleteRequest,
	AutocompleteRequestSchema,
	type AutocompleteResponse,
	AutocompleteResponseSchema,
	type AutocompleteResult,
	type FileChunk,
	type OpenAiCompletionResponse,
	type RecentBuffer,
	type RecentChange,
	type UserAction,
	OpenAiCompletionResponseSchema,
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

interface AutocompleteAdapter<T> {
	transport: AutocompleteTransport<T>;
	handleResponse: (response: T) => AutocompleteResult[] | null;
}

export class ApiClient {
	private metricsUrl: string;

	constructor(metricsUrl: string = DEFAULT_METRICS_ENDPOINT) {
		this.metricsUrl = metricsUrl;
	}

	async getAutocomplete(
		input: AutocompleteInput,
		signal?: AbortSignal,
	): Promise<AutocompleteResult[] | null> {
		const mode = config.mode;
		const documentText = input.document.getText();
		if (isFileTooLarge(documentText) || isFileTooLarge(input.originalContent)) {
			console.log("[Sweep] Skipping autocomplete request: file too large", {
				documentLength: documentText.length,
				originalLength: input.originalContent.length,
			});
			return null;
		}

		const apiKey = this.apiKey ?? "";
		if (mode === "local") {
			const adapter = this.buildLocalAdapter(input, documentText);
			if (!adapter) {
				return null;
			}
			return this.sendAutocomplete(adapter, apiKey, signal);
		}

		const adapter = this.buildHostedAdapter(input);
		if (!adapter) {
			return null;
		}

		return this.sendAutocomplete(adapter, apiKey, signal);
	}

	async trackAutocompleteMetrics(
		request: AutocompleteMetricsRequest,
	): Promise<void> {
		if (!config.metricsEnabled) {
			console.log("[Sweep] Metrics disabled; skipping metrics send");
			return;
		}

		const apiKey = this.apiKey ?? "";
		if (shouldRequireApiKey(config.mode) && !apiKey) {
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
		return config.apiKey;
	}

	private buildLocalAdapter(
		input: AutocompleteInput,
		documentText: string,
	): AutocompleteAdapter<OpenAiCompletionResponse> | null {
		const mode = config.mode;

		const filePath = toUnixPath(input.document.uri.fsPath) || "untitled";
		const window = this.getLocalWindow(input, documentText);
		const prompt = buildLocalPrompt({
			filePath,
			originalText: window.originalText,
			currentText: window.currentText,
		});

		console.log("[Sweep] Local prompt window", {
			startLine: window.startLine,
			endLine: window.endLine,
			promptLength: prompt.length,
		});

		const requestBody = {
			model: MODEL_NAME,
			prompt,
			temperature: TEMPERATURE,
			max_tokens: MAX_TOKENS,
			stop: STOP_TOKENS,
			n: 1,
			echo: false,
			stream: false,
		};

		const transport = buildAutocompleteTransport({
			mode,
			apiUrl: resolveApiUrl("hosted", config.localUrl),
			localUrl: config.localUrl,
			hosted: {
				body: "",
				schema: OpenAiCompletionResponseSchema,
				compressed: false,
				requiresApiKey: shouldRequireApiKey("hosted"),
			},
			local: {
				body: JSON.stringify(requestBody),
				schema: OpenAiCompletionResponseSchema,
			},
		});

		return {
			transport,
			handleResponse: (response) => {
				const completionText = response.choices[0]?.text ?? "";
				const cleaned = this.trimStopTokens(completionText);
				if (!cleaned) {
					console.log("[Sweep] Local completion empty; skipping");
					return null;
				}

				const span = computeReplacementSpan(window.currentText, cleaned);
				if (!span) {
					console.log("[Sweep] Local completion produced no changes");
					return null;
				}

				const baseOffset = input.document.offsetAt(
					new vscode.Position(window.startLine, 0),
				);

				return [
					{
						id: "local",
						startIndex: baseOffset + span.start,
						endIndex: baseOffset + span.end,
						completion: span.replacement,
						confidence: 1,
					},
				];
			},
		};
	}

	private buildHostedAdapter(
		input: AutocompleteInput,
	): AutocompleteAdapter<AutocompleteResponse> | null {
		const mode = config.mode;
		const requestData = this.buildRequest(input);
		const parsedRequest = AutocompleteRequestSchema.safeParse(requestData);
		if (!parsedRequest.success) {
			console.error(
				"[Sweep] Invalid request data:",
				parsedRequest.error.message,
			);
			return null;
		}

		const rawBody = JSON.stringify(parsedRequest.data);
		const transport = buildAutocompleteTransport({
			mode,
			apiUrl: resolveApiUrl(mode, config.localUrl),
			localUrl: config.localUrl,
			hosted: {
				body: rawBody,
				schema: AutocompleteResponseSchema,
				compressed: this.shouldUseCompression(mode),
				requiresApiKey: shouldRequireApiKey(mode),
			},
			local: {
				body: "",
				schema: AutocompleteResponseSchema,
			},
		});

		return {
			transport,
			handleResponse: (response) => {
				const documentText = input.document.getText();
				const decodeOffset = requestData.use_bytes
					? (index: number) =>
							utf8ByteOffsetToUtf16Offset(documentText, index)
					: (index: number) => index;

				const completions =
					response.completions && response.completions.length > 0
						? response.completions
						: [
								{
									autocomplete_id: response.autocomplete_id,
									start_index: response.start_index,
									end_index: response.end_index,
									completion: response.completion,
									confidence: response.confidence,
								},
							];

				const results = completions
					.map((completion): AutocompleteResult => {
						return {
							id: completion.autocomplete_id,
							startIndex: decodeOffset(completion.start_index),
							endIndex: decodeOffset(completion.end_index),
							completion: completion.completion,
							confidence: completion.confidence,
						};
					})
					.filter((result) => result.completion.length > 0);

				return results.length > 0 ? results : null;
			},
		};
	}

	private getLocalWindow(
		input: AutocompleteInput,
		documentText: string,
	): {
		startLine: number;
		endLine: number;
		currentText: string;
		originalText: string;
	} {
		const currentLines = documentText.split("\n");
		const originalLines = input.originalContent.split("\n");
		const cursorLine = input.position.line;
		const startLine = Math.max(0, cursorLine - LOCAL_CONTEXT_LINE_RADIUS);
		const endLine = Math.min(
			currentLines.length,
			cursorLine + LOCAL_CONTEXT_LINE_RADIUS + 1,
		);

		return {
			startLine,
			endLine,
			currentText: currentLines.slice(startLine, endLine).join("\n"),
			originalText: originalLines.slice(startLine, endLine).join("\n"),
		};
	}

	private trimStopTokens(text: string): string {
		let trimmed = text.trimEnd();
		for (const token of STOP_TOKENS) {
			if (trimmed.endsWith(token)) {
				trimmed = trimmed.slice(0, -token.length).trimEnd();
			}
		}
		return trimmed;
	}

	private buildRequest(input: AutocompleteInput): AutocompleteRequest {
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
			cursor_position: utf8ByteOffsetAt(document, position),
			recent_changes: recentChangesText,
			changes_above_cursor: true,
			multiple_suggestions: true,
			file_chunks: fileChunks,
			retrieval_chunks: retrievalChunks,
			recent_user_actions: userActions,
			use_bytes: true,
			privacy_mode_enabled: config.privacyMode,
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
		return buffers
			.filter((buffer) => !isFileTooLarge(buffer.content))
			.slice(0, 3)
			.map((buffer) => {
				if (buffer.startLine !== undefined && buffer.endLine !== undefined) {
					return {
						file_path: toUnixPath(buffer.path),
						start_line: buffer.startLine,
						end_line: buffer.endLine,
						content: buffer.content,
						...(buffer.mtime !== undefined ? { timestamp: buffer.mtime } : {}),
					};
				}
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

	private shouldUseCompression(mode: string): boolean {
		return mode !== "local";
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

	private sendRequest<T>(
		apiUrl: string,
		body: Buffer,
		apiKey: string,
		schema: ZodType<T>,
		compressed: boolean,
		signal?: AbortSignal,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				fn();
			};

			const url = new URL(apiUrl);
			console.log("[Sweep] Sending autocomplete request", {
				url: url.toString(),
				hasApiKey: Boolean(apiKey),
			});
			const isHttps = url.protocol === "https:";
			const defaultPort = isHttps ? 443 : 80;

			const options: http.RequestOptions = {
				hostname: url.hostname,
				port: url.port || defaultPort,
				path: `${url.pathname}${url.search}`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(compressed ? { "Content-Encoding": "br" } : {}),
					"Content-Length": body.length,
				},
			};

			if (apiKey) {
				options.headers = {
					...options.headers,
					Authorization: `Bearer ${apiKey}`,
				};
			}

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
						finish(() =>
							reject(
								new Error(
									`API request failed with status ${res.statusCode}`,
								),
							),
						);
						return;
					}
					try {
						const parsedJson: unknown = JSON.parse(data);
						const parsed = schema.safeParse(parsedJson);
						if (!parsed.success) {
							finish(() =>
								reject(
									new Error(
										`Invalid API response: ${parsed.error.message}`,
									),
								),
							);
							return;
						}
						finish(() => resolve(parsed.data));
					} catch {
						finish(() =>
							reject(new Error("Failed to parse API response JSON")),
						);
					}
				});
			});

			const onError = (error: Error) => {
				finish(() => reject(new Error(`API request error: ${error.message}`)));
			};

			const onAbort = () => {
				const abortError = new Error("Request aborted");
				abortError.name = "AbortError";
				req.destroy(abortError);
				finish(() => reject(abortError));
			};

			const cleanup = () => {
				req.off("error", onError);
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}
			};

			req.on("error", onError);

			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort);
			}

			req.write(body);
			req.end();
		});
	}

	private async sendAutocomplete<T>(
		adapter: AutocompleteAdapter<T>,
		apiKey: string,
		signal?: AbortSignal,
	): Promise<AutocompleteResult[] | null> {
		const { transport } = adapter;
		console.log("[Sweep] Autocomplete request", {
			mode: transport.mode,
			apiUrl: transport.apiUrl,
			hasApiKey: Boolean(apiKey),
		});
		if (transport.requiresApiKey && !apiKey) {
			console.warn(
				"[Sweep] Skipping autocomplete: API key required for hosted mode",
			);
			return null;
		}

		const body = transport.compressed
			? await this.compress(transport.body)
			: Buffer.from(transport.body, "utf-8");
		try {
			const response = await this.sendRequest(
				transport.apiUrl,
				body,
				apiKey,
				transport.schema,
				transport.compressed,
				signal,
			);
			return adapter.handleResponse(response);
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				return null;
			}
			console.error("[Sweep] API request failed:", error);
			return null;
		}
	}

	private sendMetricsRequest(body: string, apiKey: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const url = new URL(this.metricsUrl);
			console.log("[Sweep] Sending metrics request", {
				url: url.toString(),
				hasApiKey: Boolean(apiKey),
			});
			const isHttps = url.protocol === "https:";
			const defaultPort = isHttps ? 443 : 80;

			const options: http.RequestOptions = {
				hostname: url.hostname,
				port: url.port || defaultPort,
				path: url.pathname,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			};

			if (apiKey) {
				options.headers = {
					...options.headers,
					Authorization: `Bearer ${apiKey}`,
				};
			}

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
