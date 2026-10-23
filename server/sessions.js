import { execSync, execFileSync, exec } from 'child_process';
import { promisify } from 'util';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getProvider, DEFAULT_PROVIDER } from './providers.js';
import { untrackSession } from './archived.js';

const execAsync = promisify(exec);

// In-memory session metadata (survives reconnects since tmux survives)
const sessionMeta = new Map();

function tmux(...args) {
  return execSync(`tmux ${args.join(' ')}`, { encoding: 'utf8' }).trim();
}

async function tmuxAsync(...args) {
  const { stdout } = await execAsync(`tmux ${args.join(' ')}`);
  return stdout.trim();
}

// Infer provider from the tmux pane's current process, then scrollback, when metadata is missing after restart
function detectProvider(name) {
  try {
    const cmd = execSync(`tmux display-message -p -t ${name} '#{pane_current_command}'`, { encoding: 'utf8' }).trim().toLowerCase();
    if (cmd.includes('claude')) return 'claude';
    if (cmd.includes('gemini')) return 'gemini';
    if (cmd.includes('codex')) return 'codex';
  } catch {}
  try {
    const out = execSync(`tmux capture-pane -t ${name} -p -S -500`, { encoding: 'utf8' });
    if (/claude --dangerously/m.test(out)) return 'claude';
    if (/gemini --skip-trust/m.test(out)) return 'gemini';
    if (/codex --no-alt-screen/m.test(out)) return 'codex';
  } catch {}
  return DEFAULT_PROVIDER;
}

export function listSessions() {
  let raw;
  try {
    raw = tmux('list-sessions', '-F', '"#{session_name}|#{session_created}|#{session_activity}"');
  } catch {
    return [];
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, created, activity] = line.replace(/"/g, '').split('|');
      const meta = sessionMeta.get(name) || {};
      // If metadata was lost on restart, detect provider and cache it so we
      // don't re-run the expensive display-message + capture-pane every cycle.
      if (!meta.provider) {
        meta.provider = detectProvider(name);
        sessionMeta.set(name, meta);
      }
      const provider = meta.provider;
      return {
        name,
        created: parseInt(created) * 1000,
        activity: parseInt(activity) * 1000,
        task: meta.task || null,
        status: meta.status || 'running',
        provider,
        workdir: meta.workdir || null,
        pendingApproval: meta.pendingApproval || null,
        resumeId: meta.resumeId || null,
        tokens: meta.tokens || null,
        memory: meta.memory || null,
      };
    });
}

export async function updateProcessMemory(name) {
  try {
    const shellPid = await tmuxAsync('display-message', '-p', '-t', name, '-F', '"#{pane_pid}"');
    let pid = shellPid;
    try {
      const { stdout: pgrepOut } = await execAsync(`pgrep -P ${shellPid}`);
      const child = pgrepOut.trim().split('\n')[0];
      if (child) pid = child;
    } catch {}
    const { stdout: psOut } = await execAsync(`ps -o rss= -p ${pid}`);
    const rssKb = parseInt(psOut.trim(), 10);
    if (!isNaN(rssKb)) {
      const meta = sessionMeta.get(name) || {};
      meta.memory = Math.round(rssKb / 1024);
      sessionMeta.set(name, meta);
    }
  } catch {}
}

export function updateTokensFromOutput(name, output) {
  const clean = output.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
  const meta = sessionMeta.get(name) || {};
  // "727.5k tokens" or "new task? /clear to save 727.5k tokens"
  const tokM = clean.match(/(\d+\.?\d*k?) tokens/);
  if (tokM) { meta.tokens = tokM[1]; sessionMeta.set(name, meta); return; }
  // "~71k uncached · /clear to start fresh"
  const uncM = clean.match(/~(\d+\.?\d*k?) uncached/);
  if (uncM) { meta.tokens = uncM[1]; sessionMeta.set(name, meta); return; }
  // "2% until auto-compact" — no absolute count, store percent as fallback
  const pctM = clean.match(/(\d+)% until auto-compact/);
  if (pctM) { meta.tokens = `${pctM[1]}%ctx`; sessionMeta.set(name, meta); }
}

