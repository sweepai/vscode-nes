import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HighlighterCore } from "@shikijs/core";

import { createHighlighterCoreSync } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import langC from "@shikijs/langs/c";
import langCpp from "@shikijs/langs/cpp";
import langCsharp from "@shikijs/langs/csharp";
import langCss from "@shikijs/langs/css";
import langGo from "@shikijs/langs/go";
import langHtml from "@shikijs/langs/html";
import langJava from "@shikijs/langs/java";
import langJs from "@shikijs/langs/javascript";
import langJson from "@shikijs/langs/json";
import langJsx from "@shikijs/langs/jsx";
import langKotlin from "@shikijs/langs/kotlin";
import langMarkdown from "@shikijs/langs/markdown";
import langPhp from "@shikijs/langs/php";
import langPython from "@shikijs/langs/python";
import langRuby from "@shikijs/langs/ruby";
import langRust from "@shikijs/langs/rust";
import langBash from "@shikijs/langs/shellscript";
import langSwift from "@shikijs/langs/swift";
import langToml from "@shikijs/langs/toml";
import langTsx from "@shikijs/langs/tsx";
import langTs from "@shikijs/langs/typescript";
import langYaml from "@shikijs/langs/yaml";
import darkPlusTheme from "@shikijs/themes/dark-plus";
import lightPlusTheme from "@shikijs/themes/light-plus";
import * as vscode from "vscode";

const ALL_LANGS = [
	...langBash,
	...langC,
	...langCpp,
	...langCsharp,
	...langCss,
	...langGo,
	...langHtml,
	...langJava,
	...langJs,
	...langJson,
	...langJsx,
	...langKotlin,
	...langMarkdown,
	...langPhp,
	...langPython,
	...langRuby,
	...langRust,
	...langSwift,
	...langToml,
	...langTs,
	...langTsx,
	...langYaml,
];

/** VS Code languageId → shiki grammar name (only where they differ) */
const LANGUAGE_MAP: Record<string, string> = {
	javascriptreact: "jsx",
	typescriptreact: "tsx",
};

function resolveLanguageId(vscodeLanguageId: string): string {
	return LANGUAGE_MAP[vscodeLanguageId] ?? vscodeLanguageId;
}

// ── Highlighter singleton ──────────────────────────────────────────────

const FALLBACK_FG_DARK = "#D4D4D4";
const FALLBACK_FG_LIGHT = "#000000";
const USER_THEME_NAME = "user-theme";

let highlighter: HighlighterCore;

/**
 * Discovers and reads the user's active VS Code color theme file.
 * Returns the parsed theme JSON if found, or null.
 *
 * VS Code stores a theme identifier in `workbench.colorTheme`. This can be:
 * - The explicit `id` from the extension's `contributes.themes`
 * - The `label` (for many third-party themes)
 * - An auto-generated ID: `${extensionId}-${path-stem}` (when no explicit id)
 */
function discoverActiveTheme(): Record<string, unknown> | null {
	try {
		const themeSetting = vscode.workspace
			.getConfiguration("workbench")
			.get<string>("colorTheme");
		if (!themeSetting) return null;

		const settingLower = themeSetting.toLowerCase();

		for (const ext of vscode.extensions.all) {
			const themes = ext.packageJSON?.contributes?.themes as
				| Array<{
						label?: string;
						id?: string;
						uiTheme?: string;
						path?: string;
				  }>
				| undefined;
			if (!themes) continue;

			for (const themeEntry of themes) {
				if (!themeEntry.path) continue;

				// Match against explicit id, label, or the auto-generated ID
				// that VS Code constructs as `${extensionId}-${path-stem}`
				const candidates: string[] = [];
				if (themeEntry.id) candidates.push(themeEntry.id);
				if (themeEntry.label) candidates.push(themeEntry.label);

				// VS Code generates the ID from extension ID + path stem when
				// no explicit id is provided. e.g. for a built-in theme at
				// "./themes/dark_plus.json" in extension "vscode.theme-defaults",
				// the generated ID might be "Default Dark+".
				const pathStem = path.basename(
					themeEntry.path,
					path.extname(themeEntry.path),
				);
				candidates.push(`${ext.id}-${pathStem}`);

				const matched = candidates.some(
					(c) => c.toLowerCase() === settingLower,
				);
				if (!matched) continue;

				const themePath = path.join(ext.extensionPath, themeEntry.path);
				const result = resolveThemeFile(themePath);
				if (result) {
					console.log(
						"[Sweep] Discovered active theme:",
						themeSetting,
						"from",
						ext.id,
					);
					return result;
				}
			}
		}

		console.warn("[Sweep] Could not find theme file for:", themeSetting);
	} catch (err) {
		console.warn("[Sweep] Failed to discover active theme:", err);
	}
	return null;
}

