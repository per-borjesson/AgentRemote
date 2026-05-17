# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                      # production
node --watch server/index.js   # dev with auto-reload
```

Requires a `.env` file (see `.env.example`). The server exits on startup if `AUTH_TOKEN` is missing.

After code changes, the running server must be restarted manually — there is no hot-reload in production.

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
- `launch(task)` — shell command run inside tmux
- `extractResponses(output)` — parses TUI output into response text blocks
- `approvalPatterns` — regexes that detect permission prompts
- `noisePatterns` — TUI chrome to strip before forwarding to Telegram

Launch commands:
```
codex --no-alt-screen -a untrusted "<task>"    # codex
claude --dangerously-skip-permissions "<task>" # claude
gemini --skip-trust "<task>"                   # gemini (--skip-trust skips workspace trust prompt)
```

Codex responses are `•`-prefixed blocks. Claude/Gemini responses are text blocks between `❯`/`>` prompt lines. All three strip ANSI codes before parsing.

### Session layer (`sessions.js`)

Sessions are tmux windows. Metadata (task, provider, status, pendingApproval) is in-memory only — resets on server restart, but the tmux session itself survives.

`sendKeys` uses `tmux send-keys -l` (literal flag) to avoid shell interpretation, then fires `Enter` after a 300ms delay to let the TUI register the input.

`checkForApprovalPrompt` uses the provider's own `approvalPatterns` against the last 5 lines of output.

### Polling loop (`index.js`)

Every 2 seconds:
1. Pushes `captureOutput` to WebSocket clients subscribed to a session.
2. Checks for approval prompts → broadcasts `approval_needed` + sends Telegram inline keyboard.

### Telegram bot (`telegram.js`)

- `/new` with no args → inline provider picker; tapping a provider stores `pendingNew.provider` and the next plain-text message is treated as `name | task`.
- `/new [provider] name | task` → creates session directly (provider optional, defaults to codex).
- Connect mode: `connectState` holds one active session. Poll interval calls provider's `extractResponses`, tracks sent responses in a `Set`, edits in place if a response grew (partial → complete).
- `guard(fn)` wraps all handlers — catches errors and sends them to the chat.

### PWA (`public/`)

Three views: login, session list, session detail. Token in `localStorage`. WebSocket auto-reconnects. New-session modal includes a provider dropdown. Session cards show provider icon (⚡/🟣/✨).

### Auth

`/api/*` requires `x-token` header or `?token=` query param. WebSocket requires `?token=` in URL. Telegram rejects any `chat_id` not matching `TELEGRAM_CHAT_ID`.
