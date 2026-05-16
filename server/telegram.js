import TelegramBot from 'node-telegram-bot-api';
import { respondToApproval, listSessions, createSession, killSession, captureOutput, sendKeys } from './sessions.js';

let bot = null;
let chatId = null;
let broadcastFn = null;

const connectState = {
  session: null,
  messageId: null,      // the disconnect button message
  interval: null,
  sentResponses: new Set(),
  lastResponseMsgId: null,   // message id of the most recently sent response
  lastResponseText: null,    // its content — so we can detect in-place growth
};

export function initTelegram(token, targetChatId, onBroadcast) {
  chatId = targetChatId;
  broadcastFn = onBroadcast;

  bot = new TelegramBot(token, { polling: true });

  function isAuthorized(msg) {
    return String(msg.chat.id) === String(chatId);
  }

  function guard(fn) {
    return async (...args) => {
      try {
        await fn(...args);
      } catch (e) {
        console.error('[telegram] handler error:', e.message, e.stack);
        bot.sendMessage(chatId, `⚠️ Error: ${e.message}`).catch(() => {});
      }
    };
  }

  // Passthrough when connected
  bot.on('message', guard(async (msg) => {
    if (!isAuthorized(msg)) return;
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;
    if (connectState.session) sendKeys(connectState.session, msg.text, true);
  }));

  // /list
  bot.onText(/^\/list$/, guard(async (msg) => {
    if (!isAuthorized(msg)) return;
    await sendSessionList();
  }));

  // /new name | task
  bot.onText(/^\/new (.+)$/, guard(async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const parts = match[1].split('|');
    if (parts.length < 2)
      return bot.sendMessage(chatId, 'Usage: `/new session-name | task description`', { parse_mode: 'Markdown' });
    const name = parts[0].trim().replace(/\s+/g, '-');
    const task = parts.slice(1).join('|').trim();
    createSession(name, task);
    broadcastFn({ type: 'session_created', session: { name, task } });
    await bot.sendMessage(chatId, `🚀 Session \`${name}\` started\n_${task}_`, { parse_mode: 'Markdown' });
  }));

  // /output [name]
  bot.onText(/^\/output(?:\s+(.+))?$/, guard(async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const name = match[1]?.trim();
    if (!name) return sendSessionList();
    await sendOutput(name);
  }));

  // /kill [name]
  bot.onText(/^\/kill(?:\s+(.+))?$/, guard(async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const name = match[1]?.trim();
    if (!name) return sendSessionList();
    await doKill(name);
  }));

  // /send name | text
  bot.onText(/^\/send (.+)$/, guard(async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const parts = match[1].split('|');
    if (parts.length < 2)
      return bot.sendMessage(chatId, 'Usage: `/send session-name | text to send`', { parse_mode: 'Markdown' });
    const name = parts[0].trim();
    const text = parts.slice(1).join('|').trim();
    sendKeys(name, text, true);
    await bot.sendMessage(chatId, `✉️ Sent to \`${name}\``, { parse_mode: 'Markdown' });
  }));

  // /disconnect
  bot.onText(/^\/disconnect$/, guard(async (msg) => {
    if (!isAuthorized(msg)) return;
    if (!connectState.session) return bot.sendMessage(chatId, 'Not connected to any session.');
    await disconnect('Disconnected.');
  }));

  // /help
  bot.onText(/^\/help$/, guard(async (msg) => {
    if (!isAuthorized(msg)) return;
    await bot.sendMessage(chatId, [
      '*Codex Mobile*',
      '',
      '`/list` — browse sessions',
      '`/new name | task` — start a session',
      '`/output [name]` — get latest output',
      '`/send name | text` — send input',
      '`/kill [name]` — kill a session',
      '`/disconnect` — exit connect mode',
    ].join('\n'), { parse_mode: 'Markdown' });
  }));

  // Inline buttons
  bot.on('callback_query', guard(async (query) => {
    if (String(query.from.id) !== String(chatId)) return;
    await bot.answerCallbackQuery(query.id);

    const colonIdx = query.data.indexOf(':');
    const action = query.data.slice(0, colonIdx);
    const sessionName = query.data.slice(colonIdx + 1);

    if (action === 'approve' || action === 'reject') {
      const approved = action === 'approve';
      respondToApproval(sessionName, approved);
      broadcastFn({ type: 'approval_response', session: sessionName, approved });
      await bot.editMessageText(
        `${approved ? '✅ Approved' : '❌ Rejected'} — \`${sessionName}\``,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    }

    if (action === 'session') await showSessionMenu(query, sessionName);

    if (action === 'menu-output') {
      await sendOutput(sessionName);
      await bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
    }

    if (action === 'menu-connect') {
      await bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
      await startConnect(sessionName);
    }

    if (action === 'menu-kill') {
      await doKill(sessionName);
      await bot.editMessageText(`🗑 Session \`${sessionName}\` killed.`,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    }

    if (action === 'menu-back') await editToSessionList(query);

    if (action === 'do-disconnect') await disconnect('Disconnected.');
  }));

  bot.on('polling_error', (err) => {
    console.error('[telegram] polling error:', err.message);
  });

  bot.setMyCommands([
    { command: 'list',       description: 'Browse active sessions' },
    { command: 'new',        description: 'Start a session: /new name | task' },
    { command: 'output',     description: 'Get output: /output name' },
    { command: 'send',       description: 'Send input: /send name | text' },
    { command: 'kill',       description: 'Kill a session: /kill name' },
    { command: 'disconnect', description: 'Exit connect mode' },
    { command: 'help',       description: 'Show help' },
  ]).catch(() => {});

  console.log('[telegram] bot initialized');
}

// --- Connect mode ---

async function startConnect(name) {
  if (connectState.session) stopConnectPolling();

  // Send the header with disconnect button — this stays pinned
  const sent = await bot.sendMessage(
    chatId,
    `🔌 *Connected to \`${name}\`*\n_Type any message to send. Tap Disconnect to exit._`,
    { parse_mode: 'Markdown', reply_markup: disconnectMarkup(name) }
  );

  // Snapshot: collect all existing • responses so we don't re-send them
  const existing = captureOutput(name, 500) || '';
  const existingResponses = extractResponses(existing);
  connectState.sentResponses = new Set(existingResponses.map(r => r.trim()));

  // Send last 3 responses as "you are here" context
  const snapshot = existingResponses.slice(-3).join('\n\n').trim();
  if (snapshot) await bot.sendMessage(chatId, snapshot).catch(() => {});

  connectState.session = name;
  connectState.messageId = sent.message_id;

  connectState.interval = setInterval(async () => {
    if (!connectState.session) return;
    const fresh = captureOutput(connectState.session, 500) || '';
    if (!fresh) return;

    const allResponses = extractResponses(fresh);
    for (const r of allResponses) {
      const text = r.trim();
      if (connectState.sentResponses.has(text)) continue;

      // If this response is a grown version of the last one, edit instead of sending new
      if (
        connectState.lastResponseMsgId &&
        connectState.lastResponseText &&
        text.startsWith(connectState.lastResponseText) &&
        text !== connectState.lastResponseText
      ) {
        connectState.sentResponses.delete(connectState.lastResponseText);
        connectState.sentResponses.add(text);
        connectState.lastResponseText = text;
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: connectState.lastResponseMsgId,
        }).catch(() => {});
      } else {
        connectState.sentResponses.add(text);
        const sent = await bot.sendMessage(chatId, text).catch(e => { console.error('[poll] send error:', e.message); return null; });
        if (sent) {
          connectState.lastResponseMsgId = sent.message_id;
          connectState.lastResponseText = text;
        }
      }
    }
  }, 2000);
}

