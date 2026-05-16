# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # production
node --watch server/index.js   # dev with auto-reload
```

Requires a `.env` file (see `.env.example`). The server will exit on startup if `AUTH_TOKEN` is missing.

## Architecture

A Node.js (ESM) server that bridges AI CLI sessions (Codex, Claude, Gemini) — running in tmux on the VM — to a mobile-first PWA and a Telegram bot.

```
public/          Vanilla JS PWA (no framework)
server/
  index.js       Express + WebSocket server, 2s polling loop
  sessions.js    tmux session lifecycle and output capture
  telegram.js    Telegram bot — commands, connect mode, approvals
  providers.js   Per-provider config: launch command, response parser, patterns
```

### Provider layer (`providers.js`)

Each provider (codex, claude, gemini) defines:
- `launch(task)` — the shell command to run in tmux
- `extractResponses(output)` — parses provider-specific TUI output into response blocks
- `approvalPatterns` — regexes that detect permission prompts
- `noisePatterns` — TUI chrome to filter before forwarding to Telegram

Codex uses `•`-prefixed response blocks. Claude and Gemini use text blocks delimited by prompt lines (`❯`/`>`). Patterns can be tuned in `providers.js` once a CLI is installed.

### Session layer (`sessions.js`)

Sessions are tmux windows. The launch command comes from the provider:
```
codex --no-alt-screen -a untrusted "<task>"   # codex
claude --dangerously-skip-permissions "<task>" # claude
gemini "<task>"                                # gemini
```
Session metadata (task, provider, status, pendingApproval) is in-memory only — it resets on server restart, but the tmux session survives.

`sendKeys` sends literal text via `tmux send-keys -l`, then fires `Enter` with a 300ms delay to let the Codex TUI register the input before submitting.

### Polling loop (`index.js`)

A 2-second `setInterval` in `index.js` does two things:
1. Pushes `captureOutput` to any WebSocket clients subscribed to a session (`subscribe_output` message).
2. Detects Codex approval prompts via `checkForApprovalPrompt` and triggers both a WebSocket broadcast and a Telegram notification.

### Telegram connect mode (`telegram.js`)

`connectState` holds a single active connection (one session at a time). When connected:
- Any non-command Telegram message is forwarded to the session via `sendKeys`.
- A 2-second interval calls `extractResponses()` on the full tmux output and compares against `sentResponses` (a `Set` of already-forwarded response texts).
- If a response grew across poll cycles (partial → complete), the Telegram message is **edited in place** rather than sending a duplicate.

`extractResponses` parses `•`-prefixed Codex response blocks, collecting continuation lines until the next `•`, a `›` prompt, or a `────` separator. The `NOISE_PATTERNS` array filters TUI chrome (model status, spinners, ghost suggestions, box-drawing characters) before anything is sent to Telegram.

### PWA (`public/`)

Single-page app with three views: login, session list, session detail. Auth token is stored in `localStorage`. WebSocket reconnects automatically on close. The session detail view subscribes to output via `{ type: "subscribe_output", session: name }`.

### Auth

All `/api/*` routes require `x-token` header or `?token=` query param matching `AUTH_TOKEN`. WebSocket connections require `?token=` in the URL. Telegram handlers reject any `chat_id` that doesn't match `TELEGRAM_CHAT_ID`.
