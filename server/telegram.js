import { execSync } from 'child_process';
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
  polling: false,       // guard against overlapping async ticks
  pendingQuestion: null, // active Claude questionnaire waiting for user's number
};

// Parse Claude Code's interactive questionnaire TUI from raw tmux output.
// Returns { question, options: [{text, desc}], currentIndex } or null.
function parseClaudeQuestion(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (!/Enter to select.*Tab.*Arrow keys.*navigate/i.test(clean)) return null;

  const lines = clean.split('\n');
  const footerIdx = lines.findIndex(l => /Enter to select.*Tab.*Arrow keys.*navigate/i.test(l));
  if (footerIdx < 0) return null;

  // The questionnaire block starts at the breadcrumb nav bar (← ☐/☒ ... →)
  // Scan backwards from the footer to find it
  const breadcrumbIdx = lines.slice(0, footerIdx).reduce((found, line, i) =>
    /[←].*[☐☒]/.test(line) ? i : found, -1);
  if (breadcrumbIdx < 0) return null;

  const options = [];
  let currentIndex = 0;
  let questionLines = [];
  let inOptions = false;

  for (let i = breadcrumbIdx + 1; i < footerIdx; i++) {
    const line = lines[i];
    if (/^─{5,}/.test(line)) { inOptions = false; continue; }

    const optMatch = line.match(/^\s*([❯ ])\s*(\d+)\.\s+(.*)/);
    if (optMatch) {
      inOptions = true;
      if (optMatch[1] === '❯') currentIndex = options.length;
      options.push({ text: optMatch[3].trim(), desc: '' });
      continue;
    }

    if (inOptions && options.length > 0 && /^\s{4,}/.test(line) && line.trim()) {
      const last = options[options.length - 1];
      last.desc = (last.desc ? last.desc + ' ' : '') + line.trim();
      continue;
    }

    if (!inOptions && line.trim()) {
      questionLines.push(line.trim());
    }
  }

  if (options.length < 2) return null;
  const question = questionLines.filter(Boolean).join(' ').trim();
  return question ? { question, options, currentIndex } : null;
}

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

    // Pending /new: user is supplying just a session name
    if (pendingNew.provider) {
      const name = msg.text.trim().replace(/\s+/g, '-');
      const provider = pendingNew.provider;
      const prov = getProvider(provider);
      pendingNew.provider = null;
      if (pendingNew.messageId) {
        await bot.editMessageText(
          `${prov.icon} *${prov.label}* · \`${name}\` starting…`,
          { chat_id: chatId, message_id: pendingNew.messageId, parse_mode: 'Markdown' }
        ).catch(() => {});
        pendingNew.messageId = null;
      }
      createSession(name, null, provider);
      broadcastFn({ type: 'session_created', session: { name, provider } });
      // Auto-connect so you can start typing immediately
      setTimeout(() => startConnect(name).catch(() => {}), 2000);
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

    const name = remainder.trim().replace(/\s+/g, '-');
    if (!name)
      return bot.sendMessage(chatId,
        'Usage: `/new name` or `/new claude name`',
        { parse_mode: 'Markdown' });
    const prov = getProvider(provider);
    createSession(name, null, provider);
    broadcastFn({ type: 'session_created', session: { name, provider } });
    setTimeout(() => startConnect(name).catch(() => {}), 2000);
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
      '`/new name` — start a Codex session',
      '`/new claude name` — start a Claude session',
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
        `${prov.icon} *${prov.label}* selected\n\nSend a session name:`,
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

    if (action === 'question-answer') {
      const targetIdx = parseInt(payload, 10);
      const pq = connectState.pendingQuestion;
      if (pq && connectState.session && targetIdx >= 0 && targetIdx < pq.options.length) {
        const delta = targetIdx - pq.currentIndex;
        const key = delta >= 0 ? 'Down' : 'Up';
        for (let i = 0; i < Math.abs(delta); i++) {
          execSync(`tmux send-keys -t ${connectState.session} ${key}`, { encoding: 'utf8' });
        }
        execSync(`tmux send-keys -t ${connectState.session} Enter`, { encoding: 'utf8' });
        const chosen = pq.options[targetIdx];
        await bot.editMessageText(
          `✅ *${pq.question}*\n\n→ ${chosen.text}`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
        ).catch(() => {});
        connectState.pendingQuestion = null;
      }
      return;
    }

    if (action === 'menu-back') await editToSessionList(query);

    if (action === 'do-disconnect') await disconnect('Disconnected.');
  }));

  bot.on('polling_error', (err) => {
    console.error('[telegram] polling error:', err.message);
  });

  bot.setMyCommands([
    { command: 'list',       description: 'Browse active sessions' },
    { command: 'new',        description: 'Start a session: /new name or pick provider' },
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
  const filterNoise = (r) =>
    r.split('\n').filter(line => !prov.noisePatterns.some(p => p.test(line))).join('\n').trim();
  const existingResponses = prov.extractResponses(existing).map(filterNoise).filter(Boolean);
  connectState.sentResponses = new Set(existingResponses.map(r => r.trim()));

  // Send last response separately so its message_id is tracked for edit-in-place;
  // older context is sent first as a single non-tracked message.
  const olderSnapshot = existingResponses.slice(-3, -1).join('\n\n').trim();
  if (olderSnapshot) await bot.sendMessage(chatId, olderSnapshot).catch(() => {});
  const lastExisting = existingResponses.at(-1);
  if (lastExisting) {
    const snapMsg = await bot.sendMessage(chatId, lastExisting).catch(() => null);
    if (snapMsg) {
      connectState.lastResponseMsgId = snapMsg.message_id;
      connectState.lastResponseText = lastExisting;
    }
  }

  connectState.session = name;
  connectState.messageId = sent.message_id;

  connectState.interval = setInterval(async () => {
    if (!connectState.session) return;
    // Guard against overlapping async ticks — if previous tick is still awaiting
    // network calls, skip this tick rather than racing to send duplicate messages.
    if (connectState.polling) return;
    connectState.polling = true;
    try {
      const currentSession = listSessions().find(s => s.name === connectState.session);
      const currentProv = getProvider(currentSession?.provider);

      const fresh = captureOutput(connectState.session, 500) || '';
      if (!fresh) return;

      const allResponses = currentProv.extractResponses(fresh).map(r =>
        r.split('\n')
         .filter(line => !currentProv.noisePatterns.some(p => p.test(line)))
         .join('\n').trim()
      ).filter(Boolean);

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

      // Detect Claude interactive questionnaire (not a ●-prefixed response)
      if (currentProv === getProvider('claude')) {
        const q = parseClaudeQuestion(fresh);
        if (q && !connectState.pendingQuestion) {
          const questionKey = 'q:' + q.question;
          if (!connectState.sentResponses.has(questionKey)) {
            connectState.sentResponses.add(questionKey);
            connectState.pendingQuestion = { ...q, questionKey };
            const optLines = q.options.map((o, i) =>
              `*${i + 1}.* ${o.text}${o.desc ? `\n_${o.desc}_` : ''}`
            ).join('\n\n');
            // One button per option — tap to select, no typing needed
            const keyboard = q.options.map((o, i) => [{
              text: `${i + 1}. ${o.text}`,
              callback_data: `question-answer:${i}`,
            }]);
            const qMsg = await bot.sendMessage(
              chatId,
              `❓ *${q.question}*\n\n${optLines}`,
              { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
            ).catch(() => null);
            if (qMsg) connectState.pendingQuestion.messageId = qMsg.message_id;
          }
        } else if (!q && connectState.pendingQuestion) {
          // Question dismissed (user answered in-app or it disappeared)
          connectState.pendingQuestion = null;
        }
      }
    } finally {
      connectState.polling = false;
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
  connectState.polling = false;
  connectState.pendingQuestion = null;
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
