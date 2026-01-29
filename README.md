## Sweep Next Edit Suggestion for VSCode

### Display Modes

The extension supports two display modes depending on where the suggested edit is relative to your cursor:

1. **Ghost Text (Standard)**: When the suggested edit is at or after the cursor position, it displays as standard ghost text that you can accept with Tab. This comes with "annotations" to note when it can make jump edits to implement an equivalent to the restricted NES API's

2. **Inline Edit (NES-style)**: When the suggested edit involves replacing text before or around the cursor (e.g., fixing a typo earlier in the line), it uses the NES-style rendering with a gutter arrow indicator.

### Requirements for NES-style Rendering

The NES-style inline edits use VSCode's proposed `inlineCompletionsAdditions` API (the same one copilot leverages). For these features to work properly, you need one of the following:

1. **To Run in Extension Development Mode**: Clone the repo & then launch the extension via the build task
2. **Use VSCode Insiders**: Setting proposed flags via `.vscode-insiders/argv.json`
3. **Set the --enable-proposed-api flag**: `code --enable-proposed-api SweepAI.vscode-nes`

Without these, the extension will still show completions but with a degraded UX