export function checkForResume(name, output = null) {
  const meta = sessionMeta.get(name) || {};
  if (meta.resumeId) return meta.resumeId;
  const provider = getProvider(meta.provider || detectProvider(name));
  if (!provider.resumePattern) return null;
  // Only resumable when the AI is not currently running — prevents false
  // positives from old resume messages sitting in the scrollback buffer.
  try {
    const cmd = execSync(
      `tmux display-message -p -t ${name} '#{pane_current_command}'`,
      { encoding: 'utf8' }
    ).trim().toLowerCase();
    if (cmd.includes('claude') || cmd.includes('codex') || cmd.includes('gemini')) return null;
  } catch { return null; }
  const out = (output ?? captureOutput(name, 50)).replace(/\x1b\[[0-9;]*m/g, '');
  const m = out.match(provider.resumePattern);
  if (!m) return null;
  meta.resumeId = m[1];
  meta.status = 'done';
  sessionMeta.set(name, meta);
  return m[1];
}

export function resumeSession(name) {
  const meta = sessionMeta.get(name) || {};
  const { resumeId, provider } = meta;
  if (!resumeId) return false;
  const cmd = provider === 'claude'
    ? `claude --resume ${resumeId} --dangerously-skip-permissions`
    : `claude --resume ${resumeId}`;
  meta.resumeId = null;
  meta.status = 'running';
  sessionMeta.set(name, meta);
  sendKeys(name, cmd, true);
  return true;
}

export function getSession(name) {
  return listSessions().find(s => s.name === name) || null;
}

// Poll for a resume ID after sending /exit — resolves once Claude exits and
// prints the ID, or returns null after timeoutMs if it never appears.
export async function waitForResumeId(name, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const id = checkForResume(name);
    if (id) return id;
  }
  return null;
}

