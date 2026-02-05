export interface TrackedOffsets {
	startOffset: number;
	endOffset: number;
}

export interface OffsetChange {
	rangeOffset: number;
	rangeLength: number;
	text: string;
}

export function applyContentChangeToTrackedOffsets(
	offsets: TrackedOffsets,
	change: OffsetChange,
): TrackedOffsets {
	const startOffset = Math.max(0, offsets.startOffset);
	const endOffset = Math.max(startOffset, offsets.endOffset);
	const changeStart = Math.max(0, change.rangeOffset);
	const changeEnd = Math.max(
		changeStart,
		change.rangeOffset + change.rangeLength,
	);
	const insertedLength = change.text.length;
	const delta = insertedLength - (changeEnd - changeStart);

	const nextStart = transformStartOffset(
		startOffset,
		changeStart,
		changeEnd,
		delta,
	);
	const nextEnd = transformEndOffset(
		endOffset,
		changeStart,
		changeEnd,
		insertedLength,
		delta,
	);
	return {
		startOffset: nextStart,
		endOffset: Math.max(nextStart, nextEnd),
	};
}

function transformStartOffset(
	offset: number,
	changeStart: number,
	changeEnd: number,
	delta: number,
): number {
	if (offset < changeStart) return offset;
	if (
		offset > changeEnd ||
		(offset === changeEnd && changeStart === changeEnd)
	) {
		return offset + delta;
	}
	return changeStart;
}

function transformEndOffset(
	offset: number,
	changeStart: number,
	changeEnd: number,
	insertedLength: number,
	delta: number,
): number {
	if (offset < changeStart) return offset;
	if (offset >= changeEnd) return offset + delta;
	return changeStart + insertedLength;
}
