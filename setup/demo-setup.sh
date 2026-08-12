#!/usr/bin/env bash
# =============================================================================
# AgentRemote — demo environment setup
# =============================================================================
# Creates a clean, self-contained demo environment for a Linux user.
# Run as root (or with sudo) after creating the user with useradd.
#
# Usage:
#   sudo bash demo-setup.sh <username> <port> [cloudflare-hostname]
#
# Example:
#   sudo bash demo-setup.sh demo 3010 demo.example.com
# =============================================================================

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
DEMO_USER="${1:-demo}"
PORT="${2:-3010}"
CF_HOST="${3:-}"

HOME_DIR="/home/${DEMO_USER}"
AGENTREMOTE_SRC="/home/myuser/codex-mobile"
NPM_BIN="/home/myuser/.npm-global/bin"

# ── Checks ────────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash demo-setup.sh $*" >&2
  exit 1
fi

if ! id "$DEMO_USER" &>/dev/null; then
  echo "User '$DEMO_USER' does not exist. Create it first:" >&2
  echo "  sudo useradd -m -s /bin/bash $DEMO_USER && sudo passwd $DEMO_USER" >&2
  exit 1
fi

if ! grep -q "^  ${PORT}:" /home/myuser/agents/Systemadmin/port_registry.yaml 2>/dev/null; then
  echo "WARNING: port $PORT is not in the port registry." >&2
  echo "Add it to /home/myuser/agents/Systemadmin/port_registry.yaml before continuing." >&2
  read -rp "Continue anyway? [y/N] " yn
  [[ $yn =~ ^[Yy]$ ]] || exit 1
fi

AUTH_TOKEN=$(openssl rand -hex 24)

echo "=== AgentRemote demo setup ==="
echo "  User:    $DEMO_USER"
echo "  Port:    $PORT"
echo "  CF host: ${CF_HOST:-none}"
echo "  Token:   $AUTH_TOKEN  ← save this"
echo ""

# ── Directory structure ───────────────────────────────────────────────────────
run_as() { sudo -u "$DEMO_USER" bash -c "$1"; }

run_as "mkdir -p ${HOME_DIR}/agents/Systemadmin"
run_as "mkdir -p ${HOME_DIR}/agents/ContentAgent"
run_as "mkdir -p ${HOME_DIR}/.secrets"
chmod 700 "${HOME_DIR}/.secrets"
chown "${DEMO_USER}:${DEMO_USER}" "${HOME_DIR}/.secrets"

# ── PATH: expose npm-global binaries (claude, codex, gemini) ─────────────────
BASHRC="${HOME_DIR}/.bashrc"
if ! grep -q "npm-global" "$BASHRC" 2>/dev/null; then
  cat >> "$BASHRC" <<EOF

# AgentRemote — AI CLI binaries installed under main user
export PATH="${NPM_BIN}:\$PATH"
EOF
  chown "${DEMO_USER}:${DEMO_USER}" "$BASHRC"
fi

# ── Clone / copy AgentRemote ──────────────────────────────────────────────────
DEST="${HOME_DIR}/agentremote"
if [[ -d "$DEST" ]]; then
  echo "  agentremote already exists at $DEST — skipping clone"
else
  cp -r "$AGENTREMOTE_SRC" "$DEST"
  # Remove any existing .env and DooerBot data
  rm -f "${DEST}/.env"
  rm -rf "${DEST}/DooerBot"
  chown -R "${DEMO_USER}:${DEMO_USER}" "$DEST"
fi

# ── AgentRemote .env ──────────────────────────────────────────────────────────
cat > "${DEST}/.env" <<EOF
PORT=${PORT}
AUTH_TOKEN=${AUTH_TOKEN}
EOF
chown "${DEMO_USER}:${DEMO_USER}" "${DEST}/.env"
chmod 600 "${DEST}/.env"

# ── CLAUDE.md ─────────────────────────────────────────────────────────────────
cat > "${HOME_DIR}/CLAUDE.md" <<'EOF'
# System Rules

