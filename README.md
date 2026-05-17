# AgentRemote

Control AI coding agents (Codex, Claude, Gemini) running on a remote VM — from your phone via Telegram or from any browser via a PWA.

## What it does

- **Start sessions** from Telegram or browser with any AI provider
- **Monitor output** in real time (WebSocket streaming in browser, push messages in Telegram)
- **Approve/reject** tool-use prompts from your phone
- **Connect mode** in Telegram — bidirectional passthrough to any session, with responses delivered as individual messages

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
claude        # then /login inside the TUI — OAuth via claude.ai account
gemini        # then select "Sign in with Google" — uses personal Gmail
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
| `/new name \| task` | Start a Codex session directly |
| `/new claude name \| task` | Start a Claude session directly |
| `/list` | Browse active sessions — tap to manage |
| `/output name` | Get the last ~35 lines of output |
| `/send name \| text` | Send input to a session |
| `/kill name` | Kill a session |
| `/disconnect` | Exit connect mode |
| `/help` | Show command reference |

## Architecture

```
public/          Vanilla JS PWA (no build step)
server/
  index.js       Express + WebSocket server, 2s polling loop
  sessions.js    tmux session lifecycle and output capture
  telegram.js    Telegram bot — commands, connect mode, approvals
  providers.js   Per-provider config: launch commands, parsers, patterns
```

Sessions are **tmux windows** on the VM. The server is stateless beyond in-memory session metadata — tmux sessions survive server restarts.

The 2-second polling loop streams output to subscribed WebSocket clients and detects approval prompts, triggering both a browser banner and a Telegram inline-keyboard notification.

### Adding a new provider

Edit `server/providers.js` and add an entry to `PROVIDERS`:

```js
myprovider: {
  label: 'MyProvider',
  icon: '🔮',
  launch: (task) => `mycli "${task.replace(/"/g, '\\"')}"`,
  extractResponses: (output) => { /* parse TUI output into string[] */ },
  approvalPatterns: [ /confirm\?/i ],
  noisePatterns: [ /spinner/ ],
}
```

Then add it to the dropdown in `public/index.html` and the icon map in `public/app.js`.
