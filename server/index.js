import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join, basename, resolve } from 'path';
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import multer from 'multer';
import {
  listSessions, getSession, createSession, sendKeys,
  captureOutput, captureOutputAsync, killSession, checkForApprovalPrompt,
  setApprovalPending, respondToApproval, setSessionStatus,
  checkTmuxSizes, checkForResume, resumeSession, waitForResumeId,
  parseQuestionnaire, answerQuestionnaire, updateTokensFromOutput, updateProcessMemory,
  dismissBackgroundPanel, sendRawKeys, claudeSessionIds, acceptTrustPrompt,
} from './sessions.js';
import { listArchived, addArchived, removeArchived, trackSession, untrackSession, listTracked } from './archived.js';
import { initTelegram, sendApprovalRequest, sendNotification } from './telegram.js';
import { getProvider } from './providers.js';
import { readJsonlConversation, readJsonlHistory } from './jsonl.js';
import { getSettings, saveSection, saveCustom, deleteCustom, saveAiProvider, deleteAiProvider, testTelegram, testEmail, startClaudeLogin, getClaudeStatus, startCodexLogin, getCodexOAuthStatus, readEnvFile } from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveWorkdir(session) {
  if (!session) return null;
  if (session.workdir) return session.workdir;
  try {
    return execSync(
      `tmux display-message -p -t ${session.name} '#{pane_current_path}'`,
      { encoding: 'utf8' }
    ).trim() || null;
  } catch { return null; }
}
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const VERSION = '20260523-3';

if (!AUTH_TOKEN) {
  console.error('AUTH_TOKEN not set in .env');
  process.exit(1);
}

const app = express();
app.use(express.json());
// Serve index.html with ?v= set to each asset's mtime, so browsers (and
// Cloudflare's 4h browser-cache TTL) pick up new app.js/style.css immediately.
const PUBLIC_DIR = join(__dirname, '../public');
function serveIndex(req, res) {
  const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8').replace(
    /(href|src)="\/([\w.-]+\.(?:js|css))\?v=[^"]*"/g,
    (m, attr, file) => {
      try { return `${attr}="/${file}?v=${Math.floor(statSync(join(PUBLIC_DIR, file)).mtimeMs)}"`; } catch { return m; }
    }
  );
  res.set('Cache-Control', 'no-cache').type('html').send(html);
}
app.get(['/', '/index.html'], serveIndex);
app.use(express.static(PUBLIC_DIR));

// Auth middleware for API routes
app.use('/api', (req, res, next) => {
  const token = req.headers['x-token'] || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// REST API

// TEMP DEBUG: native-view render timeline from clients (flicker investigation)
app.post('/api/debug/render', (req, res) => {
  console.log('[render-dbg]', JSON.stringify(req.body));
  res.json({ ok: true });
});
app.get('/api/sessions', (req, res) => {
  res.json(listSessions());
});

app.post('/api/sessions', (req, res) => {
  const { name, task, provider, workdir } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const session = createSession(name, task, provider, workdir);
    broadcast({ type: 'session_created', session });
    sendNotification(`🚀 Session *${name}* started\n_${task}_`).catch(() => {});
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions/:name/output', (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  const output = captureOutput(req.params.name, lines);
  const conversation = conversations.get(req.params.name) || [];
  const session = getSession(req.params.name);
  const jsonl = session?.provider === 'claude' ? readJsonlConversation(resolveWorkdir(session)) : null;
  res.json({ output, conversation, jsonl });
});

app.get('/api/sessions/:name/jsonl/history', (req, res) => {
  const session = getSession(req.params.name);
  if (!session) return res.status(404).json({ error: 'not found' });
  const before = parseInt(req.query.before) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const result = readJsonlHistory(resolveWorkdir(session), { before, limit });
  res.json(result || { conv: [], hasMore: false });
});

app.post('/api/sessions/:name/input', (req, res) => {
  const { text, enter } = req.body;
  addUserMessage(req.params.name, text);
  broadcast({ type: 'user_input', session: req.params.name, text: (text || '').trim() });
  sendKeys(req.params.name, text, enter !== false);
  res.json({ ok: true });
});

app.post('/api/sessions/:name/keys', (req, res) => {
  if (!getSession(req.params.name)) return res.status(404).json({ error: 'not found' });
  const { keys, text } = req.body;
  try {
    sendRawKeys(req.params.name, { keys: Array.isArray(keys) ? keys : [], text: typeof text === 'string' ? text : '' });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ ok: true });
});

app.post('/api/sessions/:name/approve', (req, res) => {
  const { approved } = req.body;
  respondToApproval(req.params.name, approved);
  broadcast({ type: 'approval_response', session: req.params.name, approved });
  res.json({ ok: true });
});

app.post('/api/sessions/:name/resume', (req, res) => {
  const ok = resumeSession(req.params.name);
  if (!ok) return res.status(400).json({ error: 'no resume ID available' });
  knownResumable.delete(req.params.name);
  broadcast({ type: 'session_resumed', session: req.params.name });
  res.json({ ok: true });
});

app.post('/api/sessions/:name/questionnaire', (req, res) => {
  const { targetIdx } = req.body;
  if (targetIdx === undefined) return res.status(400).json({ error: 'targetIdx required' });
  answerQuestionnaire(req.params.name, targetIdx);
  res.json({ ok: true });
});

app.get('/api/agents', (req, res) => {
  const agentsDir = join(process.env.HOME, 'agents');
  let dirs = [];
  try {
    dirs = readdirSync(agentsDir)
      .filter(name => { try { return statSync(join(agentsDir, name)).isDirectory(); } catch { return false; } })
      .sort()
      .map(name => {
        const dirPath = join(agentsDir, name);
        const contextFile = ['CLAUDE.md', 'README.md'].find(f => existsSync(join(dirPath, f))) || null;
        return { name, path: dirPath, contextFile };
      });
  } catch {}
  res.json(dirs);
});

// File upload — store in <workdir>/uploads/, return the path
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const session = getSession(req.params.name);
      if (!session) return cb(new Error('session not found'));
      if (!session.workdir) {
        try {
          session.workdir = execSync(
            `tmux display-message -p -t ${req.params.name} '#{pane_current_path}'`,
            { encoding: 'utf8' }
          ).trim();
        } catch {
          return cb(new Error('session has no workdir'));
        }
      }
      const dir = join(session.workdir, 'uploads');
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      // Sanitise: keep only safe filename characters
      const safe = basename(file.originalname).replace(/[^a-zA-Z0-9._\-]/g, '_');
      cb(null, safe);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

app.post('/api/sessions/:name/upload', (req, res, next) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const absPath = join(req.file.destination, req.file.filename);
    const relPath = `uploads/${req.file.filename}`;
    res.json({ filename: req.file.filename, path: absPath, relPath });
  });
});

