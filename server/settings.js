import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

const HOME = process.env.HOME;
const SECRETS_DIR    = join(HOME, '.secrets');
const TELEGRAM_FILE  = join(SECRETS_DIR, 'telegram.env');
const GITHUB_FILE    = join(SECRETS_DIR, 'github.env');
const HUBSPOT_FILE   = join(SECRETS_DIR, 'hubspot-main.env');
const STRIPE_FILE    = join(SECRETS_DIR, 'stripe.env');
const OPENAI_FILE    = join(SECRETS_DIR, 'openai.env');
const GEMINI_FILE    = join(SECRETS_DIR, 'gemini.env');
const ANTHROPIC_FILE = join(SECRETS_DIR, 'anthropic.env');
const GMAIL_FILE     = join(SECRETS_DIR, 'gmail.env');
const GMAIL_LEGACY   = join(HOME, '.openclaw', 'email.env'); // fallback for existing installations
const CUSTOM_FILE    = join(SECRETS_DIR, 'custom.env');
const AI_PROVIDERS_FILE = join(SECRETS_DIR, 'ai-providers.json');

const CLAUDE_CREDS  = join(HOME, '.claude', '.credentials.json');
const CODEX_AUTH    = join(HOME, '.codex', 'auth.json');
const GEMINI_OAUTH  = join(HOME, '.gemini', 'oauth_creds.json');
const NPM_BIN       = join(HOME, '.npm-global', 'bin');

function ensureSecrets() {
  if (!existsSync(SECRETS_DIR)) mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
}

export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const obj = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)/);
    if (m) obj[m[1]] = m[2];
  }
  return obj;
}

function writeEnvFile(path, obj) {
  ensureSecrets();
  const content = Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(path, content, { mode: 0o600 });
}

function mask(val) {
  if (!val) return '';
  if (val.length <= 8) return '••••••••';
  return val.slice(0, 4) + '••••••••' + val.slice(-4);
}

function isMasked(val) {
  return typeof val === 'string' && val.includes('•');
}

export function getClaudeStatus() {
  if (!existsSync(CLAUDE_CREDS)) return { configured: false, email: null, expiresIn: null };
  try {
    const creds = JSON.parse(readFileSync(CLAUDE_CREDS, 'utf8'));
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return { configured: false, email: null, expiresIn: null };
    const expiresIn = oauth.expiresAt ? Math.round((oauth.expiresAt - Date.now()) / 60000) : null;
    return { configured: true, email: oauth.email || null, expiresIn };
  } catch { return { configured: false, email: null, expiresIn: null }; }
}

export function getCodexOAuthStatus() {
  if (!existsSync(CODEX_AUTH)) return { configured: false, mode: null };
  try {
    const a = JSON.parse(readFileSync(CODEX_AUTH, 'utf8'));
    if (!a.tokens && !a.auth_mode) return { configured: false, mode: null };
    return { configured: true, mode: a.auth_mode || 'oauth' };
  } catch { return { configured: false, mode: null }; }
}

export function getGeminiOAuthStatus() {
  if (!existsSync(GEMINI_OAUTH)) return { configured: false };
  try {
    const c = JSON.parse(readFileSync(GEMINI_OAUTH, 'utf8'));
    return { configured: !!c.access_token };
  } catch { return { configured: false }; }
}

function readAiProviders() {
  if (!existsSync(AI_PROVIDERS_FILE)) return [];
  try { return JSON.parse(readFileSync(AI_PROVIDERS_FILE, 'utf8')); } catch { return []; }
}

function writeAiProviders(providers) {
  ensureSecrets();
  writeFileSync(AI_PROVIDERS_FILE, JSON.stringify(providers, null, 2), { mode: 0o600 });
}

