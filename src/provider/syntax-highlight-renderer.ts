import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Token types that we can identify and colorize
 */
type TokenType =
	| "keyword"
	| "string"
	| "number"
	| "comment"
	| "function"
	| "type"
	| "variable"
	| "operator"
	| "punctuation"
	| "default";

interface Token {
	text: string;
	type: TokenType;
}

/**
 * Language-specific keyword sets
 */
const KEYWORDS: Record<string, Set<string>> = {
	python: new Set([
		"def",
		"class",
		"if",
		"elif",
		"else",
		"for",
		"while",
		"try",
		"except",
		"finally",
		"with",
		"as",
		"import",
		"from",
		"return",
		"yield",
		"raise",
		"pass",
		"break",
		"continue",
		"and",
		"or",
		"not",
		"in",
		"is",
		"None",
		"True",
		"False",
		"lambda",
		"async",
		"await",
		"self",
		"global",
		"nonlocal",
	]),
	javascript: new Set([
		"const",
		"let",
		"var",
		"function",
		"if",
		"else",
		"for",
		"while",
		"do",
		"switch",
		"case",
		"break",
		"continue",
		"return",
		"try",
		"catch",
		"finally",
		"throw",
		"new",
		"class",
		"extends",
		"import",
		"export",
		"default",
		"from",
		"async",
		"await",
		"this",
		"super",
		"typeof",
		"instanceof",
		"null",
		"undefined",
		"true",
		"false",
	]),
	typescript: new Set([
		"const",
		"let",
		"var",
		"function",
		"if",
		"else",
		"for",
		"while",
		"do",
		"switch",
		"case",
		"break",
		"continue",
		"return",
		"try",
		"catch",
		"finally",
		"throw",
		"new",
		"class",
		"extends",
		"implements",
		"import",
		"export",
		"default",
		"from",
		"async",
		"await",
		"this",
		"super",
		"typeof",
		"instanceof",
		"null",
		"undefined",
		"true",
		"false",
		"type",
		"interface",
		"enum",
		"namespace",
		"abstract",
		"private",
		"protected",
		"public",
		"readonly",
		"static",
		"as",
		"is",
		"keyof",
		"infer",
	]),
	go: new Set([
		"package",
		"import",
		"func",
		"var",
		"const",
		"type",
		"struct",
		"interface",
		"map",
		"chan",
		"if",
		"else",
		"for",
		"range",
		"switch",
		"case",
		"default",
		"break",
		"continue",
		"return",
		"go",
		"defer",
		"select",
		"fallthrough",
		"nil",
		"true",
		"false",
	]),
	rust: new Set([
		"fn",
		"let",
		"mut",
		"const",
		"if",
		"else",
		"match",
		"for",
		"while",
		"loop",
		"break",
		"continue",
		"return",
		"struct",
		"enum",
		"impl",
		"trait",
		"type",
		"use",
		"mod",
		"pub",
		"self",
		"super",
		"crate",
		"async",
		"await",
		"move",
		"ref",
		"static",
		"unsafe",
		"where",
		"true",
		"false",
		"Some",
		"None",
		"Ok",
		"Err",
	]),
};

// Fallback keywords for unknown languages
const DEFAULT_KEYWORDS = new Set([
	"if",
	"else",
	"for",
	"while",
	"return",
	"function",
	"class",
	"import",
	"export",
	"const",
	"let",
	"var",
	"true",
	"false",
	"null",
	"undefined",
	"this",
	"new",
	"try",
	"catch",
	"throw",
]);

/**
 * Built-in type names common across languages
 */
const TYPE_NAMES = new Set([
	"string",
	"number",
	"boolean",
	"int",
	"float",
	"double",
	"char",
	"void",
	"bool",
	"String",
	"Number",
	"Boolean",
	"Array",
	"Object",
	"Map",
	"Set",
	"List",
	"Dict",
	"Tuple",
	"Optional",
	"Result",
	"Promise",
	"Future",
	"Vec",
	"HashMap",
	"HashSet",
]);

