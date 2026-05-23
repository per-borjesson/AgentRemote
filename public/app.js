(() => {
  const TOKEN_KEY = 'codex_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let ws = null;
  let currentSession = null;
  let outputPollTimer = null;

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
    if (msg.type === 'connected' || msg.type === 'sessions_update') {
      renderSessionList(msg.sessions);
    }
    if (msg.type === 'session_created') {
      renderSessionList(null); // will refetch
    }
    if (msg.type === 'output' && msg.session === currentSession) {
      renderOutput(msg.output);
    }
    if (msg.type === 'approval_needed' && msg.session === currentSession) {
      showApprovalBanner(msg.prompt);
    }
    if (msg.type === 'approval_response' && msg.session === currentSession) {
      hideApprovalBanner();
    }
    if (msg.type === 'session_killed') {
      if (msg.name === currentSession) showScreen('main');
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
    list.innerHTML = _sessions.map(s => `
      <div class="session-card" data-name="${s.name}">
        <div class="status-dot ${s.status}"></div>
        <div class="info">
          <div class="name">${esc(s.name)} <span class="provider-badge">${esc(providerIcon(s.provider))}</span></div>
          <div class="task">${esc(s.task || '—')}</div>
        </div>
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
    currentSession = name;
    const session = _sessions.find(s => s.name === name);
    document.getElementById('session-title').textContent = name;
    const wdEl = document.getElementById('session-workdir');
    if (wdEl) wdEl.textContent = session?.workdir || '';
    document.getElementById('output').textContent = '';
    showScreen('session');

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe_output', session: name }));
    }

    fetchOutput(name);

    if (session?.pendingApproval) {
      showApprovalBanner(session.pendingApproval.text);
    } else {
      hideApprovalBanner();
    }
  }

  async function fetchOutput(name) {
    const res = await api('GET', `/api/sessions/${name}/output?lines=200`);
    if (res) renderOutput(res.output);
  }

  function renderOutput(text) {
    const el = document.getElementById('output');
    const atBottom = isScrolledToBottom();
    el.textContent = text;
    if (atBottom) scrollToBottom();
  }

  function isScrolledToBottom() {
    const c = document.getElementById('output-container');
    return c.scrollHeight - c.scrollTop - c.clientHeight < 40;
  }

  function scrollToBottom() {
    const c = document.getElementById('output-container');
    c.scrollTop = c.scrollHeight;
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

  document.getElementById('approve-btn').addEventListener('click', () => sendApproval(true));
  document.getElementById('reject-btn').addEventListener('click', () => sendApproval(false));

  async function sendApproval(approved) {
    await api('POST', `/api/sessions/${currentSession}/approve`, { approved });
    hideApprovalBanner();
  }

  // --- Input bar ---
  document.getElementById('send-btn').addEventListener('click', sendInput);
  document.getElementById('input-text').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendInput();
  });

  async function sendInput() {
    const input = document.getElementById('input-text');
    const text = input.value;
    if (!text) return;
    input.value = '';
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
    currentSession = null;
    showScreen('main');
    refreshSessions();
  });
  killSheet.addEventListener('click', (e) => {
    if (e.target === killSheet) killSheet.classList.add('hidden');
  });

  // --- Back ---
  document.getElementById('back-btn').addEventListener('click', () => {
    currentSession = null;
    showScreen('main');
    refreshSessions();
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

  const PROVIDER_ICONS = { codex: '⚡', claude: '🟣', gemini: '✨' };
  function providerIcon(p) { return PROVIDER_ICONS[p] || '⚡'; }

  function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // --- Init ---
  function initApp() {
    showScreen('main');
    refreshSessions();
    connectWS();
  }

  if (token) {
    initApp();
  } else {
    showScreen('login');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
