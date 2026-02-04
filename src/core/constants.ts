// Sweep model tokens
export const SWEEP_FILE_SEP_TOKEN = "<|file_sep|>";
export const STOP_TOKENS = ["<|file_sep|>", "</s>"];

// Default configuration
export const DEFAULT_API_ENDPOINT =
	"https://autocomplete.sweep.dev/backend/next_edit_autocomplete";
export const DEFAULT_METRICS_ENDPOINT =
	"https://backend.app.sweep.dev/backend/track_autocomplete_metrics";
export const DEFAULT_MAX_CONTEXT_FILES = 5;

// Model parameters
export const MODEL_NAME = "sweepai/sweep-next-edit";
export const MAX_TOKENS = 2048;
export const TEMPERATURE = 0.0;
