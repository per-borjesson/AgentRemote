import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  listSessions, getSession, createSession, sendKeys,
  captureOutput, killSession, checkForApprovalPrompt,
  setApprovalPending, respondToApproval, setSessionStatus,
  checkTmuxSizes, checkForResume, resumeSession,
} from './sessions.js';
import { initTelegram, sendApprovalRequest, sendNotification } from './telegram.js';
import { getProvider } from './providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  res.json({ output, conversation });
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
    if (last && resp.startsWith(last.slice(0, 40)) && resp !== last) {
      stored[stored.length - 1] = resp;
    } else if (!stored.includes(resp)) {
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
    if (lastAI && text.startsWith(lastAI.text.slice(0, 40)) && text !== lastAI.text) {
      conv[lastAIIdx] = { role: 'ai', text, ts: lastAI.ts || Date.now() };
    } else if (!conv.some(e => e.role === 'ai' && e.text === text)) {
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
    // Stream output to subscribed clients
    const output = captureOutput(session.name, 300);
    const prov = getProvider(session.provider);
    const incoming = prov.extractResponses(output);
    mergeResponses(session.name, incoming);
    const conversation = mergeConversation(session.name, incoming, prov);
    for (const client of clients) {
      if (client.readyState === 1 && client._watchSession === session.name) {
        client.send(JSON.stringify({ type: 'output', session: session.name, output, conversation }));
      }
    }

    // Check for pending approvals
    if (!session.pendingApproval && checkForApprovalPrompt(session.name)) {
      if (!knownApprovals.has(session.name)) {
        knownApprovals.add(session.name);
        const promptText = captureOutput(session.name, 20);
        setApprovalPending(session.name, promptText);
        broadcast({ type: 'approval_needed', session: session.name, prompt: promptText });
        sendApprovalRequest(session.name, promptText).catch(() => {});
      }
    } else if (session.pendingApproval === null) {
      knownApprovals.delete(session.name);
    }

    // Check for Claude exit with resume ID
    const resumeId = checkForResume(session.name);
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
