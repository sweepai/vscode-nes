import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { config } from "~/core/config.ts";

const HEALTH_CHECK_TIMEOUT_MS = 2_000;
const SERVER_START_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 500;
const MAX_CONSECUTIVE_FAILURES = 3;
const RESTART_COOLDOWN_MS = 60_000;

export class LocalAutocompleteServer implements vscode.Disposable {
	private process: child_process.ChildProcess | null = null;
	private starting = false;
	private consecutiveFailures = 0;
	private lastRestartTime = 0;

	async ensureServerRunning(): Promise<void> {
		if (this.starting) return;
		if (await this.isServerHealthy()) return;
		await this.startServer();
	}

	async isServerHealthy(): Promise<boolean> {
		const port = config.localPort;
		return new Promise((resolve) => {
			const req = http.get(
				`http://localhost:${port}`,
				{ timeout: HEALTH_CHECK_TIMEOUT_MS },
				(res) => {
					res.resume();
					// Any response (2xx-4xx) means the server is running
					resolve(res.statusCode !== undefined && res.statusCode < 500);
				},
			);
			req.on("error", () => resolve(false));
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
		});
	}

	async startServer(): Promise<void> {
		if (this.starting) return;
		this.starting = true;

		try {
			const uvxPath = await this.resolveUvx();
			if (!uvxPath) {
				const install = await vscode.window.showWarningMessage(
					"Sweep Local Mode requires 'uvx' (from uv) but it was not found on your system.",
					"Install uv",
					"Cancel",
				);
				if (install === "Install uv") {
					await this.installUv();
					const retryPath = await this.resolveUvx();
					if (!retryPath) {
						vscode.window.showErrorMessage(
							"Failed to find uvx after installing uv. Please restart your terminal and try again.",
						);
						return;
					}
					await this.spawnServer(retryPath);
				}
				return;
			}

			await this.spawnServer(uvxPath);
		} finally {
			this.starting = false;
		}
	}

	stopServer(): void {
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
	}

	reportSuccess(): void {
		this.consecutiveFailures = 0;
	}

	reportFailure(): void {
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			const now = Date.now();
			if (now - this.lastRestartTime > RESTART_COOLDOWN_MS) {
				this.lastRestartTime = now;
				this.consecutiveFailures = 0;
				console.log(
					"[Sweep] Local server: too many consecutive failures, restarting...",
				);
				this.stopServer();
				this.ensureServerRunning();
			}
		}
	}

	getServerUrl(): string {
		return `http://localhost:${config.localPort}`;
	}

	dispose(): void {
		this.stopServer();
	}

	private async spawnServer(uvxPath: string): Promise<void> {
		this.stopServer();

		const port = config.localPort;
		console.log(
			`[Sweep] Starting local autocomplete server on port ${port}...`,
		);

		this.process = child_process.spawn(
			uvxPath,
			["sweep-autocomplete", "--port", String(port)],
			{
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			},
		);

		this.process.stderr?.on("data", (data: Buffer) => {
			console.log(`[Sweep] Local server stderr: ${data.toString().trim()}`);
		});

		this.process.stdout?.on("data", (data: Buffer) => {
			console.log(`[Sweep] Local server stdout: ${data.toString().trim()}`);
		});

		this.process.on("exit", (code) => {
			console.log(`[Sweep] Local server exited with code ${code}`);
			this.process = null;
		});

		// Poll for health until ready
		const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await sleep(HEALTH_POLL_INTERVAL_MS);
			if (await this.isServerHealthy()) {
				console.log("[Sweep] Local autocomplete server is ready.");
				return;
			}
			// Process may have exited
			if (this.process === null) {
				throw new Error("Local server process exited before becoming healthy");
			}
		}

		throw new Error(
			`Local server did not become healthy within ${SERVER_START_TIMEOUT_MS / 1000}s`,
		);
	}

	private async resolveUvx(): Promise<string | null> {
		// Check PATH first
		const pathResult = this.whichSync("uvx");
		if (pathResult) return pathResult;

		// Check common installation locations
		const home = os.homedir();
		const candidates = [
			path.join(home, ".local", "bin", "uvx"),
			path.join(home, ".cargo", "bin", "uvx"),
		];

		if (process.platform === "win32") {
			candidates.push(
				path.join(
					// biome-ignore lint/complexity/useLiteralKeys: tsgo requires bracket notation for index signatures
					process.env["LOCALAPPDATA"] || path.join(home, "AppData", "Local"),
					"uv",
					"bin",
					"uvx.exe",
				),
			);
		}

		for (const candidate of candidates) {
			try {
				await fs.promises.access(candidate, fs.constants.X_OK);
				return candidate;
			} catch {
				// not found here
			}
		}

		return null;
	}

	private whichSync(command: string): string | null {
		try {
			const result = child_process.execSync(
				process.platform === "win32" ? `where ${command}` : `which ${command}`,
				{ encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
			);
			const firstLine = result.trim().split("\n")[0];
			return firstLine || null;
		} catch {
			return null;
		}
	}

	private async installUv(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const isWindows = process.platform === "win32";

			let proc: child_process.ChildProcess;
			if (isWindows) {
				proc = child_process.spawn(
					"powershell",
					[
						"-ExecutionPolicy",
						"ByPass",
						"-c",
						"irm https://astral.sh/uv/install.ps1 | iex",
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
			} else {
				proc = child_process.spawn(
					"sh",
					["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
			}

			let stderr = "";
			proc.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on("exit", (code) => {
				if (code === 0) {
					console.log("[Sweep] uv installed successfully.");
					resolve();
				} else {
					console.error(`[Sweep] uv installation failed: ${stderr}`);
					reject(new Error(`uv installation failed with code ${code}`));
				}
			});

			proc.on("error", (err) => {
				reject(new Error(`Failed to start uv installer: ${err.message}`));
			});
		});
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