This machine runs an AI-assisted digital marketing operation.

**Before doing anything else, read these three files:**
1. `~/agents/Systemadmin/knowledge_base.md` — available tools, agents, and accounts
2. `~/agents/Systemadmin/system_state.md` — port table and service health
3. `~/agents/Systemadmin/credentials.yaml` — credential index (what exists and where)

## Port Registry — mandatory rule

**Before assigning any port to new code or services:**
1. Read `~/agents/Systemadmin/port_registry.yaml`
2. If the port is listed there, it is reserved — even if nothing is currently listening on it
3. Add your new port to the registry before starting the service

## Credentials

All credentials are indexed in `~/agents/Systemadmin/credentials.yaml`.
Actual secrets live in `~/.secrets/` (chmod 700) or service `.env` files.
Never hardcode credentials in scripts or code.

## Knowledge base maintenance rule

When any session installs software, adds or removes a script, creates an agent,
changes an external account, or makes any other change that affects what is
described in `knowledge_base.md` — propose a specific update to that file at
the end of the task. Only edit the file if the user explicitly approves.
EOF
chown "${DEMO_USER}:${DEMO_USER}" "${HOME_DIR}/CLAUDE.md"

# ── knowledge_base.md ─────────────────────────────────────────────────────────
cat > "${HOME_DIR}/agents/Systemadmin/knowledge_base.md" <<'EOF'
# System Knowledge Base
_Hand-maintained. Update when adding software, accounts, or scripts._
_For live system state (ports, services): read `system_state.md`._

---

## AI CLIs

| Tool | Command | Auth | Notes |
|------|---------|------|-------|
| Claude | `claude` | `~/.claude/` | Run `claude login` to authenticate |
| Codex | `codex` | `~/.codex/` | Run `codex login` to authenticate |
| Gemini | `gemini` | `~/.gemini/` | Run `gemini login` to authenticate |

AgentRemote is running at `~/agentremote/` — managed by `agentremote.service`.

---

## Agents

| Agent | Path | Purpose |
|-------|------|---------|
| **ContentAgent** | `~/agents/ContentAgent/` | Draft blog posts, social copy, email sequences |

---

## Email

Outgoing email via local Postfix relay (port 25):

```python
import smtplib
from email.message import EmailMessage
msg = EmailMessage()
msg["From"] = "notifications@example.com"
msg["To"] = "recipient@example.com"
msg["Subject"] = "Hello"
msg.set_content("Body text")
with smtplib.SMTP("localhost", 25) as s:
    s.send_message(msg)
```

---

## Available software

| Tool | Notes |
|------|-------|
| Python 3 | `/usr/bin/python3` |
| Node.js | `/usr/bin/node` |
| npm / npx | `/usr/bin/npm` |
| git | `/usr/bin/git` |
| curl / wget | Standard HTTP clients |
| Playwright | `playwright` — browser automation (Chromium included) |
| tmux | Session management (used by AgentRemote) |
| fastapi + uvicorn | Async HTTP APIs |
| flask | Sync HTTP APIs |
| httpx | Async HTTP client |
| pydantic | Data validation / structured output |
| python-dotenv | Load .env files |

---

## External accounts

| Service | Account | Purpose |
|---------|---------|---------|
| Anthropic | (Claude login) | Claude API / Claude Code |
| GitHub | (git config) | Code repositories |

EOF
chown "${DEMO_USER}:${DEMO_USER}" "${HOME_DIR}/agents/Systemadmin/knowledge_base.md"

# ── credentials.yaml ──────────────────────────────────────────────────────────
cat > "${HOME_DIR}/agents/Systemadmin/credentials.yaml" <<EOF
# ============================================================
# CREDENTIALS REGISTRY — index only, no secret values
# ============================================================