export function createSession(name, task = null, provider = DEFAULT_PROVIDER, workdir = null, resumeId = null) {
  // Default: ~/agents/<name> — each session gets its own isolated folder
  const dir = workdir || `${process.env.HOME}/agents/${name}`;
  execSync(`mkdir -p ${JSON.stringify(dir)}`);
  try {
    tmux('new-session', '-d', '-s', name, '-c', dir, '-x', '220', '-y', '200');
  } catch (e) {
    if (!e.message.includes('duplicate session')) throw e;
  }
  sessionMeta.set(name, { task, provider, workdir: dir, status: 'running', pendingApproval: null });
  // Clear host-managed auth vars that would prevent standalone Claude from
  // using ~/.claude/.credentials.json (injected when tmux is started from a
  // Claude Desktop context and inherited by every new pane).
  sendKeys(name, 'unset ANTHROPIC_API_KEY CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', true);
  const cmd = resumeId
    ? `claude --resume ${resumeId} --dangerously-skip-permissions`
    : getProvider(provider).launch(task);
  // 800ms: enough for the unset Enter (~300ms) to land and the shell to process it
  setTimeout(() => sendKeys(name, cmd, true), 800);
  // /effort auto only for fresh sessions — resumed sessions keep their prior setting
  if (provider === 'claude' && !resumeId) {
    setTimeout(() => sendKeys(name, '/effort auto', true), 15000);
  }
  // Codex may show an update prompt on startup; auto-skip it — running the update
  // causes Codex to exit immediately, breaking the session.
  // Codex also shows a directory trust prompt on startup; auto-accept it — the
  // session directory is always freshly created by the server.
  if (provider === 'codex') {
    let checks = 0;
    const handle = setInterval(() => {
      try {
        const out = captureOutput(name, 15);
        if (/Update available/i.test(out) && /Press enter to continue/i.test(out)) {
          // Cursor starts on "Update now" (option 1); Down twice reaches "Skip until next version"
          execSync(`tmux send-keys -t ${name} Down`, { encoding: 'utf8' });
          execSync(`tmux send-keys -t ${name} Down`, { encoding: 'utf8' });
          setTimeout(() => execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf8' }), 100);
          clearInterval(handle);
          return;
        }
        if (/Do you trust the contents of this directory/i.test(out)) {
          // Cursor starts on "No, exit" (option 1); Down moves to "Yes, I trust this folder"
          execSync(`tmux send-keys -t ${name} Down`, { encoding: 'utf8' });
          setTimeout(() => execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf8' }), 100);
          clearInterval(handle);
          return;
        }
      } catch {}
      if (++checks >= 10) clearInterval(handle);
    }, 2000);
  }
  // Claude shows a folder-trust prompt for untrusted dirs (and git worktrees,
  // where trust is keyed on the main repo). Accept it quickly after launch;
  // the polling loops also catch it later, e.g. when claude is started by hand.
  if (provider === 'claude') {
    let checks = 0;
    const handle = setInterval(() => {
      try {
        if (acceptTrustPrompt(name, captureOutput(name, 30)) || ++checks >= 10) clearInterval(handle);
      } catch { clearInterval(handle); }
    }, 2000);
  }
  return getSession(name);
}

export async function sendKeys(name, keys, enter = false) {
  if (keys.includes('\n')) {
    // Multi-line: use bracketed paste so newlines are literal characters in
    // the input widget rather than triggering premature submission.
    execSync(`tmux set-buffer -- ${JSON.stringify(keys)}`, { encoding: 'utf8' });
    execSync(`tmux paste-buffer -p -t ${name}`, { encoding: 'utf8' });
  } else if (keys) {
    execSync(`tmux send-keys -t ${name} -l ${JSON.stringify(keys)}`, { encoding: 'utf8' });
  }
  if (enter) {
    await new Promise(r => setTimeout(r, 300));
    await execAsync(`tmux send-keys -t ${name} Enter`);
  }
}

// Send raw keystrokes (tmux key names like Escape, BTab, C-c, Up) and/or literal
// text with no trailing Enter. Key names are whitelisted; execFileSync avoids the shell.
const RAW_KEY_RE = /^(?:[CMS]-)*(?:[A-Za-z0-9]|Escape|Enter|Tab|BTab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|DC|IC|F(?:[1-9]|1[0-2]))$/;

export function sendRawKeys(name, { keys = [], text = '' } = {}) {
  const bad = keys.find(k => typeof k !== 'string' || !RAW_KEY_RE.test(k));
  if (bad !== undefined) throw new Error(`invalid key: ${bad}`);
  if (text) execFileSync('tmux', ['send-keys', '-t', name, '-l', text]);
  if (keys.length) execFileSync('tmux', ['send-keys', '-t', name, ...keys]);
}

// Parse Claude Code's interactive multi-choice questionnaire from captured output.
// Returns { question, items, cursorIdx } or null if no questionnaire is active.
export function parseQuestionnaire(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/Enter to select/.test(clean)) return null;

  const lines = clean.split('\n');
  const items = [];
  let cursorIdx = 0;
  let question = '';
  let foundFirst = false;
  let afterSep = false;

  for (const line of lines) {
    // Numbered option line: optional ❯, number, dot, optional [✔]/[ ], label
    const m = line.match(/^\s*(❯\s+)?(\d+)\.\s+(?:\[(.)\]\s+)?(.+)/);
    if (m) {
      if (m[1]) cursorIdx = items.length;
      items.push({
        label: m[4].trim(),
        checked: m[3] === '✔' || m[3] === 'x' || m[3] === 'X',
        hasCheckbox: m[3] !== undefined,
        afterSep,
      });
      foundFirst = true;
      continue;
    }
    // "Next" navigation button (indented, no number, before separator)
    if (foundFirst && !afterSep && /^\s{2,}Next\s*$/.test(line)) {
      items.push({ label: 'Next →', isNext: true });
      continue;
    }
    if (/^─{5,}/.test(line)) { if (foundFirst) afterSep = true; continue; }
    // Question text: last non-empty, non-nav-header, non-separator line before first option
    if (!foundFirst && line.trim() && !/^\s*[←→☒☐✔]/.test(line)) {
      question = line.trim();
    }
  }

  if (items.length === 0) return null;
  return { question, items, cursorIdx };
}

// Navigate to targetIdx and press Enter. Re-reads output to get fresh cursor position.
export function answerQuestionnaire(name, targetIdx) {
  const output = captureOutput(name, 60);
  const q = parseQuestionnaire(output);
  const cursorIdx = q ? q.cursorIdx : 0;
  const delta = targetIdx - cursorIdx;
  const key = delta >= 0 ? 'Down' : 'Up';
  // Small delay between keypresses to prevent the TUI from dropping rapid input
  for (let i = 0; i < Math.abs(delta); i++) {
    execSync(`tmux send-keys -t ${name} ${key}`, { encoding: 'utf8' });
    execSync('sleep 0.05', { encoding: 'utf8' });
  }
  execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf8' });
}

export function captureOutput(name, lines = 100) {
  try {
    return tmux('capture-pane', '-t', name, '-p', '-S', `-${lines}`);
  } catch {
    return '';
  }
}

export async function captureOutputAsync(name, lines = 100) {
  try {
    return await tmuxAsync('capture-pane', '-t', name, '-p', '-S', `-${lines}`);
  } catch {
    return '';
  }
}

export function killSession(name) {
  try {
    tmux('kill-session', '-t', name);
  } catch {}
  sessionMeta.delete(name);
  untrackSession(name); // intentional kill — don't auto-archive it later
}

// Map tmux session name → { sessionId, cwd } for live Claude processes.
// Claude Code writes ~/.claude/sessions/<pid>.json including its tmux target.
export function claudeSessionIds() {
  const dir = join(process.env.HOME, '.claude', 'sessions');
  const ids = new Map();
  let files = [];
  try { files = readdirSync(dir).filter(f => /^\d+\.json$/.test(f)); } catch { return ids; }
  for (const f of files) {
    try {
      const info = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      process.kill(info.pid, 0); // throws if the process is gone (stale file)
      const name = (info.tmux || '').split(':')[0];
      if (!name || !info.sessionId) continue;
      const prev = ids.get(name);
      if (!prev || (info.updatedAt || 0) > prev.updatedAt) {
        ids.set(name, { sessionId: info.sessionId, cwd: info.cwd, updatedAt: info.updatedAt || 0 });
      }
    } catch {}
  }
  return ids;
}

// The background-tasks panel (opened by monitor events) shows "Enter to view"
// and captures keyboard focus, blocking user input. Auto-dismiss it.
export function dismissBackgroundPanel(name, output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (/↑\/↓ to select.*Enter to view.*Esc to close/.test(clean)) {
    try { execSync(`tmux send-keys -t ${name} Escape`, { encoding: 'utf8' }); } catch {}
  }
}

// Auto-answer Claude's "Quick safety check … trust this folder" prompt with
// "Yes, I trust this folder". Sessions here already run with
// --dangerously-skip-permissions, so this adds no extra exposure. Only fires
// when the prompt is the bottom of the pane (not old scrollback).
const trustAnsweredAt = new Map();
export function acceptTrustPrompt(name, output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-12);
  if (!/Enter to confirm/.test(tail[tail.length - 1] || '')) return false;
  if (!tail.some(l => /Quick safety check|trust this folder/i.test(l))) return false;
  if (Date.now() - (trustAnsweredAt.get(name) || 0) < 5000) return true;
  const options = tail.filter(l => /^(❯\s*)?(\d+\.\s*)?(Yes, I trust this folder|No, exit)/.test(l));
  const cur = options.findIndex(l => l.startsWith('❯'));
  const yes = options.findIndex(l => /Yes, I trust this folder/.test(l));
  if (cur < 0 || yes < 0) return false;
  trustAnsweredAt.set(name, Date.now());
  const moves = Array(Math.abs(yes - cur)).fill(yes > cur ? 'Down' : 'Up');
  try {
    if (moves.length) execFileSync('tmux', ['send-keys', '-t', name, ...moves]);
    setTimeout(() => { try { execFileSync('tmux', ['send-keys', '-t', name, 'Enter']); } catch {} }, 150);
  } catch {}
  console.log(`[trust] auto-accepted folder trust prompt in ${name}`);
  return true;
}

