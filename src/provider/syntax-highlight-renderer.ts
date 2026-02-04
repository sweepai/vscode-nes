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

let cachedThemeSetting: string | null = null;
let cachedThemeJson: Record<string, unknown> | null = null;
let cachedEditorBackground: string | null = null;
let themeVersion = 0;

function resetThemeCache(): void {
	cachedThemeSetting = null;
	cachedThemeJson = null;
	cachedEditorBackground = null;
}

function getActiveThemeSetting(): string | null {
	return (
		vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") ??
		null
	);
}

function getCachedThemeJson(): Record<string, unknown> | null {
	const currentSetting = getActiveThemeSetting();
	if (
		currentSetting &&
		cachedThemeSetting === currentSetting &&
		cachedThemeJson
	) {
		return cachedThemeJson;
	}
	cachedThemeSetting = currentSetting;
	cachedThemeJson = discoverActiveTheme();
	cachedEditorBackground = null;
	return cachedThemeJson;
}

function getEditorBackgroundColor(isDark: boolean): string {
	if (cachedEditorBackground) return cachedEditorBackground;
	const themeJson = getCachedThemeJson();
	const themeColors = (themeJson?.colors ?? {}) as Record<string, unknown>;
	const editorBg = themeColors["editor.background"];
	if (typeof editorBg === "string" && editorBg.length > 0) {
		cachedEditorBackground = editorBg;
		return editorBg;
	}
	const fallback = isDark ? "#1e1e1e" : "#ffffff";
	cachedEditorBackground = fallback;
	return fallback;
}

export function initSyntaxHighlighter(): void {
	const dark = isDarkTheme();
	const themeJson = getCachedThemeJson();

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
	resetThemeCache();
	themeVersion += 1;
	initSyntaxHighlighter();
	clearSvgCache();
}

interface ColoredToken {
	content: string;
	color?: string;
}

interface EditorFontSettings {
	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	ligatures: boolean;
	tabSize: number;
}

function getEditorFontSettings(): EditorFontSettings {
	const editorConfig = vscode.workspace.getConfiguration("editor");
	const fontFamily = editorConfig.get<string>("fontFamily", "monospace");
	const fontSize = editorConfig.get<number>("fontSize", 13);
	const lineHeight = editorConfig.get<number>("lineHeight", 0);
	const ligaturesRaw = editorConfig.get<boolean | string>(
		"fontLigatures",
		false,
	);
	const ligatures =
		typeof ligaturesRaw === "string" ? ligaturesRaw.length > 0 : ligaturesRaw;
	const editorTabSize =
		typeof vscode.window.activeTextEditor?.options.tabSize === "number"
			? (vscode.window.activeTextEditor?.options.tabSize as number)
			: undefined;
	const tabSize = editorConfig.get<number>("tabSize", editorTabSize ?? 4);

	return { fontFamily, fontSize, lineHeight, ligatures, tabSize };
}

