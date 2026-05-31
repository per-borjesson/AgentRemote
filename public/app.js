(() => {
  const TOKEN_KEY = 'codex_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let ws = null;
  let currentSession = null;
  let chatMode = true;
  let conversation = [];
  let lastChatKey = '';
  let lastOutputText = '';

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
        if (chatMode) renderChat();
      }
      renderOutput(msg.output);
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
    document.getElementById('output').textContent = '';
    showScreen('session');
    setChatMode(true);

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
    const res = await api('GET', `/api/sessions/${name}/output?lines=300`);
    if (!res) return;
    if (res.conversation) {
      conversation = res.conversation;
      if (chatMode) renderChat();
    }
    renderOutput(res.output);
  }

  // --- Chat view ---
  function setChatMode(on) {
    chatMode = on;
    document.getElementById('chat-view').classList.toggle('hidden', !on);
    document.getElementById('output').classList.toggle('hidden', on);
    const btn = document.getElementById('view-toggle-btn');
    btn.textContent = on ? '⌨' : '💬';
    btn.title = on ? 'Switch to terminal view' : 'Switch to chat view';
    if (on) renderChat();
  }

  document.getElementById('view-toggle-btn').addEventListener('click', () => setChatMode(!chatMode));

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
    // Split on fenced code blocks, process each part separately
    const parts = text.split(/(```[\s\S]*?```)/g);
    const html = parts.map((part, i) => {
      if (i % 2 === 1) {
        const inner = part.slice(3, -3).replace(/^[^\n]*\n/, '');
        return `<pre class="code-block"><code>${esc(inner)}</code></pre>`;
      }
      return esc(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n\n+/g, '</p><p>')
        .replace(/\n/g, '<br>');
    }).join('');
    return `<p>${html}</p>`;
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
    if (!chatMode && atBottom) c.scrollTop = c.scrollHeight;
  }

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
    if (chatMode) {
      conversation.push({ role: 'user', text });
      renderChat();
    }

    await api('POST', `/api/sessions/${currentSession}/input`, { text, enter: true });
  }

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
