# Pi 1.0.0 patch

The patch targets the published `@earendil-works/pi-coding-agent@1.0.0` package.
Its JavaScript and declaration changes must remain in sync. pnpm verifies and
applies it during installation; do not edit installed package files.

| Extension | Reason retained | Regression coverage | Removal condition |
| --- | --- | --- | --- |
| `TransientAssistantStream` | Render child output in the native transcript, commit once after host validation, discard rejected drafts without adding parent model context | `pi-rendering`, `nwh-task`, `nwh-extension` | Upstream exposes an equivalent transactional display API |
| `ThinkingDisplayMode` | Show active thinking, collapse completed blocks, expand with Ctrl+T; migrate legacy settings | `pi-rendering`, `nwh-task` | Upstream supplies equivalent auto mode and legacy settings handling |
| First custom assistant persistence | Persist an opening scene before an ordinary user/assistant message exists | `pi-session` | Upstream recognizes committed custom assistant streams as conversation |
| `resumeCommandFormatter` | Print NWH's root/session/compiler command on exit | `pi-session` | Upstream accepts an embedding-specific resume command |

The rebase preserves 1.0's per-block mouse toggle, incremental thinking visibility
updates (without rebuilding live tool components), and first-user-message persistence.
It does not enable Pi built-in tools, MCP, codemode, or provider features in NWH.