credentials:

  agentremote-auth:
    description: Auth token for AgentRemote (this instance)
    keys: [AUTH_TOKEN]
    stored_in:
      - ~/agentremote/.env
    used_by: [agentremote]
    notes: "Token is set during setup. Rotate by editing .env and restarting service."

  claude-auth:
    description: Claude CLI authentication
    keys: [oauth_token]
    stored_in:
      - ~/.claude/
    used_by: [claude]
    notes: "Managed by Claude CLI. Rotate via 'claude login'."

  codex-auth:
    description: Codex CLI authentication
    keys: [api_key]
    stored_in:
      - ~/.codex/
    used_by: [codex]
    notes: "Managed by Codex CLI. Rotate via 'codex login'."

  gemini-auth:
    description: Gemini CLI authentication
    keys: [oauth_creds]
    stored_in:
      - ~/.gemini/
    used_by: [gemini]
    notes: "Managed by Gemini CLI. Rotate via 'gemini login'."
EOF
chown "${DEMO_USER}:${DEMO_USER}" "${HOME_DIR}/agents/Systemadmin/credentials.yaml"

# ── port_registry.yaml ────────────────────────────────────────────────────────
cat > "${HOME_DIR}/agents/Systemadmin/port_registry.yaml" <<EOF
# ============================================================
# PORT REGISTRY — authoritative source of truth
# ============================================================

ports:
  ${PORT}:
    service: agentremote
    description: AgentRemote AI agent bridge
    owner: ${DEMO_USER}
    protocol: tcp
    bind: "*"
    public: true
    cloudflare_hostname: ${CF_HOST:-null}
    config_file: ~/agentremote/server/index.js
    hard_coded: false
    status: active
    registered: "$(date +%Y-%m-%d)"
    notes: "Demo instance. Managed by agentremote-${DEMO_USER}.service"
EOF
chown "${DEMO_USER}:${DEMO_USER}" "${HOME_DIR}/agents/Systemadmin/port_registry.yaml"

# ── system_state.md ───────────────────────────────────────────────────────────
cat > "${HOME_DIR}/agents/Systemadmin/system_state.md" <<EOF
# System State
_Generated: $(date '+%Y-%m-%d %H:%M:%S')_

## Port Registry

| Port | Service | Status | Public | Notes |
|------|---------|--------|--------|-------|
| **${PORT}** | agentremote | 🟢 active | ✓ | Demo AgentRemote instance |

## Services

| Service | Status |
|---------|--------|
| agentremote-${DEMO_USER} | 🟢 running |

_Run \`sudo systemctl status agentremote-${DEMO_USER}\` to check live status._
EOF
chown "${DEMO_USER}:${DEMO_USER}" "${HOME_DIR}/agents/Systemadmin/system_state.md"

# ── Python packages ───────────────────────────────────────────────────────────
echo "  Installing Python packages for agent sessions..."
run_as "pip3 install --user --quiet fastapi uvicorn flask httpx pydantic python-dotenv"

echo "  Installing Playwright (133 MB — browser automation)..."
run_as "pip3 install --user --quiet playwright"
# Install Chromium browser binaries — this downloads ~300 MB
run_as "python3 -m playwright install chromium"

echo "  Python packages installed."

# ── systemd service ───────────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/agentremote-${DEMO_USER}.service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=AgentRemote (${DEMO_USER} demo instance)
After=network.target

[Service]
Type=simple
User=${DEMO_USER}
WorkingDirectory=${DEST}
EnvironmentFile=${DEST}/.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "agentremote-${DEMO_USER}"
systemctl start "agentremote-${DEMO_USER}"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Done ==="
echo ""
echo "  AgentRemote running on port $PORT"
echo "  Auth token: $AUTH_TOKEN"
if [[ -n "$CF_HOST" ]]; then
  echo "  URL: https://$CF_HOST"
else
  echo "  URL: http://localhost:$PORT  (add Cloudflare tunnel to expose publicly)"
fi
echo ""
echo "Next steps:"
echo "  1. Log in as $DEMO_USER and run: claude login"
echo "  2. Add port $PORT to the main port registry:"
echo "     /home/myuser/agents/Systemadmin/port_registry.yaml"
if [[ -z "$CF_HOST" ]]; then
  echo "  3. Add a Cloudflare tunnel route pointing to localhost:$PORT"
fi