function stripJsonComments(raw: string): string {
	let result = "";
	let i = 0;
	let inString = false;

	while (i < raw.length) {
		const char = raw[i];
		const next = raw[i + 1];

		if (inString) {
			result += char;
			if (char === "\\" && i + 1 < raw.length) {
				result += raw[i + 1];
				i += 2;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			i++;
			continue;
		}

		if (char === '"') {
			inString = true;
			result += char;
			i++;
			continue;
		}

		if (char === "/" && next === "/") {
			while (i < raw.length && raw[i] !== "\n") i++;
			continue;
		}

		if (char === "/" && next === "*") {
			i += 2;
			while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
				i++;
			}
			i += 2; // Skip closing */
			continue;
		}

		result += char;
		i++;
	}

	return result;
}

function parseJsonc(raw: string): unknown {
	const stripped = stripJsonComments(raw);
	const cleaned = stripped.replace(/,\s*([}\]])/g, "$1");
	return JSON.parse(cleaned);
}

function resolveThemeFile(themePath: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(themePath, "utf8");
		const theme = parseJsonc(raw) as Record<string, unknown>;

		if (typeof theme.include === "string") {
			const parentPath = path.resolve(path.dirname(themePath), theme.include);
			const parent = resolveThemeFile(parentPath);
			if (parent) {
				const parentTokenColors = (parent.tokenColors as unknown[]) ?? [];
				const childTokenColors = (theme.tokenColors as unknown[]) ?? [];
				const parentColors = (parent.colors ?? {}) as Record<string, string>;
				const childColors = (theme.colors ?? {}) as Record<string, string>;

				return {
					...parent,
					...theme,
					tokenColors: [...parentTokenColors, ...childTokenColors],
					colors: { ...parentColors, ...childColors },
				};
			}
		}

		return theme;
	} catch (err) {
		console.warn("[Sweep] Failed to read theme file:", themePath, err);
		return null;
	}
}

function buildShikiTheme(
	themeJson: Record<string, unknown>,
	isDark: boolean,
): Record<string, unknown> {
	return {
		name: USER_THEME_NAME,
		type: isDark ? "dark" : "light",
		colors: themeJson.colors ?? {},
		tokenColors: themeJson.tokenColors ?? [],
		semanticHighlighting: themeJson.semanticHighlighting,
		semanticTokenColors: themeJson.semanticTokenColors,
	};
}

export function initSyntaxHighlighter(): void {
	const dark = isDarkTheme();
	const themeJson = discoverActiveTheme();

	const themes: Record<string, unknown>[] = [darkPlusTheme, lightPlusTheme];
	if (themeJson) {
		themes.push(buildShikiTheme(themeJson, dark));
	}

	highlighter = createHighlighterCoreSync({
		themes,
		langs: ALL_LANGS,
		engine: createJavaScriptRegexEngine(),
	});
}

export function reloadTheme(): void {
	initSyntaxHighlighter();
	clearSvgCache();
}

interface ColoredToken {
	content: string;
	color?: string;
}

