(() => {
  const TOKEN_KEY = 'codex_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let ws = null;
  let currentSession = null;
  // viewMode: 'chat' | 'markdown' | 'terminal'
  let viewMode = 'chat';
  let conversation = [];
  let lastChatKey = '';
  let lastMarkdownKey = '';
  let lastOutputText = '';
  let lastJsonlData = null;

  // --- Screens ---
  const screens = {
    login: document.getElementById('login-screen'),
    main: document.getElementById('main-screen'),
    session: document.getElementById('session-screen'),
  };

  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
  }

  // --- Auth ---
  document.getElementById('login-btn').addEventListener('click', tryLogin);
  document.getElementById('token-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') tryLogin();
  });

  async function tryLogin() {
    const input = document.getElementById('token-input').value.trim();
    if (!input) return;
    const res = await fetch('/api/sessions', { headers: { 'x-token': input } });
    if (res.ok) {
      token = input;
      localStorage.setItem(TOKEN_KEY, token);
      document.getElementById('login-error').classList.add('hidden');
      initApp();
    } else {
      document.getElementById('login-error').textContent = 'Invalid token';
      document.getElementById('login-error').classList.remove('hidden');
    }
  }

  // --- WebSocket ---
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}?token=${encodeURIComponent(token)}`);

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    });

    ws.addEventListener('close', () => {
      setTimeout(connectWS, 3000);
    });
  }

  function handleMessage(msg) {
    if (msg.type === 'connected') {
      const el = document.getElementById('server-version');
      if (el) el.textContent = `v20260524-1 · srv ${msg.version || '?'}`;
      // Re-subscribe after reconnect so output resumes without re-entering the session
      if (currentSession) {
        ws.send(JSON.stringify({ type: 'subscribe_output', session: currentSession }));
        fetchOutput(currentSession);
      }
    }
    if (msg.type === 'connected' || msg.type === 'sessions_update') {
      renderSessionList(msg.sessions);
    }
    if (msg.type === 'session_created') {
      renderSessionList(null);
    }
    if (msg.type === 'output' && msg.session === currentSession) {
      if (msg.conversation) {
        // Merge: server is authoritative for AI entries; preserve any pending
        // user messages that haven't been persisted on the server yet.
        const pending = conversation.filter(e =>
          e.role === 'user' && !msg.conversation.some(s => s.role === 'user' && s.text === e.text)
        );
        conversation = [...msg.conversation, ...pending];
        if (viewMode === 'chat') renderChat();
      }
      if (msg.jsonl) { lastJsonlData = msg.jsonl; if (viewMode === 'jsonl') renderJsonlView(msg.jsonl); }
      if (viewMode === 'markdown') renderMarkdownView(msg.output);
      renderOutput(msg.output);
      if (msg.questionnaire) showQuestionnaireBanner(msg.questionnaire);
      else hideQuestionnaireBanner();
    }
    if (msg.type === 'user_input' && msg.session === currentSession) {
      // Optimistic bubble already added locally; server broadcast is for other clients
    }
    if (msg.type === 'approval_needed' && msg.session === currentSession) {
      showApprovalBanner(msg.prompt);
    }
    if (msg.type === 'approval_response' && msg.session === currentSession) {
      hideApprovalBanner();
    }
    if (msg.type === 'session_resumable' && msg.session === currentSession) {
      showResumeBanner();
    }
    if (msg.type === 'session_resumed' && msg.session === currentSession) {
      hideResumeBanner();
    }
    if (msg.type === 'session_killed') {
      if (msg.name === currentSession) {
        history.replaceState({ screen: 'main' }, '');
        currentSession = null;
        showScreen('main');
      }
      refreshSessions();
    }
  }

  // --- Session list ---
  let _sessions = [];

  function renderSessionList(sessions) {
    if (sessions) _sessions = sessions;
    const list = document.getElementById('session-list');
    const empty = document.getElementById('empty-state');

    if (!_sessions.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    const sorted = [..._sessions].sort((a, b) => b.activity - a.activity);
    list.innerHTML = sorted.map(s => `
      <div class="session-card" data-name="${s.name}">
        <div class="status-dot ${s.status}"></div>
        <div class="info">
          <div class="name">${esc(s.name)} <span class="provider-badge">${esc(providerIcon(s.provider))}</span></div>
          <div class="task">${esc(s.task || '—')}</div>
        </div>
        <div class="session-age">${timeAgo(s.activity)}</div>
      </div>
    `).join('');

    list.querySelectorAll('.session-card').forEach(card => {
      card.addEventListener('click', () => openSession(card.dataset.name));
    });
  }

  async function refreshSessions() {
    const res = await api('GET', '/api/sessions');
    if (res) renderSessionList(res);
  }

  // --- Open session ---
  function openSession(name) {
    history.pushState({ screen: 'session', name }, '');
    currentSession = name;
    conversation = [];
    lastChatKey = '';
    lastOutputText = '';
    const session = _sessions.find(s => s.name === name);
    document.getElementById('session-title').textContent = name;
    const wdEl = document.getElementById('session-workdir');
    if (wdEl) wdEl.textContent = session?.workdir || '';
    document.getElementById('chat-view').innerHTML = '';
    document.getElementById('jsonl-view').innerHTML = '';
    document.getElementById('markdown-view').innerHTML = '';
    document.getElementById('output').textContent = '';
    lastJsonlData = null;
    showScreen('session');
    setViewMode('jsonl');

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe_output', session: name }));
    }

    fetchOutput(name);

    if (session?.pendingApproval) {
      showApprovalBanner(session.pendingApproval.text);
    } else {
      hideApprovalBanner();
    }
    if (session?.resumeId) {
      showResumeBanner();
    } else {
      hideResumeBanner();
    }
  }

  async function fetchOutput(name) {
    const res = await api('GET', `/api/sessions/${name}/output?lines=500`);
    if (!res) return;
    if (res.conversation) {
      conversation = res.conversation;
      if (viewMode === 'chat') renderChat();
    }
    if (res.jsonl) { lastJsonlData = res.jsonl; if (viewMode === 'jsonl') renderJsonlView(res.jsonl); }
    if (viewMode === 'markdown') renderMarkdownView(res.output);
    renderOutput(res.output);
  }

  // --- View mode: chat | markdown | terminal ---
  const VIEW_CYCLE = ['chat', 'jsonl', 'markdown', 'terminal'];
  const VIEW_ICONS = { chat: '⌨', jsonl: '✦', markdown: 'M↓', terminal: '💬' };
  const VIEW_TITLES = { chat: 'Switch to native view', jsonl: 'Switch to markdown view', markdown: 'Switch to terminal view', terminal: 'Switch to chat view' };

  function setViewMode(mode) {
    viewMode = mode;
    document.getElementById('chat-view').classList.toggle('hidden', mode !== 'chat');
    document.getElementById('jsonl-view').classList.toggle('hidden', mode !== 'jsonl');
    document.getElementById('markdown-view').classList.toggle('hidden', mode !== 'markdown');
    document.getElementById('output').classList.toggle('hidden', mode !== 'terminal');
    const btn = document.getElementById('view-toggle-btn');
    btn.textContent = VIEW_ICONS[mode];
    btn.title = VIEW_TITLES[mode];
    if (mode === 'chat') renderChat();
    if (mode === 'jsonl') renderJsonlView(lastJsonlData);
    if (mode === 'markdown' && lastOutputText) renderMarkdownView(lastOutputText);
  }

  document.getElementById('view-toggle-btn').addEventListener('click', () => {
    const next = VIEW_CYCLE[(VIEW_CYCLE.indexOf(viewMode) + 1) % VIEW_CYCLE.length];
    setViewMode(next);
  });

  function renderChat() {
    const key = conversation.map(e => e.role + e.text.length).join(',');
    if (key === lastChatKey) return;
    if (window.getSelection()?.toString()) return;
    lastChatKey = key;
    const el = document.getElementById('chat-view');
    const c = document.getElementById('output-container');
    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 60;

    el.innerHTML = conversation.map(entry => {
      const ts = entry.ts ? `<span class="bubble-time">${formatMsgTime(entry.ts)}</span>` : '';
      if (entry.role === 'user') {
        return `<div class="bubble user"><div class="bubble-text">${esc(entry.text)}${ts}</div></div>`;
      }
      return `<div class="bubble ai"><div class="bubble-text">${renderMarkdown(entry.text)}${ts}</div></div>`;
    }).join('');

    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  function renderMarkdown(text) {
    // Split on fenced code blocks first
    const parts = text.split(/(```[\s\S]*?```)/g);
    const html = parts.map((part, i) => {
      if (i % 2 === 1) {
        const inner = part.slice(3, -3).replace(/^[^\n]*\n/, '');
        return `<pre class="code-block"><code>${esc(inner)}</code></pre>`;
      }
      // Process prose: split into paragraphs, then handle block-level elements
      return part.split(/\n\n+/).map(para => {
        const lines = para.split('\n').filter(l => l.trim());
        if (!lines.length) return '';
        // Heading
        const hm = lines[0].match(/^(#{1,3})\s+(.+)/);
        if (hm && lines.length === 1) {
          const tag = 'h' + (hm[1].length + 2); // ## → h4, ### → h5
          return `<${tag} class="md-h">${esc(hm[2])}</${tag}>`;
        }
        // List (all lines start with - or * or number.)
        const isList = lines.every(l => /^\s*[-*]\s/.test(l) || /^\s*\d+\.\s/.test(l));
        if (isList) {
          const ordered = /^\s*\d+\.\s/.test(lines[0]);
          const tag = ordered ? 'ol' : 'ul';
          const items = lines.map(l => `<li>${inlineMarkdown(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))}</li>`).join('');
          return `<${tag} class="md-list">${items}</${tag}>`;
        }
        // Normal paragraph
        return `<p>${lines.map(inlineMarkdown).join('<br>')}</p>`;
      }).join('');
    }).join('');
    return html;
  }

  function inlineMarkdown(text) {
    return esc(text)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  }

  // --- Terminal view ---
  function renderOutput(text) {
    if (text === lastOutputText) return;
    if (window.getSelection()?.toString()) return;
    lastOutputText = text;
    const el = document.getElementById('output');
    const c = document.getElementById('output-container');
    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
    el.textContent = text;
    if (viewMode === 'terminal' && atBottom) c.scrollTop = c.scrollHeight;
  }

  // --- Markdown view ---
  // Extracts ● response blocks from raw tmux output, strips noise, renders as
  // markdown, and interleaves user messages from the conversation array.
  function renderMarkdownView(rawOutput) {
    const key = rawOutput.length + rawOutput.slice(-40);
    if (key === lastMarkdownKey) return;
    if (window.getSelection()?.toString()) return;
    lastMarkdownKey = key;

    const el = document.getElementById('markdown-view');
    const c = document.getElementById('output-container');
    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 60;

    const clean = rawOutput.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');

    const NOISE = [
      /^\s*❯/, /Claude Code v[\d.]+/, /(?:Sonnet|Opus|Haiku).*·/, /▐▛|▝▜|▘▘/,
      /[✻✽✢✶✸]/, /^\s*[*·] \S[\S ]*[….]? \(\d+[ms]/,
      /^\s*[*·] [A-Z]\S*ing[\.…]?(\s*\(\d[^)]*\))?\s*$/,
      /⏵⏵ bypass permissions/, /^─{5,}/, /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
      /\b(low|medium|high)\s*·\s*\/effort/, /^\s*⎿/,
      /^\s+(?:Read|Ran|Listed|Wrote|Written|Edited|Created|Deleted|Fetched|Searched|Committed|Updated|Removed|Copied|Moved)\s+\d/,
      /^\s+Committed\s+[0-9a-f]{6,}/, /ctrl\+b.*background/, /\/clear to start fresh/,
      /^\s+(?:Fetch|Web Search|WebSearch)\(/, /^\s{2,}[A-Z][a-z]+ing (?:for )?\d/,
      /^main\s{5,}/, /◯\s+general-purpose/, /↑\/↓ to select/,
      /·\s*↓\s*\d+\.?\d*k tokens/, /%\s*until auto-compact/,
    ];

    // Collect prose blocks from tmux output
    const blocks = []; // { text: string }
    let blockLines = null;

    for (const line of clean.split('\n')) {
      if (/^\s*●\s/.test(line)) {
        if (blockLines !== null) blocks.push(blockLines.join('\n').trim());
        const text = line.replace(/^\s*●\s*/, '').replace(/\s*…\s*\(\d[^)]*\)\s*$/, '');
        if (/^(?:[A-Z][a-zA-Z]+[·(]|How is Claude doing)/.test(text) || /^main\s{5,}/.test(text)) {
          blockLines = null;
        } else {
          blockLines = text.trim() ? [text] : [];
        }
        continue;
      }
      if (/^❯/.test(line) || /^─{5,}/.test(line)) {
        if (blockLines !== null) blocks.push(blockLines.join('\n').trim());
        blockLines = null;
        continue;
      }
      if (blockLines === null) continue;
      if (NOISE.some(p => p.test(line))) continue;
      blockLines.push(line.replace(/\s*…\s*\(\d[^)]*\)\s*$/, ''));
    }
    if (blockLines !== null) blocks.push(blockLines.join('\n').trim());

    // Use conversation array for correct ordering (user + ai interleaved).
    // For AI entries, prefer the tmux-extracted block at the same position
    // (latest capture, noise-stripped) — fall back to conversation text.
    const aiBlocks = blocks.filter(Boolean);
    let aiIdx = 0;
    const sections = conversation.map(entry => {
      const ts = entry.ts ? `<span class="md-ts">${formatMsgTime(entry.ts)}</span>` : '';
      if (entry.role === 'user') {
        return `<div class="md-user">${esc(entry.text)}${ts}</div>`;
      }
      const text = aiBlocks[aiIdx] || entry.text;
      aiIdx++;
      return `<div class="md-ai">${renderMarkdown(text)}${ts}</div>`;
    });

    el.innerHTML = `<div class="md-content">${sections.join('')}</div>`;
    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  // --- JSONL view (native Claude conversation from ~/.claude/projects/) ---
  function renderJsonlView(data) {
    const el = document.getElementById('jsonl-view');

    // Skip re-render while user has text selected inside this view — avoids
    // the 2-second polling loop destroying the selection mid-copy.
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0 && el.contains(sel.anchorNode)) return;

    const c = document.getElementById('output-container');
    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 60;

    if (!data) {
      el.innerHTML = '<div class="jsonl-unavail">No JSONL data — Claude sessions only</div>';
      return;
    }

    const { conv, status } = data;

    const bubbles = conv.map(entry => {
      const ts = entry.ts ? `<span class="bubble-time">${formatMsgTime(entry.ts)}</span>` : '';
      if (entry.role === 'user') {
        return `<div class="bubble user"><div class="bubble-text">${esc(entry.text)}${ts}</div></div>`;
      }
      const toolsHtml = entry.tools?.length
        ? `<div class="jsonl-tools">${entry.tools.map(t => `<span class="jsonl-tool">${esc(t.name)}</span>`).join('')}</div>`
        : '';
      return `<div class="bubble ai"><div class="bubble-text">${renderMarkdown(entry.text)}${toolsHtml}${ts}</div></div>`;
    }).join('');

    const statusHtml = status === 'thinking'
      ? '<div class="jsonl-status">Thinking…</div>'
      : status === 'working'
        ? '<div class="jsonl-status">Working…</div>'
        : '';

    el.innerHTML = bubbles + statusHtml;
    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  // --- Questionnaire banner ---
  const qBanner = document.getElementById('questionnaire-banner');
  const qQuestion = document.getElementById('questionnaire-question');
  const qOptions = document.getElementById('questionnaire-options');

  let activeQuestionnaire = null;

  function showQuestionnaireBanner(q) {
    activeQuestionnaire = q;
    qQuestion.textContent = q.question || '';
    // Only render numbered/checkbox options — not Next/navigation items
    qOptions.innerHTML = q.items
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => !item.isNext && !item.afterSep)
      .map(({ item, idx }) => {
        const cls = ['q-opt-btn', item.hasCheckbox && item.checked ? 'q-checked' : ''].filter(Boolean).join(' ');
        const prefix = item.hasCheckbox ? (item.checked ? '✔ ' : '○ ') : '';
        return `<button class="${cls}" data-idx="${idx}">${prefix}${item.label}</button>`;
      }).join('') +
      `<button class="q-opt-btn q-next" data-submit="1">Submit</button>`;
    qBanner.classList.remove('hidden');
  }

  function hideQuestionnaireBanner() {
    activeQuestionnaire = null;
    qBanner.classList.add('hidden');
  }

  qOptions.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-idx], [data-submit]');
    if (!btn) return;
    if (btn.dataset.submit) {
      // Find the Next item index (for navigation) or default past all items
      const nextIdx = activeQuestionnaire
        ? activeQuestionnaire.items.findIndex(item => item.isNext)
        : -1;
      const targetIdx = nextIdx >= 0 ? nextIdx : (activeQuestionnaire ? activeQuestionnaire.items.length : 5);
      await api('POST', `/api/sessions/${currentSession}/questionnaire`, { targetIdx });
    } else {
      await api('POST', `/api/sessions/${currentSession}/questionnaire`, { targetIdx: parseInt(btn.dataset.idx) });
    }
  });

  // --- Approval banner ---
  function showApprovalBanner(promptText) {
    const banner = document.getElementById('approval-banner');
    document.getElementById('approval-text').textContent = promptText.slice(-400);
    banner.classList.remove('hidden');
  }

  function hideApprovalBanner() {
    document.getElementById('approval-banner').classList.add('hidden');
  }

  // --- Resume banner ---
  function showResumeBanner() {
    document.getElementById('resume-banner').classList.remove('hidden');
  }
  function hideResumeBanner() {
    document.getElementById('resume-banner').classList.add('hidden');
  }
  document.getElementById('resume-btn').addEventListener('click', async () => {
    hideResumeBanner();
    await api('POST', `/api/sessions/${currentSession}/resume`);
  });

  document.getElementById('approve-btn').addEventListener('click', () => sendApproval(true));
  document.getElementById('reject-btn').addEventListener('click', () => sendApproval(false));

  async function sendApproval(approved) {
    await api('POST', `/api/sessions/${currentSession}/approve`, { approved });
    hideApprovalBanner();
  }

  // --- Input bar ---
  const inputEl = document.getElementById('input-text');
  document.getElementById('send-btn').addEventListener('click', sendInput);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendInput(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = inputEl.scrollHeight + 'px';
  });

  async function sendInput() {
    const input = document.getElementById('input-text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';

    // Optimistic: add user bubble immediately
    if (viewMode === 'chat') {
      conversation.push({ role: 'user', text });
      renderChat();
    }

    await api('POST', `/api/sessions/${currentSession}/input`, { text, enter: true });
  }

  // --- File upload ---
  const uploadBtn = document.getElementById('upload-btn');
  const uploadInput = document.getElementById('upload-input');

  uploadBtn.addEventListener('click', () => {
    if (!currentSession) return;
    uploadInput.click();
  });

  uploadInput.addEventListener('change', async () => {
    const files = [...uploadInput.files];
    if (!files.length) return;
    uploadInput.value = '';

    const paths = [];
    const errors = [];
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await fetch(`/api/sessions/${currentSession}/upload`, {
          method: 'POST',
          headers: { 'x-token': token },
          body: form,
        });
        if (res.ok) {
          const data = await res.json();
          paths.push(data.path);
        } else {
          const data = await res.json().catch(() => ({}));
          errors.push(`${file.name}: ${data.error || res.status}`);
        }
      } catch (err) {
        errors.push(`${file.name}: network error`);
      }
    }

    if (errors.length) {
      alert('Upload failed:\n' + errors.join('\n'));
    }

    const input = document.getElementById('input-text');
    const sep = input.value.trim() ? '\n' : '';
    input.value = input.value.trimEnd() + sep + paths.join('\n');
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    input.focus();
  });

  // --- Kill session ---
  const killSheet = document.getElementById('kill-sheet');
  document.getElementById('kill-btn').addEventListener('click', () => {
    document.getElementById('kill-sheet-name').textContent = `"${currentSession}" will be destroyed and cannot be recovered.`;
    killSheet.classList.remove('hidden');
  });
  document.getElementById('kill-cancel-btn').addEventListener('click', () => {
    killSheet.classList.add('hidden');
  });
  document.getElementById('kill-confirm-btn').addEventListener('click', async () => {
    killSheet.classList.add('hidden');
    await api('DELETE', `/api/sessions/${currentSession}`);
    history.replaceState({ screen: 'main' }, '');
    currentSession = null;
    showScreen('main');
    refreshSessions();
  });
  killSheet.addEventListener('click', (e) => {
    if (e.target === killSheet) killSheet.classList.add('hidden');
  });

  // --- Back ---
  document.getElementById('back-btn').addEventListener('click', () => history.back());

  window.addEventListener('popstate', (e) => {
    if (e.state?.screen === 'main' && currentSession) {
      currentSession = null;
      showScreen('main');
      refreshSessions();
    }
  });

  // --- New session modal ---
  document.getElementById('new-session-btn').addEventListener('click', openModal);
  document.getElementById('empty-new-btn').addEventListener('click', openModal);
  document.getElementById('ns-cancel').addEventListener('click', closeModal);
  document.getElementById('ns-create').addEventListener('click', createSession);

  function openModal() {
    document.getElementById('ns-name').value = '';
    document.getElementById('ns-workdir').value = '';
    document.getElementById('new-session-modal').classList.remove('hidden');
    document.getElementById('ns-name').focus();
  }

  function closeModal() {
    document.getElementById('new-session-modal').classList.add('hidden');
  }

  async function createSession() {
    const name = document.getElementById('ns-name').value.trim();
    const workdir = document.getElementById('ns-workdir').value.trim();
    const provider = document.getElementById('ns-provider').value;
    if (!name) return;
    closeModal();
    const res = await api('POST', '/api/sessions', { name, provider, workdir: workdir || undefined });
    if (res) {
      await refreshSessions();
      openSession(name);
    }
  }

  // --- Load session modal ---
  let loadDirs = [];
  let loadSelectedPath = null;

  document.getElementById('load-session-btn').addEventListener('click', openLoadModal);
  document.getElementById('ls-cancel').addEventListener('click', closeLoadModal);
  document.getElementById('ls-load').addEventListener('click', doLoadSession);
  document.getElementById('load-session-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('load-session-modal')) closeLoadModal();
  });

  document.getElementById('ls-custom-path').addEventListener('input', () => {
    loadSelectedPath = null;
    document.querySelectorAll('.ls-dir-item').forEach(el => el.classList.remove('selected'));
  });

  async function openLoadModal() {
    loadSelectedPath = null;
    document.getElementById('ls-custom-path').value = '';
    const listEl = document.getElementById('ls-dir-list');
    listEl.innerHTML = '<span style="color:var(--muted);font-size:.85rem;padding:.25rem .25rem">Loading…</span>';
    document.getElementById('load-session-modal').classList.remove('hidden');

    const dirs = await api('GET', '/api/agents');
    loadDirs = dirs || [];
    if (!loadDirs.length) {
      listEl.innerHTML = '<span style="color:var(--muted);font-size:.85rem;padding:.25rem .25rem">No workspaces found</span>';
      return;
    }
    listEl.innerHTML = loadDirs.map((d, i) =>
      `<button class="ls-dir-item" data-idx="${i}">📁 ${esc(d.name)}</button>`
    ).join('');
    listEl.querySelectorAll('.ls-dir-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = loadDirs[parseInt(btn.dataset.idx)];
        loadSelectedPath = d.path;
        document.getElementById('ls-custom-path').value = '';
        listEl.querySelectorAll('.ls-dir-item').forEach(el => el.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
  }

  function closeLoadModal() {
    document.getElementById('load-session-modal').classList.add('hidden');
    loadSelectedPath = null;
  }

  async function doLoadSession() {
    const customPath = document.getElementById('ls-custom-path').value.trim();
    const workdir = customPath || loadSelectedPath;
    if (!workdir) return;
    const provider = document.getElementById('ls-provider').value;
    const name = workdir.split('/').pop().replace(/\s+/g, '-');
    const dir = loadDirs.find(d => d.path === workdir);
    let task = `You are resuming work in ${workdir}.`;
    task += dir?.contextFile
      ? ` Start by reading ${dir.contextFile} for project context, then wait for instructions.`
      : ` Start by briefly reviewing the directory structure, then wait for instructions.`;
    closeLoadModal();
    const res = await api('POST', '/api/sessions', { name, task, provider, workdir });
    if (res) {
      await refreshSessions();
      openSession(name);
    }
  }

  // --- Helpers ---
  async function api(method, path, body) {
    try {
      const res = await fetch(path, {
        method,
        headers: { 'x-token': token, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  function formatMsgTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return hm;
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm;
  }

  function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  const PROVIDER_ICONS = { codex: '⚡', claude: '🟣', gemini: '✨' };
  function providerIcon(p) { return PROVIDER_ICONS[p] || '⚡'; }

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Init ---
  function initApp() {
    history.replaceState({ screen: 'main' }, '');
    showScreen('main');
    refreshSessions();
    connectWS();
  }

  if (token) {
    initApp();
  } else {
    showScreen('login');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWS();
    } else if (currentSession) {
      fetchOutput(currentSession);
    }
    if (currentSession === null) refreshSessions();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  let installPrompt = null;
  const installBtn = document.getElementById('install-btn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    installBtn.classList.remove('hidden');
  });
  installBtn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') installBtn.classList.add('hidden');
    installPrompt = null;
  });
  window.addEventListener('appinstalled', () => installBtn.classList.add('hidden'));
})();