async function disconnect(reason = 'Disconnected.') {
  const name = connectState.session;
  stopConnectPolling();
  if (connectState.messageId) {
    await bot.editMessageText(`⏹ _${reason}_ — \`${name}\``, {
      chat_id: chatId,
      message_id: connectState.messageId,
      parse_mode: 'Markdown',
    }).catch(() => {});
    connectState.messageId = null;
  }
  await bot.sendMessage(chatId, `⏹ Disconnected from \`${name}\`. Messages are no longer forwarded.`, { parse_mode: 'Markdown' });
}

function stopConnectPolling() {
  if (connectState.interval) { clearInterval(connectState.interval); connectState.interval = null; }
  connectState.session = null;
  connectState.sentResponses = new Set();
  connectState.lastResponseMsgId = null;
  connectState.lastResponseText = null;
}

// Extract all • response blocks from tmux output.
// A block starts with • and continues until the next •, a › prompt, or a separator.
function extractResponses(output) {
  const lines = output.split('\n');
  const responses = [];
  let block = null;
  let trailingEmpties = 0;

  const flush = () => {
    if (block !== null) {
      responses.push(block.trim());
      block = null;
      trailingEmpties = 0;
    }
  };

  for (const line of lines) {
    const isResponse = /^\s*•\s/.test(line) && !/[◦•] Working \(\d+s/.test(line);
    const isPrompt   = /^\s*›/.test(line);
    const isSep      = /^─{5,}/.test(line);
    const isEmpty    = !line.trim();

    if (isResponse) {
      flush();
      block = line;
      trailingEmpties = 0;
    } else if (block !== null) {
      if (isPrompt || isSep) {
        flush();
      } else if (isEmpty) {
        trailingEmpties++;
        block += '\n';
      } else {
        // Non-empty continuation — part of this block
        block += '\n'.repeat(trailingEmpties + 1) + line;
        trailingEmpties = 0;
      }
    }
  }
  flush();
  return responses.filter(Boolean);
}

const NOISE_PATTERNS = [
  /gpt-\S+.*·/,           // model status: "gpt-5.5 medium · ~"
  /[◦•] Working \(\d+s/,  // working spinner
  /esc to interrupt/,
  /Press enter to confirm/,
  /^\s*›/,                // echoed input + ghost suggestions
  /^\s*[╭╰│─]/,           // TUI box drawing characters
  /Codex \(v\d/,
  /model:.*\/model/,
  /directory:/,
  /^  Tip:/,
  /let's\s*\n?\s*build together/,
];

function isNoisyLine(line) {
  return NOISE_PATTERNS.some(p => p.test(line));
}

// Split output into meaningful chunks to send as separate messages
function splitIntoChunks(text) {
  const SEPARATOR = /─{10,}/;
  // Split on Codex horizontal separators or double newlines
  const parts = text.split(/\n(?=─{10,})|\n{3,}/);
  const chunks = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || SEPARATOR.test(trimmed)) continue;
    // Telegram max message length is 4096 — split if needed
    if (trimmed.length <= 4000) {
      chunks.push(trimmed);
    } else {
      for (let i = 0; i < trimmed.length; i += 4000) {
        chunks.push(trimmed.slice(i, i + 4000));
      }
    }
  }
  return chunks;
}

function disconnectMarkup(name) {
  return { inline_keyboard: [[{ text: '⏹ Disconnect', callback_data: `do-disconnect:${name}` }]] };
}

// --- Helpers ---

async function sendSessionList() {
  const sessions = listSessions();
  if (!sessions.length) return bot.sendMessage(chatId, '📭 No active sessions.');
  const lines = sessions.map(s => {
    const icon = s.status === 'waiting' ? '⏳' : '🟢';
    return `${icon} \`${s.name}\` — ${s.task || '—'} _${formatAge(s.created)}_`;
  });
  await bot.sendMessage(chatId, lines.join('\n') + '\n\n_Tap a session to manage it:_', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: sessions.map(s => [{
        text: `${s.status === 'waiting' ? '⏳' : '🟢'} ${s.name} — ${truncate(s.task || '—', 30)}`,
        callback_data: `session:${s.name}`,
      }]),
    },
  });
}

