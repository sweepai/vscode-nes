import { z } from "zod";

export const FileChunkSchema = z.object({
	file_path: z.string(),
	start_line: z.number(),
	end_line: z.number(),
	content: z.string(),
	timestamp: z.number().optional(),
});

export const UserActionSchema = z.object({
	action_type: z.enum([
		"CURSOR_MOVEMENT",
		"INSERT_CHAR",
		"DELETE_CHAR",
		"INSERT_SELECTION",
		"DELETE_SELECTION",
	]),
	line_number: z.number(),
	offset: z.number(),
	file_path: z.string(),
	timestamp: z.number(),
});

export const AutocompleteRequestSchema = z.object({
	debug_info: z.string(),
	repo_name: z.string(),
	branch: z.string().optional(),
	file_path: z.string(),
	file_contents: z.string(),
	original_file_contents: z.string(),
	cursor_position: z.number(),
	recent_changes: z.string(),
	changes_above_cursor: z.boolean(),
	multiple_suggestions: z.boolean(),
	file_chunks: z.array(FileChunkSchema),
	retrieval_chunks: z.array(FileChunkSchema),
	recent_user_actions: z.array(UserActionSchema),
	use_bytes: z.boolean(),
	privacy_mode_enabled: z.boolean(),
});

export const AutocompleteResponseSchema = z.object({
	autocomplete_id: z.string(),
	start_index: z.number(),
	end_index: z.number(),
	completion: z.string(),
	confidence: z.number(),
	elapsed_time_ms: z.number().optional(),
	finish_reason: z.string().nullable().optional(),
});

export const SuggestionTypeSchema = z.enum(["GHOST_TEXT", "POPUP"]);

export const AutocompleteEventTypeSchema = z.enum([
	"autocomplete_suggestion_shown",
	"autocomplete_suggestion_accepted",
]);

export const AutocompleteMetricsRequestSchema = z.object({
	event_type: AutocompleteEventTypeSchema,
	suggestion_type: SuggestionTypeSchema,
	additions: z.number(),
	deletions: z.number(),
	autocomplete_id: z.string(),
	debug_info: z.string(),
	device_id: z.string(),
	privacy_mode_enabled: z.boolean(),
});

export type FileChunk = z.infer<typeof FileChunkSchema>;
export type UserAction = z.infer<typeof UserActionSchema>;
export type AutocompleteRequest = z.infer<typeof AutocompleteRequestSchema>;
export type AutocompleteResponse = z.infer<typeof AutocompleteResponseSchema>;
export type AutocompleteMetricsRequest = z.infer<
	typeof AutocompleteMetricsRequestSchema
>;
export type AutocompleteEventType = z.infer<typeof AutocompleteEventTypeSchema>;
export type SuggestionType = z.infer<typeof SuggestionTypeSchema>;

export type ActionType = UserAction["action_type"];

export interface AutocompleteResult {
	id: string;
	startIndex: number;
	endIndex: number;
	completion: string;
	confidence: number;
}

export interface RecentChange {
	path: string;
	diff: string;
}

export interface RecentBuffer {
	path: string;
	content: string;
	mtime?: number;
}