// Settings — specific routes before general /:section
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.get('/api/settings/claude/status', (req, res) => res.json(getClaudeStatus()));

app.post('/api/settings/claude/login', async (req, res) => {
  try { res.json(await startClaudeLogin()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings/codex/status', (req, res) => res.json(getCodexOAuthStatus()));

app.post('/api/settings/codex/login', async (req, res) => {
  try { res.json(await startCodexLogin()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/telegram/test', async (req, res) => {
  try { res.json({ ok: true, message: await testTelegram() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/settings/email/test', async (req, res) => {
  try { res.json({ ok: true, message: await testEmail() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/settings/custom', (req, res) => {
  try { saveCustom(req.body.name, req.body.value); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/settings/custom/:name', (req, res) => {
  deleteCustom(req.params.name);
  res.json({ ok: true });
});

app.post('/api/settings/ai-provider', (req, res) => {
  try { saveAiProvider(req.body.name, req.body.baseUrl, req.body.key); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/settings/ai-provider/:name', (req, res) => {
  deleteAiProvider(req.params.name);
  res.json({ ok: true });
});

app.post('/api/settings/:section', (req, res) => {
  try { saveSection(req.params.section, req.body); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const home = process.env.HOME;
  const resolved = resolve(filePath.replace(/^~/, home));
  if (!resolved.startsWith(home + '/')) return res.status(403).json({ error: 'access denied' });
  if (!existsSync(resolved)) return res.status(404).json({ error: 'not found' });
  res.download(resolved, basename(resolved));
});

// Archive: send /exit, wait for resume ID, persist to disk, kill tmux
app.post('/api/sessions/:name/archive', async (req, res) => {
  const session = getSession(req.params.name);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json({ ok: true }); // respond immediately; work continues in background
  sendKeys(req.params.name, '/exit', true);
  const resumeId = await waitForResumeId(req.params.name);
  const entry = {
    name: req.params.name,
    resumeId: resumeId || null,
    task: session.task,
    provider: session.provider,
    workdir: session.workdir,
    archivedAt: Date.now(),
  };
  addArchived(entry);
  killSession(req.params.name);
  storedResponses.delete(req.params.name);
  conversations.delete(req.params.name);
  knownResumable.delete(req.params.name);
  broadcast({ type: 'session_archived', entry, sessions: listSessions(), archived: listArchived() });
});

// List archived sessions
app.get('/api/archived', (req, res) => res.json(listArchived()));

// Resume an archived session — creates a fresh tmux pane and restores the conversation
app.post('/api/archived/:name/resume', (req, res) => {
  const entry = listArchived().find(e => e.name === req.params.name);
  if (!entry) return res.status(404).json({ error: 'not found' });
  try {
    const session = createSession(entry.name, entry.task, entry.provider || 'claude', entry.workdir, entry.resumeId);
    removeArchived(entry.name);
    broadcast({ type: 'session_created', session, archived: listArchived() });
    sendNotification(`▶ Session *${entry.name}* resumed`).catch(() => {});
    res.json(session);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete an archived entry without resuming
app.delete('/api/archived/:name', (req, res) => {
  removeArchived(req.params.name);
  broadcast({ type: 'sessions_update', sessions: listSessions(), archived: listArchived() });
  res.json({ ok: true });
});

app.delete('/api/sessions/:name', (req, res) => {
  killSession(req.params.name);
  storedResponses.delete(req.params.name);
  conversations.delete(req.params.name);
  knownResumable.delete(req.params.name);
  broadcast({ type: 'session_killed', name: req.params.name });
  res.json({ ok: true });
});

// WebSocket
const server = createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

// Slow/half-dead connections (flaky mobile links) queue frames that then arrive
// minutes late and overwrite fresh state in the UI. Every frame is a full
// snapshot, so skip frames while a client is backed up, and drop it if the
// backlog keeps growing — the client reconnects and gets current state.
const WS_SKIP_BYTES = 512 * 1024;
const WS_DROP_BYTES = 4 * 1024 * 1024;
function sendFresh(client, data) {
  if (client.readyState !== 1) return;
  if (client.bufferedAmount > WS_DROP_BYTES) { client.terminate(); clients.delete(client); return; }
  if (client.bufferedAmount > WS_SKIP_BYTES) return;
  client.send(data);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) sendFresh(client, data);
}

// Heartbeat: terminate sockets that stop answering pings (phone slept, network gone)
setInterval(() => {
  for (const client of clients) {
    if (client._alive === false) { client.terminate(); clients.delete(client); continue; }
    client._alive = false;
    try { client.ping(); } catch {}
  }
}, 30000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');
  if (token !== AUTH_TOKEN) {
    ws.close(1008, 'unauthorized');
    return;
  }

  clients.add(ws);
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
  ws.send(JSON.stringify({ type: 'connected', sessions: listSessions(), archived: listArchived(), version: VERSION }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'subscribe_output') {
        ws._watchSession = msg.session;
      }
    } catch {}
  });

  ws.on('close', () => clients.delete(ws));
});

// Poll sessions for output updates and approval prompts
const knownApprovals = new Set();
const knownResumable = new Set();
const storedResponses = new Map(); // session name → string[] (for Telegram)
const conversations   = new Map(); // session name → {role,text}[] (for UI)

function mergeResponses(name, incoming) {
  const stored = storedResponses.get(name) || [];
  for (const resp of incoming) {
    const last = stored.length > 0 ? stored[stored.length - 1] : null;
    if (last && last.length >= 20 && resp.length >= 20) {
      const anchor = Math.min(80, last.length, resp.length);
      if (last.slice(0, anchor) === resp.slice(0, anchor)) {
        if (resp.length > last.length) stored[stored.length - 1] = resp;
        continue;
      }
    }
    if (!stored.includes(resp)) {
      stored.push(resp);
    }
  }
  storedResponses.set(name, stored);
  return stored;
}

function mergeConversation(name, incoming, provider) {
  const conv = conversations.get(name) || [];
  for (const raw of incoming) {
    const text = raw.split('\n')
      .filter(line => !provider.noisePatterns.some(p => p.test(line)))
      .join('\n').trim();
    if (!text) continue;
    const lastAIIdx = conv.reduce((idx, e, i) => e.role === 'ai' ? i : idx, -1);
    const lastAI = lastAIIdx >= 0 ? conv[lastAIIdx] : null;
    if (lastAI && lastAI.text.length >= 20 && text.length >= 20) {
      const anchor = Math.min(80, lastAI.text.length, text.length);
      if (lastAI.text.slice(0, anchor) === text.slice(0, anchor)) {
        // Same block — keep the longer version, discard the shorter
        if (text.length > lastAI.text.length) {
          conv[lastAIIdx] = { role: 'ai', text, ts: lastAI.ts || Date.now() };
        }
        continue;
      }
    }
    if (!conv.some(e => e.role === 'ai' && e.text === text)) {
      conv.push({ role: 'ai', text, ts: Date.now() });
    }
  }
  conversations.set(name, conv);
  return conv;
}

function addUserMessage(name, text) {
  const t = (text || '').trim();
  if (!t) return;
  const conv = conversations.get(name) || [];
  conv.push({ role: 'user', text: t, ts: Date.now() });
  conversations.set(name, conv);
}

// Fast loop (2s) — watched sessions only: capture output and stream to UI.
// One captureOutputAsync per watched session; idle cost is near-zero when
// nobody has the browser open.
setInterval(async () => {
  const sessions = listSessions();
  const watchedSessions = sessions.filter(s =>
    [...clients].some(c => c.readyState === 1 && c._watchSession === s.name)
  );

  await Promise.all(watchedSessions.map(async session => {
    const prov = getProvider(session.provider);
    const output = await captureOutputAsync(session.name, 500);
    updateTokensFromOutput(session.name, output);
    dismissBackgroundPanel(session.name, output);
    if (session.provider === 'claude') acceptTrustPrompt(session.name, output);

    const incoming = prov.extractResponses(output);
    mergeResponses(session.name, incoming);
    const conversation = mergeConversation(session.name, incoming, prov);
    const questionnaire = parseQuestionnaire(output);
    const jsonl = session.provider === 'claude' ? readJsonlConversation(resolveWorkdir(session)) : null;
    for (const client of clients) {
      if (client.readyState === 1 && client._watchSession === session.name) {
        sendFresh(client, JSON.stringify({ type: 'output', session: session.name, output, conversation, questionnaire: questionnaire || null, jsonl }));
      }
    }
  }));

  broadcast({ type: 'sessions_update', sessions, archived: listArchived() });
}, 2000);

// Auto-archive: snapshot live Claude sessions (name → resume ID) to disk; a
// tracked session that disappears without an explicit kill/archive (tmux server
// died, service restart) is moved to the archive so it can be resumed.
// Two consecutive misses are required so a transient tmux error doesn't archive everything.
const missingCounts = new Map();
function reconcileTracked(sessions) {
  const ids = claudeSessionIds();
  const live = new Set(sessions.map(s => s.name));
  for (const session of sessions) {
    const id = ids.get(session.name);
    if (!id) continue;
    trackSession({
      name: session.name,
      resumeId: id.sessionId,
      task: session.task,
      provider: 'claude',
      workdir: session.workdir || id.cwd,
    });
  }
  let archivedAny = false;
  for (const [name, entry] of Object.entries(listTracked())) {
    if (live.has(name)) { missingCounts.delete(name); continue; }
    const misses = (missingCounts.get(name) || 0) + 1;
    missingCounts.set(name, misses);
    if (misses < 2) continue;
    missingCounts.delete(name);
    untrackSession(name);
    addArchived({ ...entry, archivedAt: Date.now() });
    archivedAny = true;
    console.log(`[auto-archive] ${name} disappeared — archived with resume ID ${entry.resumeId}`);
    sendNotification(`📦 Session *${name}* closed unexpectedly — archived, tap Resume in the app`).catch(() => {});
  }
  if (archivedAny) broadcast({ type: 'sessions_update', sessions, archived: listArchived() });
}
reconcileTracked(listSessions());

// Slow loop (30s) — all sessions: approval/resume detection, memory, token
// updates. Telegram notifications tolerate up to 30s delay; this cuts
// per-minute process spawns by ~10× compared to doing it in the fast loop.
setInterval(async () => {
  const sessions = listSessions();
  reconcileTracked(sessions);

  await Promise.all(sessions.map(async session => {
    const output = await captureOutputAsync(session.name, 50);
    updateTokensFromOutput(session.name, output);
    await updateProcessMemory(session.name);
    dismissBackgroundPanel(session.name, output);
    if (session.provider === 'claude') acceptTrustPrompt(session.name, output);

    // Approvals
    if (!session.pendingApproval && checkForApprovalPrompt(session.name, output)) {
      if (!knownApprovals.has(session.name)) {
        knownApprovals.add(session.name);
        setApprovalPending(session.name, output);
        broadcast({ type: 'approval_needed', session: session.name, prompt: output });
        sendApprovalRequest(session.name, output).catch(() => {});
      }
    } else if (session.pendingApproval === null) {
      knownApprovals.delete(session.name);
    }

    // Resume
    const resumeId = checkForResume(session.name, output);
    if (resumeId && !knownResumable.has(session.name)) {
      knownResumable.add(session.name);
      broadcast({ type: 'session_resumable', session: session.name, resumeId });
      sendNotification(`⏸ Session *${session.name}* ended — tap Resume in the app`).catch(() => {});
    } else if (!resumeId) {
      knownResumable.delete(session.name);
    }
  }));
}, 30000);

// Telegram — read from canonical ~/.secrets/telegram.env, fall back to .env
{
  const tgEnv = readEnvFile(join(process.env.HOME, '.secrets', 'telegram.env'));
  const tgToken  = tgEnv.BOT_TOKEN  || process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = tgEnv.CHAT_ID    || process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChatId) {
    initTelegram(tgToken, tgChatId, broadcast);
  } else {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — Telegram disabled');
  }
}

server.listen(PORT, () => {
  console.log(`AgentRemote running on http://localhost:${PORT}`);
  checkTmuxSizes();
});