/**
 * Simple tokenizer for syntax highlighting in decorations.
 * This is intentionally simple - for full accuracy, we rely on the HoverProvider.
 */
export function tokenizeLine(line: string, languageId: string): Token[] {
	const tokens: Token[] = [];
	const keywords = KEYWORDS[languageId] ?? DEFAULT_KEYWORDS;

	let i = 0;
	while (i < line.length) {
		const char = line.charAt(i);

		// Whitespace
		if (/\s/.test(char)) {
			let text = "";
			while (i < line.length && /\s/.test(line.charAt(i))) {
				text += line.charAt(i);
				i++;
			}
			tokens.push({ text, type: "default" });
			continue;
		}

		// String literals (single, double, backtick, triple quotes)
		if (char === '"' || char === "'" || char === "`") {
			const quote = char;
			// Check for triple quotes (Python)
			const isTriple =
				line.slice(i, i + 3) === quote.repeat(3) && languageId === "python";
			const endQuote = isTriple ? quote.repeat(3) : quote;
			let text = isTriple ? quote.repeat(3) : quote;
			i += isTriple ? 3 : 1;

			while (i < line.length) {
				if (line.slice(i, i + endQuote.length) === endQuote) {
					text += endQuote;
					i += endQuote.length;
					break;
				}
				if (line.charAt(i) === "\\" && i + 1 < line.length) {
					text += line.charAt(i) + line.charAt(i + 1);
					i += 2;
				} else {
					text += line.charAt(i);
					i++;
				}
			}
			tokens.push({ text, type: "string" });
			continue;
		}

		// Comments
		if (line.slice(i, i + 2) === "//" || char === "#") {
			const text = line.slice(i);
			tokens.push({ text, type: "comment" });
			break;
		}

		// Multi-line comment start (we only handle single lines here)
		if (line.slice(i, i + 2) === "/*") {
			let text = "/*";
			i += 2;
			while (i < line.length) {
				if (line.slice(i, i + 2) === "*/") {
					text += "*/";
					i += 2;
					break;
				}
				text += line.charAt(i);
				i++;
			}
			tokens.push({ text, type: "comment" });
			continue;
		}

		// Numbers
		if (
			/\d/.test(char) ||
			(char === "." && /\d/.test(line.charAt(i + 1) || ""))
		) {
			let text = "";
			while (i < line.length && /[\d.xXa-fA-FeE_]/.test(line.charAt(i))) {
				text += line.charAt(i);
				i++;
			}
			tokens.push({ text, type: "number" });
			continue;
		}

		// Identifiers (keywords, types, functions, variables)
		if (/[a-zA-Z_]/.test(char)) {
			let text = "";
			while (i < line.length && /[a-zA-Z0-9_]/.test(line.charAt(i))) {
				text += line.charAt(i);
				i++;
			}

			// Look ahead for function call
			const nextNonSpace = line.slice(i).match(/^\s*\(/);

			if (keywords.has(text)) {
				tokens.push({ text, type: "keyword" });
			} else if (TYPE_NAMES.has(text) || /^[A-Z][a-zA-Z0-9]*$/.test(text)) {
				// PascalCase or known type
				tokens.push({ text, type: "type" });
			} else if (nextNonSpace) {
				tokens.push({ text, type: "function" });
			} else {
				tokens.push({ text, type: "variable" });
			}
			continue;
		}

		// Operators
		if (/[+\-*/%=<>!&|^~?:]/.test(char)) {
			let text = char;
			i++;
			// Handle multi-char operators
			while (i < line.length && /[+\-*/%=<>!&|^~?:]/.test(line.charAt(i))) {
				text += line.charAt(i);
				i++;
			}
			tokens.push({ text, type: "operator" });
			continue;
		}

		// Punctuation
		if (/[()[\]{},;.]/.test(char)) {
			tokens.push({ text: char, type: "punctuation" });
			i++;
			continue;
		}

		// Fallback: unknown character
		tokens.push({ text: char, type: "default" });
		i++;
	}

	return tokens;
}

/**
 * Creates decoration types for each token type using theme-aware colors.
 * These use ThemeColor which adapts to the user's current theme.
 */
export function createTokenDecorationTypes(): Map<
	TokenType,
	vscode.TextEditorDecorationType
> {
	const types = new Map<TokenType, vscode.TextEditorDecorationType>();

	// Use semantic token colors from VS Code themes
	// These are the most reliable theme-aware colors available
	const tokenColors: Record<TokenType, string> = {
		keyword: "symbolIcon.keywordForeground",
		string: "terminal.ansiGreen",
		number: "terminal.ansiYellow",
		comment: "editorLineNumber.foreground",
		function: "symbolIcon.functionForeground",
		type: "symbolIcon.classForeground",
		variable: "symbolIcon.variableForeground",
		operator: "editor.foreground",
		punctuation: "editor.foreground",
		default: "editor.foreground",
	};

	// Create decoration types - these are positioned sequentially after the line
	for (const [tokenType, colorKey] of Object.entries(tokenColors)) {
		types.set(
			tokenType as TokenType,
			vscode.window.createTextEditorDecorationType({
				after: {
					color: new vscode.ThemeColor(colorKey),
					backgroundColor: "rgba(155, 185, 85, 0.15)",
					fontStyle: "normal",
				},
			}),
		);
	}

	return types;
}

/**
 * Render options for a single syntax-highlighted box line.
 * Returns an array of decoration options, one per token, that should be
 * applied at the end of a document line.
 */
export interface HighlightedBoxLine {
	decorationType: vscode.TextEditorDecorationType;
	options: vscode.DecorationOptions;
}

/**
 * The main floating box decoration type (for box styling).
 * Individual tokens use their own decoration types for colors.
 */
export const BOX_CONTAINER_DECORATION_TYPE =
	vscode.window.createTextEditorDecorationType({
		after: {
			backgroundColor: "rgba(155, 185, 85, 0.15)",
			border:
				"1px solid rgba(155, 185, 85, 0.5); border-radius: 4px; padding: 1px 8px; margin-left: 12px",
			fontStyle: "normal",
		},
	});

/**
 * Builds a syntax-highlighted preview as a MarkdownString.
 * This is used for the HoverProvider to show full syntax highlighting.
 */
export function buildSyntaxHighlightedMarkdown(
	code: string,
	languageId: string,
	title?: string,
): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.isTrusted = true;
	md.supportHtml = false;

	if (title) {
		md.appendMarkdown(`**${title}**\n\n`);
	}

	md.appendCodeblock(code, languageId);

	return md;
}

