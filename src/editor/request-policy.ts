import type { SweepMode } from "~/core/mode.ts";

export interface InlineRequestPolicy {
	cancelOnNewRequest: boolean;
	respectCancellation: boolean;
}

const HOSTED_INLINE_DEBOUNCE_MS = 300;
const LOCAL_INLINE_DEBOUNCE_MS = 800;
const INLINE_DEBOUNCE_MIN_MS = 100;

export function getInlineRequestPolicy(mode: SweepMode): InlineRequestPolicy {
	if (mode === "local") {
		return {
			cancelOnNewRequest: false,
			respectCancellation: false,
		};
	}

	return {
		cancelOnNewRequest: true,
		respectCancellation: true,
	};
}

export function resolveInlineDebounceMs(
	mode: SweepMode,
	configuredValue?: number,
): number {
	const base =
		typeof configuredValue === "number" && !Number.isNaN(configuredValue)
			? configuredValue
			: mode === "local"
				? LOCAL_INLINE_DEBOUNCE_MS
				: HOSTED_INLINE_DEBOUNCE_MS;
	return Math.max(INLINE_DEBOUNCE_MIN_MS, Math.floor(base));
}
