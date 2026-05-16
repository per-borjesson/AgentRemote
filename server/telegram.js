import TelegramBot from 'node-telegram-bot-api';
import { respondToApproval, listSessions, createSession, killSession, captureOutput, sendKeys } from './sessions.js';
import { PROVIDERS, getProvider, DEFAULT_PROVIDER } from './providers.js';

let bot = null;
let chatId = null;
let broadcastFn = null;

const connectState = {
  session: null,
  messageId: null,      // the disconnect button message
  interval: null,
  sentResponses: new Set(),
  lastResponseMsgId: null,
  lastResponseText: null,
};

// State for the /new provider-picker flow
const pendingNew = {
  provider: null,
  messageId: null,
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

  // Passthrough when connected — or capture name|task after provider picker
  bot.on('message', guard(async (msg) => {
    if (!isAuthorized(msg)) return;
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return;

    // Pending /new: user is supplying "name | task"
    if (pendingNew.provider) {
      const parts = msg.text.split('|');
      if (parts.length < 2) {
        return bot.sendMessage(chatId, 'Please use format: `name | task description`', { parse_mode: 'Markdown' });
      }
      const name = parts[0].trim().replace(/\s+/g, '-');
      const task = parts.slice(1).join('|').trim();
      const provider = pendingNew.provider;
      const prov = getProvider(provider);
      pendingNew.provider = null;
      if (pendingNew.messageId) {
        await bot.editMessageText(
          `${prov.icon} *${prov.label}* session \`${name}\` starting…\n_${task}_`,
          { chat_id: chatId, message_id: pendingNew.messageId, parse_mode: 'Markdown' }
        ).catch(() => {});
        pendingNew.messageId = null;
      }
      createSession(name, task, provider);
      broadcastFn({ type: 'session_created', session: { name, task, provider } });
      return;
    }

    if (connectState.session) sendKeys(connectState.session, msg.text, true);
  }));

  // /list
  bot.onText(/^\/list$/, guard(async (msg) => {
    if (!isAuthorized(msg)) return;
    await sendSessionList();
  }));

  // /new — no args → provider picker; with args → create codex session (backward compat)
  // Also: /new <provider> name | task
  bot.onText(/^\/new(.*)$/, guard(async (msg, match) => {
    if (!isAuthorized(msg)) return;
    const rest = match[1].trim();

    if (!rest) {
      // Show provider picker
      const sent = await bot.sendMessage(chatId, 'Choose AI provider:', {
        reply_markup: {
          inline_keyboard: [
            Object.entries(PROVIDERS).map(([key, p]) => ({
              text: `${p.icon} ${p.label}`,
              callback_data: `new-provider:${key}`,
            })),
          ],
        },
      });
      pendingNew.messageId = sent.message_id;
      return;
    }

    // Check if first word is a known provider key
    const words = rest.split(/\s+/);
    let provider = DEFAULT_PROVIDER;
    let remainder = rest;
    if (PROVIDERS[words[0]]) {
      provider = words[0];
      remainder = rest.slice(words[0].length).trim();
    }

    const parts = remainder.split('|');
    if (parts.length < 2)
      return bot.sendMessage(chatId,
        'Usage: `/new name | task` or `/new claude name | task`',
        { parse_mode: 'Markdown' });
    const name = parts[0].trim().replace(/\s+/g, '-');
    const task = parts.slice(1).join('|').trim();
    const prov = getProvider(provider);
    createSession(name, task, provider);
    broadcastFn({ type: 'session_created', session: { name, task, provider } });
    await bot.sendMessage(chatId,
      `${prov.icon} *${prov.label}* session \`${name}\` started\n_${task}_`,
      { parse_mode: 'Markdown' });
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
    const providerList = Object.values(PROVIDERS).map(p => `${p.icon} ${p.label}`).join(', ');
    await bot.sendMessage(chatId, [
      '*AgentRemote*',
      '',
      '`/list` — browse sessions',
      '`/new` — start a session (provider picker)',
      '`/new name | task` — start a Codex session',
      '`/new claude name | task` — start a Claude session',
      '`/output [name]` — get latest output',
      '`/send name | text` — send input',
      '`/kill [name]` — kill a session',
      '`/disconnect` — exit connect mode',
      '',
      `_Providers: ${providerList}_`,
    ].join('\n'), { parse_mode: 'Markdown' });
  }));

  // Inline buttons
  bot.on('callback_query', guard(async (query) => {
    if (String(query.from.id) !== String(chatId)) return;
    await bot.answerCallbackQuery(query.id);

    const colonIdx = query.data.indexOf(':');
    const action = colonIdx >= 0 ? query.data.slice(0, colonIdx) : query.data;
    const payload = colonIdx >= 0 ? query.data.slice(colonIdx + 1) : '';

    if (action === 'new-provider') {
      const prov = getProvider(payload);
      pendingNew.provider = payload;
      pendingNew.messageId = query.message.message_id;
      await bot.editMessageText(
        `${prov.icon} *${prov.label}* selected\n\nNow send: \`session-name | task description\``,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
      return;
    }

    if (action === 'approve' || action === 'reject') {
      const approved = action === 'approve';
      respondToApproval(payload, approved);
      broadcastFn({ type: 'approval_response', session: payload, approved });
      await bot.editMessageText(
        `${approved ? '✅ Approved' : '❌ Rejected'} — \`${payload}\``,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    }

    if (action === 'session') await showSessionMenu(query, payload);

    if (action === 'menu-output') {
      await sendOutput(payload);
      await bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
    }

    if (action === 'menu-connect') {
      await bot.deleteMessage(query.message.chat.id, query.message.message_id).catch(() => {});
      await startConnect(payload);
    }

    if (action === 'menu-kill') {
      await doKill(payload);
      await bot.editMessageText(`🗑 Session \`${payload}\` killed.`,
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
    { command: 'new',        description: 'Start a session (shows provider picker)' },
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

  const session = listSessions().find(s => s.name === name);
  const prov = getProvider(session?.provider);

  const sent = await bot.sendMessage(
    chatId,
    `🔌 *Connected to \`${name}\`* ${prov.icon}\n_Type any message to send. Tap Disconnect to exit._`,
    { parse_mode: 'Markdown', reply_markup: disconnectMarkup(name) }
  );

  // Snapshot existing responses so we don't re-send them on connect
  const existing = captureOutput(name, 500) || '';
  const existingResponses = prov.extractResponses(existing);
  connectState.sentResponses = new Set(existingResponses.map(r => r.trim()));

  // Send last 3 responses as context
  const snapshot = existingResponses.slice(-3).join('\n\n').trim();
  if (snapshot) await bot.sendMessage(chatId, snapshot).catch(() => {});

  connectState.session = name;
  connectState.messageId = sent.message_id;

  connectState.interval = setInterval(async () => {
    if (!connectState.session) return;

    const currentSession = listSessions().find(s => s.name === connectState.session);
    const currentProv = getProvider(currentSession?.provider);

    const fresh = captureOutput(connectState.session, 500) || '';
    if (!fresh) return;

    const allResponses = currentProv.extractResponses(fresh);
    for (const r of allResponses) {
      const text = r.trim();
      if (connectState.sentResponses.has(text)) continue;

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
        const sent = await bot.sendMessage(chatId, text).catch(e => {
          console.error('[poll] send error:', e.message);
          return null;
        });
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

function disconnectMarkup(name) {
  return { inline_keyboard: [[{ text: '⏹ Disconnect', callback_data: `do-disconnect:${name}` }]] };
}

// --- Helpers ---

function sessionIcon(s) {
  const prov = getProvider(s.provider);
  const statusIcon = s.status === 'waiting' ? '⏳' : prov.icon;
  return statusIcon;
}

async function sendSessionList() {
  const sessions = listSessions();
  if (!sessions.length) return bot.sendMessage(chatId, '📭 No active sessions.');
  const lines = sessions.map(s =>
    `${sessionIcon(s)} \`${s.name}\` — ${s.task || '—'} _${formatAge(s.created)}_`
  );
  await bot.sendMessage(chatId, lines.join('\n') + '\n\n_Tap a session to manage it:_', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: sessions.map(s => [{
        text: `${sessionIcon(s)} ${s.name} — ${truncate(s.task || '—', 28)}`,
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
  const lines = sessions.map(s =>
    `${sessionIcon(s)} \`${s.name}\` — ${s.task || '—'} _${formatAge(s.created)}_`
  );
  await bot.editMessageText(lines.join('\n') + '\n\n_Tap a session to manage it:_', {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: sessions.map(s => [{
        text: `${sessionIcon(s)} ${s.name} — ${truncate(s.task || '—', 28)}`,
        callback_data: `session:${s.name}`,
      }]),
    },
  }).catch(() => {});
}

async function showSessionMenu(query, name) {
  const session = listSessions().find(s => s.name === name);
  const prov = getProvider(session?.provider);
  const icon = session?.status === 'waiting' ? '⏳' : prov.icon;
  await bot.editMessageText(
    `${icon} *${name}* [${prov.label}]\n_${session?.task || '—'}_ · ${formatAge(session?.created || Date.now())}`, {
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
  const session = listSessions().find(s => s.name === sessionName);
  const prov = getProvider(session?.provider);
  const lines = promptText.split('\n');
  const cmdIdx = lines.findIndex(l => l.includes('$ '));
  const relevant = cmdIdx >= 0
    ? lines.slice(Math.max(0, cmdIdx - 1), cmdIdx + 4).join('\n')
    : lines.slice(-8).join('\n');
  await bot.sendMessage(chatId,
    `⏳ *Approval needed* — \`${sessionName}\` ${prov.icon}\n\n\`\`\`\n${relevant.slice(0, 600)}\n\`\`\``,
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