/**
 * Builds a diff-style preview showing before/after.
 */
export function buildDiffMarkdown(
	originalLines: string[],
	newLines: string[],
	languageId: string,
): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.isTrusted = true;
	md.supportHtml = false;

	md.appendMarkdown("**Suggested Edit**\n\n");

	// Show the new code with syntax highlighting
	md.appendCodeblock(newLines.join("\n"), languageId);

	// Optionally show diff
	if (originalLines.length > 0) {
		md.appendMarkdown("\n<details><summary>Show diff</summary>\n\n");

		const diffLines: string[] = [];
		const maxLen = Math.max(originalLines.length, newLines.length);
		for (let i = 0; i < maxLen; i++) {
			const oldLine = originalLines[i];
			const newLine = newLines[i];
			if (oldLine !== undefined && newLine === undefined) {
				diffLines.push(`- ${oldLine}`);
			} else if (oldLine === undefined && newLine !== undefined) {
				diffLines.push(`+ ${newLine}`);
			} else if (oldLine !== newLine) {
				diffLines.push(`- ${oldLine}`);
				diffLines.push(`+ ${newLine}`);
			} else {
				diffLines.push(`  ${oldLine}`);
			}
		}
		md.appendCodeblock(diffLines.join("\n"), "diff");
		md.appendMarkdown("\n</details>\n");
	}

	return md;
}

/**
 * Default dark theme colors for syntax highlighting.
 * These match common VS Code dark themes.
 */
