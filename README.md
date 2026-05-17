# AgentRemote

Control AI coding agents (Codex, Claude, Gemini) running on a remote VM — from your phone via Telegram or from any browser via a PWA.

## What it does

- **Start sessions** from Telegram or browser with any AI provider
- **Auto-connect** — creating a session immediately starts streaming responses to Telegram
- **Monitor output** in real time (WebSocket streaming in browser, push messages in Telegram)
- **Approve/reject** tool-use prompts from your phone
- **Per-session workdirs** — each session gets its own isolated folder under `~/agents/<name>`

## Setup

### 1. Prerequisites

Install the AI CLIs you want to use:
```bash
npm install -g @openai/codex      # Codex
npm install -g @anthropic-ai/claude-code  # Claude
npm install -g @google/gemini-cli  # Gemini
```

Authenticate each CLI before starting the server:
```bash
claude        # OAuth via claude.ai account (run once, token persists)
gemini        # Select "Sign in with Google" — use a personal Gmail account
# Codex uses OPENAI_API_KEY from .env (no interactive login)
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
AUTH_TOKEN=<random secret — used for browser/API auth>
TELEGRAM_BOT_TOKEN=<from @BotFather>
TELEGRAM_CHAT_ID=<your Telegram user ID — from @userinfobot>
PORT=3000
```

### 3. Run

```bash
npm install
npm start                        # production
node --watch server/index.js     # dev with auto-reload
```

After code changes, restart the server manually — there is no hot-reload in production.

### 4. Access the browser PWA

SSH port-forward from your laptop:
```bash
ssh -L 8888:localhost:3000 user@your-vm
```
Then open `http://localhost:8888` and enter your `AUTH_TOKEN`.

## Telegram commands

| Command | Description |
|---|---|
| `/new` | Start a session — shows provider picker (⚡ Codex / 🟣 Claude / ✨ Gemini) |
| `/new name` | Start a Codex session directly |
| `/new claude name` | Start a Claude session directly |
| `/list` | Browse active sessions — tap to manage |
| `/output name` | Get the last ~35 lines of output |
| `/send name \| text` | Send input to a session |
| `/kill name` | Kill a session (files on disk are untouched) |
| `/disconnect` | Exit connect mode |
| `/help` | Show command reference |

### Session lifecycle

1. `/new` → pick provider → send a name
2. Connect mode starts automatically — responses stream to Telegram as they arrive
3. Type messages directly to send them to the AI
4. `/disconnect` to stop streaming (session keeps running)
5. `/kill` to terminate the tmux session (workdir and files remain)

Sessions default to `~/agents/<name>`. Override via the workdir field in the browser UI.

## Architecture

```
public/          Vanilla JS PWA (no build step)
server/
  index.js       Express + WebSocket server, 2s polling loop
  sessions.js    tmux session lifecycle and output capture
  telegram.js    Telegram bot — commands, connect mode, approvals
  providers.js   Per-provider config: launch commands, parsers, patterns
```

Sessions are **tmux windows** on the VM. The server is stateless beyond in-memory session metadata — tmux sessions survive server restarts but metadata resets.

The 2-second polling loop streams output to subscribed WebSocket clients and detects approval prompts, triggering both a browser banner and a Telegram inline-keyboard notification.

### Adding a new provider

Edit `server/providers.js` and add an entry to `PROVIDERS`:

```js
myprovider: {
  label: 'MyProvider',
  icon: '🔮',
  launch: (task) => task ? `mycli "${task.replace(/"/g, '\\"')}"` : `mycli`,
  extractResponses: (output) => { /* parse TUI output into string[] */ },
  approvalPatterns: [ /confirm\?/i ],
  noisePatterns: [ /spinner/ ],   // filtered line-by-line before sending to Telegram
}
```

Then add it to the dropdown in `public/index.html` and the icon map in `public/app.js`.
