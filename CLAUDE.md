# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                           # production (direct)
node --watch server/index.js        # dev with auto-reload
sudo systemctl restart agentremote  # restart systemd service (production)
journalctl -u agentremote -f        # live service logs
```

Requires a `.env` file (see `.env.example`). The server exits on startup if `AUTH_TOKEN` is missing.

The production server runs as a systemd service (`agentremote.service`). After code changes, restart it with `sudo systemctl restart agentremote`.

## Architecture

A Node.js (ESM) server that bridges AI CLI sessions (Codex, Claude, Gemini) running in tmux on the VM to a mobile-first PWA and a Telegram bot.

```
public/          Vanilla JS PWA (no framework, no build step)
server/
  index.js       Express + WebSocket server, 2s polling loop
  sessions.js    tmux session lifecycle and output capture
  telegram.js    Telegram bot — commands, connect mode, approvals
  providers.js   Per-provider config: launch command, response parser, patterns
```

### Provider layer (`providers.js`)

Each provider (codex, claude, gemini) defines:
- `launch(task)` — shell command run inside tmux; `task` may be null (session starts empty)
- `extractResponses(output)` — parses TUI output into response text blocks
- `approvalPatterns` — regexes that detect permission prompts
- `noisePatterns` — TUI chrome filtered line-by-line before forwarding to Telegram

Launch commands:
```
codex --no-alt-screen -a untrusted ["<task>"]  # codex
claude --dangerously-skip-permissions ["<task>"] # claude
gemini --skip-trust ["<task>"]                   # gemini (--skip-trust skips workspace trust prompt)
```

Codex responses are `•`-prefixed blocks. Claude responses are `●`-prefixed blocks — tool-call blocks (`● Update(...)`, `● Bash(...)` etc.) are skipped, only prose responses are forwarded. Gemini uses text blocks between `>` prompt lines. All three strip ANSI codes before parsing.

`noisePatterns` are applied line-by-line to extracted responses in the connect-mode poll and on-connect snapshot before anything is sent to Telegram.

### Session layer (`sessions.js`)

Sessions are tmux windows. Each session defaults to `~/agents/<name>` as its working directory (created automatically). Metadata (task, provider, workdir, status, pendingApproval) is in-memory only — resets on server restart, but the tmux session itself survives.

`sendKeys` uses `tmux send-keys -l` (literal flag) to avoid shell interpretation, then fires `Enter` after a 300ms delay to let the TUI register the input.

`checkForApprovalPrompt` uses the provider's own `approvalPatterns` against the last 5 lines of output.

`detectProvider` recovers the provider after a server restart (when `sessionMeta` is wiped). It checks `#{pane_current_command}` first (the actual running process — reliable regardless of session age), then falls back to grepping the last 500 lines of scrollback for the launch command.

Claude sessions automatically receive `/effort normal` 5 seconds after launch to prevent verbose over-thinking.

### Polling loop (`index.js`)

Every 2 seconds:
1. Pushes `captureOutput` to WebSocket clients subscribed to a session.
2. Checks for approval prompts → broadcasts `approval_needed` + sends Telegram inline keyboard.

### Telegram bot (`telegram.js`)

- `/new` with no args → inline provider picker; tapping a provider stores `pendingNew.provider` and the next plain-text message is treated as the session name (no initial task).
- `/new [provider] name` → creates session directly (provider optional, defaults to codex).
- After creation, connect mode starts automatically after a 2s delay so responses stream without manual Connect.
- Connect mode: `connectState` holds one active session. Poll interval calls provider's `extractResponses`, filters with `noisePatterns`, tracks sent responses in a `Set`, edits in place if a response grew (partial → complete).
- `guard(fn)` wraps all handlers — catches errors and sends them to the chat.

### PWA (`public/`)

Three views: login, session list, session detail. Token in `localStorage`. WebSocket auto-reconnects. New-session modal has provider dropdown and optional workdir field (no task field). Session header shows workdir. Session cards show provider icon (⚡/🟣/✨).

### Auth

`/api/*` requires `x-token` header or `?token=` query param. WebSocket requires `?token=` in URL. Telegram rejects any `chat_id` not matching `TELEGRAM_CHAT_ID`.