export function getSettings() {
  const telegram  = readEnvFile(TELEGRAM_FILE);
  const github    = readEnvFile(GITHUB_FILE);
  const hubspot   = readEnvFile(HUBSPOT_FILE);
  const stripe    = readEnvFile(STRIPE_FILE);
  const openai    = readEnvFile(OPENAI_FILE);
  const gemini    = readEnvFile(GEMINI_FILE);
  const anthropic = readEnvFile(ANTHROPIC_FILE);
  const gmailRaw  = readEnvFile(GMAIL_FILE);
  // Fall back to OpenClaw's email.env for existing installations that predate gmail.env
  const gmailLegacy = (!gmailRaw.GMAIL_ADDRESS && existsSync(GMAIL_LEGACY)) ? readEnvFile(GMAIL_LEGACY) : {};
  const gmail = {
    GMAIL_ADDRESS:    gmailRaw.GMAIL_ADDRESS    || gmailLegacy.IMAP_USER || '',
    GMAIL_APP_PASSWORD: gmailRaw.GMAIL_APP_PASSWORD || gmailLegacy.IMAP_PASS || '',
  };
  const custom    = readEnvFile(CUSTOM_FILE);
  const aiProviders = readAiProviders();

  return {
    claude:  { ...getClaudeStatus(), key: mask(anthropic.ANTHROPIC_API_KEY) },
    openai:  (oa => ({ ...oa, configured: !!openai.OPENAI_API_KEY || oa.configured, key: mask(openai.OPENAI_API_KEY) }))(getCodexOAuthStatus()),
    gemini:  (gm => ({ ...gm, configured: !!gemini.GEMINI_API_KEY || gm.configured, key: mask(gemini.GEMINI_API_KEY) }))(getGeminiOAuthStatus()),
    aiProviders: aiProviders.map(p => ({ name: p.name, baseUrl: p.baseUrl })),
    telegram: {
      configured: !!(telegram.BOT_TOKEN && telegram.CHAT_ID),
      botToken: mask(telegram.BOT_TOKEN),
      chatId: telegram.CHAT_ID || '',
    },
    email: {
      configured: !!(gmail.GMAIL_ADDRESS && gmail.GMAIL_APP_PASSWORD),
      address: gmail.GMAIL_ADDRESS || '',
      appPassword: mask(gmail.GMAIL_APP_PASSWORD),
    },
    github:  { configured: !!github.GITHUB_TOKEN,             token: mask(github.GITHUB_TOKEN) },
    hubspot: { configured: !!hubspot.HUBSPOT_ACCESS_TOKEN,    token: mask(hubspot.HUBSPOT_ACCESS_TOKEN) },
    stripe:  { configured: !!stripe.STRIPE_SECRET_KEY,        key:   mask(stripe.STRIPE_SECRET_KEY) },
    custom:  Object.entries(custom).map(([name, val]) => ({ name, masked: mask(val) })),
  };
}

export function saveSection(section, data) {
  switch (section) {
    case 'claude': {
      const s = readEnvFile(ANTHROPIC_FILE);
      if (data.key && !isMasked(data.key)) s.ANTHROPIC_API_KEY = data.key.trim();
      writeEnvFile(ANTHROPIC_FILE, s);
      break;
    }
    case 'openai': {
      const s = readEnvFile(OPENAI_FILE);
      if (data.key && !isMasked(data.key)) s.OPENAI_API_KEY = data.key.trim();
      writeEnvFile(OPENAI_FILE, s);
      break;
    }
    case 'gemini': {
      const s = readEnvFile(GEMINI_FILE);
      if (data.key && !isMasked(data.key)) s.GEMINI_API_KEY = data.key.trim();
      writeEnvFile(GEMINI_FILE, s);
      break;
    }
    case 'telegram': {
      const s = readEnvFile(TELEGRAM_FILE);
      if (data.botToken && !isMasked(data.botToken)) s.BOT_TOKEN = data.botToken.trim();
      if (data.chatId) s.CHAT_ID = data.chatId.trim();
      writeEnvFile(TELEGRAM_FILE, s);
      break;
    }
    case 'email': {
      const s = readEnvFile(GMAIL_FILE);
      if (data.address) s.GMAIL_ADDRESS = data.address.trim();
      if (data.appPassword && !isMasked(data.appPassword)) s.GMAIL_APP_PASSWORD = data.appPassword.trim();
      writeEnvFile(GMAIL_FILE, s);
      break;
    }
    case 'github': {
      const s = readEnvFile(GITHUB_FILE);
      if (data.token && !isMasked(data.token)) s.GITHUB_TOKEN = data.token.trim();
      writeEnvFile(GITHUB_FILE, s);
      break;
    }
    case 'hubspot': {
      const s = readEnvFile(HUBSPOT_FILE);
      if (data.token && !isMasked(data.token)) s.HUBSPOT_ACCESS_TOKEN = data.token.trim();
      writeEnvFile(HUBSPOT_FILE, s);
      break;
    }
    case 'stripe': {
      const s = readEnvFile(STRIPE_FILE);
      if (data.key && !isMasked(data.key)) s.STRIPE_SECRET_KEY = data.key.trim();
      writeEnvFile(STRIPE_FILE, s);
      break;
    }
    default:
      throw new Error(`unknown section: ${section}`);
  }
}

export function saveAiProvider(name, baseUrl, key) {
  if (!name || !key) throw new Error('Name and API key are required');
  const providers = readAiProviders().filter(p => p.name !== name);
  providers.push({ name, baseUrl: baseUrl || '', key });
  writeAiProviders(providers);
}

export function deleteAiProvider(name) {
  writeAiProviders(readAiProviders().filter(p => p.name !== name));
}

export function saveCustom(name, value) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error('Name must start with a letter and contain only letters, numbers, underscores');
  if (!value) throw new Error('Value is required');
  const custom = readEnvFile(CUSTOM_FILE);
  custom[name] = value;
  writeEnvFile(CUSTOM_FILE, custom);
}