async function editToSessionList(query) {
  const sessions = listSessions();
  if (!sessions.length) {
    return bot.editMessageText('📭 No active sessions.',
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    ).catch(() => {});
  }
  const lines = sessions.map(s => {
    const icon = s.status === 'waiting' ? '⏳' : '🟢';
    return `${icon} \`${s.name}\` — ${s.task || '—'} _${formatAge(s.created)}_`;
  });
  await bot.editMessageText(lines.join('\n') + '\n\n_Tap a session to manage it:_', {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: sessions.map(s => [{
        text: `${s.status === 'waiting' ? '⏳' : '🟢'} ${s.name} — ${truncate(s.task || '—', 30)}`,
        callback_data: `session:${s.name}`,
      }]),
    },
  }).catch(() => {});
}

async function showSessionMenu(query, name) {
  const session = listSessions().find(s => s.name === name);
  const icon = session?.status === 'waiting' ? '⏳' : '🟢';
  await bot.editMessageText(
    `${icon} *${name}*\n_${session?.task || '—'}_ · ${formatAge(session?.created || Date.now())}`, {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📄 Output',  callback_data: `menu-output:${name}` },
          { text: '🔌 Connect', callback_data: `menu-connect:${name}` },
          { text: '🗑 Kill',    callback_data: `menu-kill:${name}` },
        ],
        [{ text: '← Back', callback_data: `menu-back:${name}` }],
      ],
    },
  }).catch(() => {});
}

async function sendOutput(name) {
  const output = captureOutput(name, 35);
  if (!output) return bot.sendMessage(chatId, `❌ No output for \`${name}\``, { parse_mode: 'Markdown' });
  await bot.sendMessage(chatId, `📄 *${name}*`, { parse_mode: 'Markdown' });
  await bot.sendMessage(chatId, output.slice(-4000));
}

async function doKill(name) {
  killSession(name);
  if (connectState.session === name) stopConnectPolling();
  broadcastFn({ type: 'session_killed', name });
  await bot.sendMessage(chatId, `🗑 Session \`${name}\` killed.`, { parse_mode: 'Markdown' });
}

export async function sendApprovalRequest(sessionName, promptText) {
  if (!bot || !chatId) return;
  const lines = promptText.split('\n');
  const cmdIdx = lines.findIndex(l => l.includes('$ '));
  const relevant = cmdIdx >= 0
    ? lines.slice(Math.max(0, cmdIdx - 1), cmdIdx + 4).join('\n')
    : lines.slice(-8).join('\n');
  await bot.sendMessage(chatId,
    `⏳ *Approval needed* — \`${sessionName}\`\n\n\`\`\`\n${relevant.slice(0, 600)}\n\`\`\``,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${sessionName}` },
        { text: '❌ Reject',  callback_data: `reject:${sessionName}` },
      ]]},
    }
  );
}

export async function sendNotification(text) {
  if (!bot || !chatId) return;
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

function formatAge(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}
