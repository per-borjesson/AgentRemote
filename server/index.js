import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import multer from 'multer';
import {
  listSessions, getSession, createSession, sendKeys,
  captureOutput, killSession, checkForApprovalPrompt,
  setApprovalPending, respondToApproval, setSessionStatus,
  checkTmuxSizes, checkForResume, resumeSession,
  parseQuestionnaire, answerQuestionnaire,
} from './sessions.js';
import { initTelegram, sendApprovalRequest, sendNotification } from './telegram.js';
import { getProvider } from './providers.js';
import { readJsonlConversation } from './jsonl.js';

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
app.use(express.static(join(__dirname, '../public')));

// Auth middleware for API routes
app.use('/api', (req, res, next) => {
  const token = req.headers['x-token'] || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// REST API
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

app.post('/api/sessions/:name/input', (req, res) => {
  const { text, enter } = req.body;
  addUserMessage(req.params.name, text);
  broadcast({ type: 'user_input', session: req.params.name, text: (text || '').trim() });
  sendKeys(req.params.name, text, enter !== false);
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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get('token');
  if (token !== AUTH_TOKEN) {
    ws.close(1008, 'unauthorized');
    return;
  }

  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', sessions: listSessions(), version: VERSION }));

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

setInterval(() => {
  const sessions = listSessions();
  for (const session of sessions) {
    const prov = getProvider(session.provider);
    const isWatched = [...clients].some(c => c.readyState === 1 && c._watchSession === session.name);

    // Single capture per session per cycle — 500 lines for watched sessions
    // (pane height 200 + buffer), 50 lines for unwatched (approval/resume checks only).
    const output = captureOutput(session.name, isWatched ? 500 : 50);

    // Stream output to subscribed clients (only when someone is watching)
    if (isWatched) {
      const incoming = prov.extractResponses(output);
      mergeResponses(session.name, incoming);
      const conversation = mergeConversation(session.name, incoming, prov);
      const questionnaire = parseQuestionnaire(output);
      const jsonl = session.provider === 'claude' ? readJsonlConversation(resolveWorkdir(session)) : null;
      for (const client of clients) {
        if (client.readyState === 1 && client._watchSession === session.name) {
          client.send(JSON.stringify({ type: 'output', session: session.name, output, conversation, questionnaire: questionnaire || null, jsonl }));
        }
      }
    }

    // Check for pending approvals (reuse captured output)
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

    // Check for Claude exit with resume ID (reuse captured output)
    const resumeId = checkForResume(session.name, output);
    if (resumeId && !knownResumable.has(session.name)) {
      knownResumable.add(session.name);
      broadcast({ type: 'session_resumable', session: session.name, resumeId });
      sendNotification(`⏸ Session *${session.name}* ended — tap Resume in the app`).catch(() => {});
    } else if (!resumeId) {
      knownResumable.delete(session.name);
    }
  }

  // Broadcast session list update to all clients
  broadcast({ type: 'sessions_update', sessions });
}, 2000);

// Telegram
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  initTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID, broadcast);
} else {
  console.warn('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — Telegram disabled');
}

server.listen(PORT, () => {
  console.log(`AgentRemote running on http://localhost:${PORT}`);
  checkTmuxSizes();
});