const DARK_THEME_COLORS: Record<TokenType, string> = {
	keyword: "#C586C0", // Purple/magenta for keywords
	string: "#CE9178", // Orange/brown for strings
	number: "#B5CEA8", // Light green for numbers
	comment: "#6A9955", // Green for comments
	function: "#DCDCAA", // Yellow for functions
	type: "#4EC9B0", // Cyan/teal for types
	variable: "#9CDCFE", // Light blue for variables
	operator: "#D4D4D4", // Light gray for operators
	punctuation: "#D4D4D4", // Light gray for punctuation
	default: "#D4D4D4", // Default text color
};

/**
 * Light theme colors for syntax highlighting.
 */
const LIGHT_THEME_COLORS: Record<TokenType, string> = {
	keyword: "#AF00DB", // Purple for keywords
	string: "#A31515", // Red/brown for strings
	number: "#098658", // Green for numbers
	comment: "#008000", // Green for comments
	function: "#795E26", // Brown for functions
	type: "#267F99", // Teal for types
	variable: "#001080", // Dark blue for variables
	operator: "#000000", // Black for operators
	punctuation: "#000000", // Black for punctuation
	default: "#000000", // Default text color
};

/**
 * SVG icon cache directory
 */
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

/**
 * Escapes text for safe SVG embedding
 */
function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Generates an SVG with syntax-highlighted text.
 * Returns a URI to the SVG file.
 */
export function generateSyntaxHighlightedSvg(
	text: string,
	languageId: string,
	isDarkTheme: boolean,
): vscode.Uri {
	const tokens = tokenizeLine(text, languageId);
	const colors = isDarkTheme ? DARK_THEME_COLORS : LIGHT_THEME_COLORS;

	// Match editor font size (~13px) while staying within line height
	const charWidth = 7.8;
	const paddingX = 8;
	const fontSize = 13;
	const height = 18;
	const textY = 14; // Baseline position within 18px height
	const totalWidth = text.length * charWidth + paddingX * 2;

	// Build SVG text elements with colored spans using tspans
	const tspans: string[] = [];

	for (const token of tokens) {
		const color = colors[token.type];
		const escapedText = escapeXml(token.text);
		// Replace spaces with non-breaking space for SVG
		const displayText = escapedText.replace(/ /g, "&#160;");
		tspans.push(`<tspan fill="${color}">${displayText}</tspan>`);
	}

	const bgColor = isDarkTheme
		? "rgba(155, 185, 85, 0.15)"
		: "rgba(155, 185, 85, 0.2)";
	const borderColor = isDarkTheme
		? "rgba(155, 185, 85, 0.5)"
		: "rgba(155, 185, 85, 0.7)";

	// Use viewBox for proper scaling when CSS constrains height
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height}" width="${totalWidth}" height="${height}">
  <rect x="0" y="0" width="${totalWidth}" height="${height}" rx="6" ry="6" 
        fill="${bgColor}" stroke="${borderColor}" stroke-width="1"/>
  <text x="${paddingX}" y="${textY}" font-family="monospace" font-size="${fontSize}px">
    ${tspans.join("")}
  </text>
</svg>`;

	// Write SVG to temp file and return URI
	const hash = Buffer.from(text + languageId + isDarkTheme)
		.toString("base64url")
		.slice(0, 16);
	const svgPath = path.join(getSvgCacheDir(), `hl-${hash}.svg`);
	fs.writeFileSync(svgPath, svg, "utf8");

	return vscode.Uri.file(svgPath);
}

/**
 * Detects if the current VS Code theme is dark.
 */
export function isDarkTheme(): boolean {
	const colorTheme = vscode.window.activeColorTheme;
	// ColorThemeKind: 1 = Light, 2 = Dark, 3 = HighContrast (dark), 4 = HighContrastLight
	return (
		colorTheme.kind === vscode.ColorThemeKind.Dark ||
		colorTheme.kind === vscode.ColorThemeKind.HighContrast
	);
}

/**
 * Creates decoration options with a syntax-highlighted SVG icon.
 */
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
				// Use CSS hack to position absolutely and not affect line height
				textDecoration: "none; position: absolute; top: 50%; transform: translateY(-40%); margin-left: 12px",
			},
		},
	};
}
