## Sweep Next Edit Suggestion for VSCode

### Display Modes

The extension supports two display modes depending on where the suggested edit is relative to your cursor:

1. **Ghost Text (Standard)**: When the suggested edit is at or after the cursor position, it displays as standard ghost text that you can accept with Tab.

2. **Inline Edit (NES-style)**: When the suggested edit involves replacing text before or around the cursor (e.g., fixing a typo earlier in the line), it uses the NES-style rendering with a gutter arrow indicator.

### Requirements for NES-style Rendering

The NES-style inline edits use VSCode's proposed `inlineCompletionsAdditions` API. For these features to work properly, you need one of the following:

1. **Run in Extension Development Mode**: Launch the extension via F5 in VSCode
2. **Use VSCode Insiders**: The proposed APIs are more readily available
3. **Use the --enable-proposed-api flag**: `code --enable-proposed-api sweep.vscode-nes`

Without these, the extension will still attempt to show completions, but NES-style edits (those replacing text before the cursor) may not render properly.