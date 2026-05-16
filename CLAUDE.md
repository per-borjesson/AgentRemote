# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # production
node --watch server/index.js   # dev with auto-reload
```

Requires a `.env` file (see `.env.example`). The server will exit on startup if `AUTH_TOKEN` is missing.

## Architecture

A Node.js (ESM) server that bridges **OpenAI Codex CLI** sessions — running in tmux on the VM — to a mobile-first PWA and a Telegram bot.

```
public/          Vanilla JS PWA (no framework)
server/
  index.js       Express + WebSocket server, 2s polling loop
  sessions.js    tmux session lifecycle and output capture
  telegram.js    Telegram bot — commands, connect mode, approvals
```

### Session layer (`sessions.js`)

Sessions are tmux windows. Codex is launched as:
```
codex --no-alt-screen -a untrusted "<task>"
```
`--no-alt-screen` keeps output in the tmux scrollback buffer instead of the alternate screen. Session metadata (task, status, pendingApproval) is in-memory only — it resets on server restart, but the tmux session survives.

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