export function checkForApprovalPrompt(name, output = null) {
  const meta = sessionMeta.get(name) || {};
  const provider = getProvider(meta.provider);
  const out = output ?? captureOutput(name, 20);
  const lastLines = out.split('\n').slice(-5).join('\n');
  return provider.approvalPatterns.some(p => p.test(lastLines));
}

export function setApprovalPending(name, promptText) {
  const meta = sessionMeta.get(name) || {};
  meta.pendingApproval = { text: promptText, at: Date.now() };
  meta.status = 'waiting';
  sessionMeta.set(name, meta);
}

export function clearApproval(name) {
  const meta = sessionMeta.get(name) || {};
  meta.pendingApproval = null;
  meta.status = 'running';
  sessionMeta.set(name, meta);
}

export function respondToApproval(name, approved) {
  if (approved) {
    execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf8' });
  } else {
    execSync(`tmux send-keys -t ${name} Escape`, { encoding: 'utf8' });
  }
  clearApproval(name);
}

export function setSessionStatus(name, status) {
  const meta = sessionMeta.get(name) || {};
  meta.status = status;
  sessionMeta.set(name, meta);
}

export function checkTmuxSizes(minWidth = 220, minHeight = 200) {
  try {
    const raw = execSync(
      `tmux list-windows -a -F '#{session_name} #{window_width}x#{window_height}'`,
      { encoding: 'utf8' }
    ).trim();
    if (!raw) return;
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\S+)\s+(\d+)x(\d+)$/);
      if (!m) continue;
      const [, name, w, h] = m;
      if (parseInt(w) < minWidth || parseInt(h) < minHeight) {
        console.warn(
          `[tmux] session "${name}" is ${w}x${h} — responses may be truncated. ` +
          `Run: tmux resize-window -t ${name} -x ${minWidth} -y ${minHeight}`
        );
      }
    }
  } catch {}
}