export function deleteCustom(name) {
  const custom = readEnvFile(CUSTOM_FILE);
  delete custom[name];
  writeEnvFile(CUSTOM_FILE, custom);
}

export async function testTelegram() {
  const s = readEnvFile(TELEGRAM_FILE);
  if (!s.BOT_TOKEN || !s.CHAT_ID) throw new Error('Telegram not configured');
  const body = JSON.stringify({ chat_id: s.CHAT_ID, text: '✅ AgentRemote connected' });
  const result = await fetch(`https://api.telegram.org/bot${s.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const json = await result.json();
  if (!json.ok) throw new Error(json.description || 'Telegram API error');
  return 'Test message sent';
}

export async function testEmail() {
  const raw = readEnvFile(GMAIL_FILE);
  const legacy = (!raw.GMAIL_ADDRESS && existsSync(GMAIL_LEGACY)) ? readEnvFile(GMAIL_LEGACY) : {};
  const address  = raw.GMAIL_ADDRESS     || legacy.IMAP_USER || '';
  const password = raw.GMAIL_APP_PASSWORD || legacy.IMAP_PASS || '';
  if (!address || !password) throw new Error('Email not configured');
  return new Promise((resolve, reject) => {
    const script = `
import imaplib, sys
try:
    m = imaplib.IMAP4_SSL('imap.gmail.com', 993)
    m.login(${JSON.stringify(address)}, ${JSON.stringify(password)})
    m.logout()
    print('ok')
except Exception as e:
    print('err:' + str(e), file=sys.stderr)
    sys.exit(1)
`;
    const proc = spawn('python3', ['-c', script]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve('IMAP connection successful');
      else reject(new Error('Connection failed — check address and app password'));
    });
    proc.on('error', () => reject(new Error('python3 not available')));
    setTimeout(() => { proc.kill(); reject(new Error('Connection timed out')); }, 12000);
  });
}

let codexLoginProc = null;

export function startCodexLogin() {
  return new Promise((resolve, reject) => {
    if (codexLoginProc) {
      try { codexLoginProc.kill(); } catch {}
      codexLoginProc = null;
    }

    const env = { ...process.env, PATH: `${NPM_BIN}:${process.env.PATH || '/usr/bin:/bin'}` };
    const proc = spawn('codex', ['login', '--device-auth'], { env });
    codexLoginProc = proc;

    let url = null;
    const urlRe = /https:\/\/[^\s\x1b\]'"]+/;

    const check = chunk => {
      if (url) return;
      const text = chunk.toString().replace(/\x1b\[[0-9;]*[mGKH]/g, '');
      const m = text.match(urlRe);
      if (m) {
        url = m[0].replace(/['".,)]+$/, '');
        clearTimeout(timer);
        resolve({ url });
      }
    };

    proc.stdout.on('data', check);
    proc.stderr.on('data', check);
    proc.on('close', () => { codexLoginProc = null; });
    proc.on('error', err => { codexLoginProc = null; clearTimeout(timer); if (!url) reject(err); });

    const timer = setTimeout(() => {
      if (!url) {
        try { proc.kill(); } catch {}
        codexLoginProc = null;
        reject(new Error('Timed out — could not get login URL from codex'));
      }
    }, 20000);
  });
}

let claudeLoginProc = null;

export function startClaudeLogin() {
  return new Promise((resolve, reject) => {
    if (claudeLoginProc) {
      try { claudeLoginProc.kill(); } catch {}
      claudeLoginProc = null;
    }

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_SSH_DAEMON_CHILD;
    delete cleanEnv.ANTHROPIC_API_KEY;
    cleanEnv.PATH = `${NPM_BIN}:${cleanEnv.PATH || '/usr/bin:/bin'}`;

    const proc = spawn('claude', ['login'], { env: cleanEnv });
    claudeLoginProc = proc;

    let url = null;
    const urlRe = /https:\/\/claude\.ai\/[^\s\x1b\]]+/;

    const check = chunk => {
      if (url) return;
      const text = chunk.toString().replace(/\x1b\[[0-9;]*[mGKH]/g, '');
      const m = text.match(urlRe);
      if (m) {
        url = m[0].replace(/['"]+$/, '');
        clearTimeout(timer);
        resolve({ url });
      }
    };

    proc.stdout.on('data', check);
    proc.stderr.on('data', check);
    proc.on('close', () => { claudeLoginProc = null; });
    proc.on('error', err => { claudeLoginProc = null; clearTimeout(timer); if (!url) reject(err); });

    const timer = setTimeout(() => {
      if (!url) {
        try { proc.kill(); } catch {}
        claudeLoginProc = null;
        reject(new Error('Timed out — could not get login URL from claude'));
      }
    }, 20000);
  });
}
