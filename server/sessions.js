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
      return {
        name,
        created: parseInt(created) * 1000,
        activity: parseInt(activity) * 1000,
        task: meta.task || null,
        status: meta.status || 'running',
        provider: meta.provider || DEFAULT_PROVIDER,
        workdir: meta.workdir || null,
        pendingApproval: meta.pendingApproval || null,
      };
    });
}

export function getSession(name) {
  return listSessions().find(s => s.name === name) || null;
}

export function createSession(name, task, provider = DEFAULT_PROVIDER, workdir = null) {
  // Default: ~/agents/<name> — each session gets its own isolated folder
  const dir = workdir || `${process.env.HOME}/agents/${name}`;
  execSync(`mkdir -p ${JSON.stringify(dir)}`);
  try {
    tmux('new-session', '-d', '-s', name, '-c', dir);
  } catch (e) {
    if (!e.message.includes('duplicate session')) throw e;
  }
  sessionMeta.set(name, { task, provider, workdir: dir, status: 'running', pendingApproval: null });
  const cmd = getProvider(provider).launch(task);
  sendKeys(name, cmd, true);
  return getSession(name);
}

export function sendKeys(name, keys, enter = false) {
  execSync(`tmux send-keys -t ${name} -l ${JSON.stringify(keys)}`, { encoding: 'utf8' });
  if (enter) {
    // Small delay lets the TUI register the text before Enter fires
    setTimeout(() => {
      execSync(`tmux send-keys -t ${name} Enter`, { encoding: 'utf8' });
    }, 300);
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
