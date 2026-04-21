# opencode-plugin-codex-usage

OpenCode TUI plugin that shows live Codex usage limits in the right sidebar.

It reads Codex quota data from `codex app-server` using the same `account/rateLimits/read` RPC that Codex uses for rich clients, then renders the returned buckets inside OpenCode's `sidebar_content` slot.

<p>
  <img src="docs/dark.png" alt="Example output (dark)" width="420" />
  <img src="docs/light.png" alt="Example output (light)" width="420" />
</p>

## What it shows

- The main Codex usage bucket.
- Extra model-specific buckets when Codex exposes them, for example `GPT-5.3-Codex-Spark`.
- The current remaining percentage and reset time for each available window.

## Requirements

- OpenCode TUI.
- The `codex` CLI installed and available on your `PATH`, unless you set `codexBinary` to a custom path.
- A working Codex login so `codex app-server` can read your rate limits.

## When it appears

- The plugin adds a `Codex Usage` section to the right sidebar.
- It is most useful during Codex or OpenAI-backed sessions, where it starts expanded automatically.
- In other sessions it stays available in the sidebar, but starts collapsed.

## Installation

Install it like any other OpenCode plugin:

```bash
opencode plugin opencode-plugin-codex-usage
```

If you want to configure it in your workspace-local TUI config, add this to `.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["opencode-plugin-codex-usage", { "refreshMs": 30000 }]]
}
```

Restart OpenCode after updating the config.

Open a Codex-backed session and look for `Codex Usage` in the right sidebar.

## Manual Installation

Use this only if you want to run a local checkout of the plugin, for example while testing unreleased changes.

Install dependencies in this repository:

```bash
cd opencode-plugin-codex-usage
bun install
```

Then point `.opencode/tui.json` at the local source:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["file:///absolute/path/to/opencode-plugin-codex-usage", { "refreshMs": 30000 }]]
}
```

Restart OpenCode after updating the config.

## Configuration

The plugin accepts these options in `tui.json`.

If you installed the published plugin, configure it like this:

```json
{
  "plugin": [["opencode-plugin-codex-usage", {
    "refreshMs": 30000,
    "codexBinary": "codex"
  }]]
}
```

If you are using a local checkout, use the same options with your `file:///absolute/path/...` plugin entry:

```json
{
  "plugin": [["file:///absolute/path/to/opencode-plugin-codex-usage", {
    "refreshMs": 30000,
    "codexBinary": "codex"
  }]]
}
```

Options:

- `refreshMs`
  Poll interval in milliseconds.
  Default: `30000`
  Minimum enforced value: `15000`

- `codexBinary`
  Command or absolute path used to launch Codex.
  Default: `codex`

If `codex` is not on your `PATH`, set `codexBinary` to the full path of the executable.

## Troubleshooting

- `codex CLI not found`
  Install the Codex CLI, or set `codexBinary` to its absolute path.

- `No Codex usage data available`
  Make sure Codex is logged in and able to return rate-limit data from `codex app-server`.

- The plugin appears, but stays collapsed
  That is expected in non-Codex sessions. Open a Codex or OpenAI-backed session to see it expand automatically.

- The sidebar does not update immediately
  The default refresh interval is `30000ms`. The plugin also refreshes when the session becomes idle.

## Local Verification

For a local checkout, run the import smoke test:

```bash
cd opencode-plugin-codex-usage
bun run check
```

That verifies the plugin module can be imported with OpenTUI runtime support.

## Performance Notes

- CPU: low. The plugin is idle most of the time and does a short refresh on an interval and when a session becomes idle.
- Memory: low. It keeps only a small in-memory snapshot of the latest limit data.
- Token/context usage: none. It does not call the model or inject extra prompt/context into OpenCode sessions.

The only real overhead is that each refresh launches a short-lived `codex app-server` process to read the current rate limits. At the default `30000ms` this should be light, but if you want even less churn you can increase `refreshMs` to `60000` or `120000`.