function tokenizeWithShiki(
	text: string,
	languageId: string,
	dark: boolean,
): ColoredToken[] {
	if (!highlighter) {
		initSyntaxHighlighter();
	}

	const lang = resolveLanguageId(languageId);

	const themeName = hasUserTheme()
		? USER_THEME_NAME
		: dark
			? "dark-plus"
			: "light-plus";

	try {
		const result = highlighter.codeToTokensBase(text, {
			lang,
			theme: themeName,
		});
		const fallback = dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT;
		return result[0] ?? [{ content: text, color: fallback }];
	} catch {
		return [{ content: text, color: dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT }];
	}
}

function hasUserTheme(): boolean {
	try {
		return highlighter.getLoadedThemes().includes(USER_THEME_NAME);
	} catch {
		return false;
	}
}

// ── SVG rendering ──────────────────────────────────────────────────────

let svgCacheDir: string | null = null;

function getSvgCacheDir(): string {
	if (!svgCacheDir) {
		svgCacheDir = path.join(os.tmpdir(), "sweep-nes-svg-cache");
		if (!fs.existsSync(svgCacheDir)) {
			fs.mkdirSync(svgCacheDir, { recursive: true });
		}
	}
	return svgCacheDir;
}

function clearSvgCache(): void {
	try {
		const dir = getSvgCacheDir();
		for (const file of fs.readdirSync(dir)) {
			if (file.startsWith("hl-")) {
				fs.unlinkSync(path.join(dir, file));
			}
		}
	} catch {
		// Ignore cleanup errors
	}
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function generateSyntaxHighlightedSvg(
	text: string,
	languageId: string,
	dark: boolean,
): vscode.Uri {
	const tokens = tokenizeWithShiki(text, languageId, dark);

	const charWidth = 7.8;
	const paddingX = 8;
	const fontSize = 13;
	const height = 18;
	const textY = 14;
	const totalWidth = text.length * charWidth + paddingX * 2;

	const tspans: string[] = [];
	for (const token of tokens) {
		const color = token.color ?? (dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT);
		const escapedText = escapeXml(token.content);
		const displayText = escapedText.replace(/ /g, "&#160;");
		tspans.push(`<tspan fill="${color}">${displayText}</tspan>`);
	}

	const bgColor = dark ? "rgba(155, 185, 85, 0.15)" : "rgba(155, 185, 85, 0.2)";
	const borderColor = dark
		? "rgba(155, 185, 85, 0.5)"
		: "rgba(155, 185, 85, 0.7)";

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height}" width="${totalWidth}" height="${height}">
  <rect x="0" y="0" width="${totalWidth}" height="${height}" rx="6" ry="6"
        fill="${bgColor}" stroke="${borderColor}" stroke-width="1"/>
  <text x="${paddingX}" y="${textY}" font-family="monospace" font-size="${fontSize}px">
    ${tspans.join("")}
  </text>
</svg>`;

	const hash = Buffer.from(text + languageId + dark)
		.toString("base64url")
		.slice(0, 16);
	const svgPath = path.join(getSvgCacheDir(), `hl-${hash}.svg`);
	fs.writeFileSync(svgPath, svg, "utf8");

	return vscode.Uri.file(svgPath);
}

// ── Theme detection ────────────────────────────────────────────────────

export function isDarkTheme(): boolean {
	const colorTheme = vscode.window.activeColorTheme;
	return (
		colorTheme.kind === vscode.ColorThemeKind.Dark ||
		colorTheme.kind === vscode.ColorThemeKind.HighContrast
	);
}

// ── Decoration helper ──────────────────────────────────────────────────

export function createHighlightedBoxDecoration(
	text: string,
	languageId: string,
	range: vscode.Range,
): vscode.DecorationOptions {
	const dark = isDarkTheme();
	const svgUri = generateSyntaxHighlightedSvg(text, languageId, dark);

	return {
		range,
		renderOptions: {
			after: {
				contentIconPath: svgUri,
				textDecoration:
					"none; position: absolute; top: 50%; transform: translateY(-40%); margin-left: 12px",
			},
		},
	};
}
