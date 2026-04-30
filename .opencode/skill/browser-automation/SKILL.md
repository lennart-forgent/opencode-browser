---
name: browser-automation
description: Reliable, composable browser automation using minimal OpenCode Browser primitives.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  domain: browser
---

## What I do

- Provide a safe, composable workflow for browsing tasks
- Click strictly using x, y coordinates
- Use `browser_screenshot` to inspect the visual state of the page reliably
- Confirm state changes after each action
- Support CLI-first debugging with `opencode-browser tool` commands

## Best-practice workflow

1. Inspect tabs with `browser_get_tabs`
2. Open new tabs with `browser_open_tab` when needed
3. Navigate with `browser_navigate` if needed
4. Wait for UI load using `browser_wait`
5. Inspect the current page state using `browser_screenshot`
6. Click, type, or select based on visual analysis
7. Confirm changes using `browser_screenshot`

## CLI-first debugging

- List all available tools: `npx @different-ai/opencode-browser tools`
- Run one tool directly: `npx @different-ai/opencode-browser tool browser_status`
- Pass JSON args: `npx @different-ai/opencode-browser tool browser_screenshot`
- Run smoke test: `npx @different-ai/opencode-browser self-test`
- After `update`, reload the unpacked extension in `chrome://extensions`

This path is useful for reproducing selector/scroll issues quickly before running a full OpenCode session.

## Inspecting Page Content

- Use `browser_screenshot` to analyze exactly what the user sees
- Use x, y coordinates extracted from the screenshot to interact with the DOM using `browser_click`

## Opening tabs

- Use `browser_open_tab` to create a new tab, optionally with `url` and `active`
- Example: `browser_open_tab({ url: "https://example.com", active: false })`

## Troubleshooting

- If a click fails or misbehaves, take another `browser_screenshot` to confirm the element is actually present exactly where you thought it was
- For scrollable containers, pass both `selector` and `x`/`y` to `browser_scroll`
- Confirm results after each action using `browser_screenshot`