function expandTabs(
	text: string,
	tabSize: number,
): { expanded: string; indexMap: number[] } {
	let column = 0;
	const indexMap: number[] = new Array(text.length + 1);
	let expanded = "";

	for (let i = 0; i < text.length; i++) {
		indexMap[i] = expanded.length;
		const ch = text[i];
		if (ch === "\t") {
			const spaces = tabSize - (column % tabSize || 0);
			expanded += " ".repeat(spaces);
			column += spaces;
		} else {
			expanded += ch;
			column += 1;
		}
	}
	indexMap[text.length] = expanded.length;
	return { expanded, indexMap };
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
		return [
			{ content: text, color: dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT },
		];
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

function renderSyntaxHighlightedSvgFromLines(
	lines: string[],
	languageId: string,
	dark: boolean,
	highlightRangesByLine: HighlightRange[][],
	cachePrefix: string,
): vscode.Uri {
	const settings = getEditorFontSettings();
	const lineHeight =
		settings.lineHeight > 0
			? settings.lineHeight
			: Math.ceil(settings.fontSize * 1.35);
	const fontSize = settings.fontSize;
	const textY = Math.ceil(lineHeight - settings.fontSize * 0.25);
	const charWidth = settings.fontSize * 0.6;
	const safeLines = lines.length > 0 ? lines : [""];

	const expandedLines = safeLines.map((line) =>
		expandTabs(line, settings.tabSize),
	);
	const tokensByLine = expandedLines.map(({ expanded }) =>
		tokenizeWithShiki(expanded, languageId, dark),
	);
	const lineWidths = expandedLines.map(
		({ expanded }) => expanded.length * charWidth,
	);
	const totalWidth = Math.max(1, ...lineWidths);
	const totalHeight = lineHeight * safeLines.length;

	const rects: string[] = [];
	for (let lineIndex = 0; lineIndex < safeLines.length; lineIndex++) {
		const lineText = safeLines[lineIndex];
		if (lineText === undefined) continue;
		const ranges = highlightRangesByLine[lineIndex] ?? [];
		const expandedLine = expandedLines[lineIndex];
		if (!expandedLine) continue;
		const { indexMap } = expandedLine;
		for (const range of ranges) {
			const start = Math.max(0, Math.min(range.start, lineText.length));
			const end = Math.max(start, Math.min(range.end, lineText.length));
			if (end <= start) continue;
			const mappedStart = indexMap[start] ?? start;
			const mappedEnd = indexMap[end] ?? end;
			const x = mappedStart * charWidth;
			const width = (mappedEnd - mappedStart) * charWidth;
			const y = lineIndex * lineHeight;
			rects.push(
				`<rect x="${x}" y="${y}" width="${width}" height="${lineHeight}" rx="0" ry="0" fill="${range.color}"/>`,
			);
		}
	}

	const textElements: string[] = [];
	for (let lineIndex = 0; lineIndex < safeLines.length; lineIndex++) {
		const tokens = tokensByLine[lineIndex];
		if (!tokens || tokens.length === 0) continue;
		const tspans: string[] = [];
		for (const token of tokens) {
			const color =
				token.color ?? (dark ? FALLBACK_FG_DARK : FALLBACK_FG_LIGHT);
			const escapedText = escapeXml(token.content);
			const displayText = escapedText.replace(/ /g, "&#160;");
			tspans.push(`<tspan fill="${color}">${displayText}</tspan>`);
		}
		const y = lineIndex * lineHeight + textY;
		const lineWidth = lineWidths[lineIndex];
		if (lineWidth === undefined) continue;
		const textLengthAttr =
			lineWidth > 0
				? ` textLength="${lineWidth}" lengthAdjust="spacingAndGlyphs"`
				: "";
		textElements.push(
			`<text x="0" y="${y}" font-family="${escapeXml(
				settings.fontFamily,
			)}" font-size="${fontSize}px"${textLengthAttr}
        font-variant-ligatures="${settings.ligatures ? "normal" : "none"}"
        style="font-feature-settings: ${
					settings.ligatures ? "'liga' 1, 'calt' 1" : "'liga' 0, 'calt' 0"
				};">
    ${tspans.join("")}
  </text>`,
		);
	}

	const backgroundColor = getEditorBackgroundColor(dark);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}">
  <rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="${backgroundColor}"
        stroke="${dark ? "rgba(110, 110, 110, 0.35)" : "rgba(130, 130, 130, 0.35)"}" stroke-width="1"/>
  ${rects.join("")}
  ${textElements.join("")}
</svg>`;

	const themeSetting = getActiveThemeSetting() ?? "";
	const hash = Buffer.from(
		cachePrefix +
			safeLines.join("\n") +
			languageId +
			dark +
			JSON.stringify(highlightRangesByLine) +
			JSON.stringify(settings) +
			backgroundColor +
			themeSetting +
			themeVersion.toString(),
	)
		.toString("base64url")
		.slice(0, 16);
	const svgPath = path.join(getSvgCacheDir(), `${cachePrefix}-${hash}.svg`);
	fs.writeFileSync(svgPath, svg, "utf8");

	return vscode.Uri.file(svgPath);
}

export function generateSyntaxHighlightedSvg(
	text: string,
	languageId: string,
	dark: boolean,
	highlightRanges: HighlightRange[] = [],
): vscode.Uri {
	return renderSyntaxHighlightedSvgFromLines(
		[text],
		languageId,
		dark,
		[highlightRanges],
		"hl",
	);
}

export function generateSyntaxHighlightedSvgMultiline(
	lines: string[],
	languageId: string,
	dark: boolean,
	highlightRangesByLine: HighlightRange[][] = [],
): vscode.Uri {
	return renderSyntaxHighlightedSvgFromLines(
		lines,
		languageId,
		dark,
		highlightRangesByLine,
		"hlm",
	);
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

export interface HighlightRange {
	start: number;
	end: number;
	color: string;
}

export function createHighlightedBoxDecoration(
	text: string,
	languageId: string,
	range: vscode.Range,
	highlightRanges: HighlightRange[] = [],
): vscode.DecorationOptions {
	const dark = isDarkTheme();
	const svgUri = generateSyntaxHighlightedSvg(
		text,
		languageId,
		dark,
		highlightRanges,
	);

	return {
		range,
		renderOptions: {
			after: {
				contentIconPath: svgUri,
				textDecoration: buildBoxTextDecoration("-40%"),
			},
		},
	};
}

export function createHighlightedBoxDecorationMultiline(
	lines: string[],
	languageId: string,
	range: vscode.Range,
	highlightRangesByLine: HighlightRange[][] = [],
): vscode.DecorationOptions {
	const dark = isDarkTheme();
	const svgUri = generateSyntaxHighlightedSvgMultiline(
		lines,
		languageId,
		dark,
		highlightRangesByLine,
	);
	const settings = getEditorFontSettings();
	const lineHeight =
		settings.lineHeight > 0
			? settings.lineHeight
			: Math.ceil(settings.fontSize * 1.35);

	return {
		range,
		renderOptions: {
			after: {
				contentIconPath: svgUri,
				textDecoration: buildBoxTextDecoration(`-${lineHeight / 2}px`),
			},
		},
	};
}

function buildBoxTextDecoration(translateY: string): string {
	return `none; position: absolute; top: 50%; transform: translateY(${translateY}); margin-left: 12px`;
}
