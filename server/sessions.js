import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { getProvider, DEFAULT_PROVIDER } from './providers.js';

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
      // If metadata was lost on restart, detect provider from tmux scrollback
      const provider = meta.provider || detectProvider(name);
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
      };
    });
}

export function checkForResume(name) {
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
  const output = captureOutput(name, 50).replace(/\x1b\[[0-9;]*m/g, '');
  const m = output.match(provider.resumePattern);
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

export function createSession(name, task = null, provider = DEFAULT_PROVIDER, workdir = null) {
  // Default: ~/agents/<name> — each session gets its own isolated folder
  const dir = workdir || `${process.env.HOME}/agents/${name}`;
  execSync(`mkdir -p ${JSON.stringify(dir)}`);
  try {
    tmux('new-session', '-d', '-s', name, '-c', dir, '-x', '220', '-y', '50');
  } catch (e) {
    if (!e.message.includes('duplicate session')) throw e;
  }
  sessionMeta.set(name, { task, provider, workdir: dir, status: 'running', pendingApproval: null });
  const cmd = getProvider(provider).launch(task);
  sendKeys(name, cmd, true);
  // Claude defaults to high effort — set normal so it doesn't over-think and spam tool-call messages
  if (provider === 'claude') {
    setTimeout(() => sendKeys(name, '/effort low', true), 15000);
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
          // Cursor starts on "Yes, continue" (option 1); Enter accepts it
          setTimeout(() => execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf8' }), 100);
          clearInterval(handle);
          return;
        }
      } catch {}
      if (++checks >= 10) clearInterval(handle);
    }, 2000);
  }
  return getSession(name);
}

export function sendKeys(name, keys, enter = false) {
  const lines = keys.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) execSync(`tmux send-keys -t ${name} -l ${JSON.stringify(lines[i])}`, { encoding: 'utf8' });
    if (i < lines.length - 1) execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf8' });
  }
  if (enter) {
    setTimeout(() => execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf8' }), 300);
  }
}

export function captureOutput(name, lines = 100) {
  try {
    return tmux('capture-pane', '-t', name, '-p', '-S', `-${lines}`);
  } catch {
    return '';
  }
}

export function killSession(name) {
  try {
    tmux('kill-session', '-t', name);
  } catch {}
  sessionMeta.delete(name);
}

export function checkForApprovalPrompt(name) {
  const meta = sessionMeta.get(name) || {};
  const provider = getProvider(meta.provider);
  const output = captureOutput(name, 20);
  const lastLines = output.split('\n').slice(-5).join('\n');
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

export function checkTmuxSizes(minWidth = 220, minHeight = 50) {
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
