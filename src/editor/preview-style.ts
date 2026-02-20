export interface PreviewBoxStyleInput {
	lineCount: number;
	maxLineLength: number;
	fontSize: number;
	lineHeight: number;
	marginLeftPx?: number;
}

export function resolveLineHeight(
	fontSize: number,
	lineHeightSetting: number,
): number {
	if (lineHeightSetting > 0) {
		if (lineHeightSetting < fontSize) {
			return Math.ceil(fontSize * lineHeightSetting);
		}
		return Math.ceil(lineHeightSetting);
	}
	return Math.ceil(fontSize * 1.35);
}

export function computePreviewBoxStyle({
	lineCount,
	maxLineLength,
	fontSize,
	lineHeight,
	marginLeftPx = 12,
}: PreviewBoxStyleInput): string {
	const safeLines = Math.max(1, lineCount);
	const safeLineHeight = Math.max(1, lineHeight);
	const charWidth = fontSize * 0.6;
	const width = Math.max(1, Math.ceil(maxLineLength * charWidth));
	const height = safeLines * safeLineHeight;

	return `none; display: inline-block; vertical-align: top; height: ${height}px; width: ${width}px; margin-left: ${marginLeftPx}px`;
}
