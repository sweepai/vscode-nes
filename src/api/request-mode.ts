import type { ZodType } from "zod";
import { resolveApiUrl, type SweepMode } from "~/core/mode";

export interface AutocompleteTransport<T> {
	apiUrl: string;
	body: string;
	schema: ZodType<T>;
	compressed: boolean;
	requiresApiKey: boolean;
	mode: SweepMode;
}

export interface AutocompleteTransportInput<T> {
	mode: SweepMode;
	apiUrl: string;
	localUrl: string;
	hosted: {
		body: string;
		schema: ZodType<T>;
		compressed: boolean;
		requiresApiKey: boolean;
	};
	local: {
		body: string;
		schema: ZodType<T>;
	};
}

export function buildAutocompleteTransport<T>({
	mode,
	apiUrl,
	localUrl,
	hosted,
	local,
}: AutocompleteTransportInput<T>): AutocompleteTransport<T> {
	if (mode === "local") {
		return {
			apiUrl: resolveApiUrl(mode, localUrl),
			body: local.body,
			schema: local.schema,
			compressed: false,
			requiresApiKey: false,
			mode,
		};
	}

	return {
		apiUrl,
		body: hosted.body,
		schema: hosted.schema,
		compressed: hosted.compressed,
		requiresApiKey: hosted.requiresApiKey,
		mode,
	};
}
