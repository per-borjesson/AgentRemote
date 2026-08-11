import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';

const HOME = process.env.HOME;
const SECRETS_DIR = join(HOME, '.secrets');
const SETTINGS_FILE = join(SECRETS_DIR, 'agentremote-settings.env');
const CUSTOM_FILE = join(SECRETS_DIR, 'custom.env');
const AI_PROVIDERS_FILE = join(SECRETS_DIR, 'ai-providers.json');
const CLAUDE_CREDS = join(HOME, '.claude', '.credentials.json');
const NPM_BIN = join(HOME, '.npm-global', 'bin');

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

// Detect if a value contains masking chars (user didn't change it)
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

function readAiProviders() {
  if (!existsSync(AI_PROVIDERS_FILE)) return [];
  try { return JSON.parse(readFileSync(AI_PROVIDERS_FILE, 'utf8')); } catch { return []; }
}

function writeAiProviders(providers) {
  ensureSecrets();
  writeFileSync(AI_PROVIDERS_FILE, JSON.stringify(providers, null, 2), { mode: 0o600 });
}

export function getSettings() {
  const s = readEnvFile(SETTINGS_FILE);
  const custom = readEnvFile(CUSTOM_FILE);
  const aiProviders = readAiProviders();
  return {
    claude: getClaudeStatus(),
    openai: { configured: !!s.OPENAI_API_KEY, key: mask(s.OPENAI_API_KEY) },
    gemini: { configured: !!s.GEMINI_API_KEY, key: mask(s.GEMINI_API_KEY) },
    aiProviders: aiProviders.map(p => ({ name: p.name, baseUrl: p.baseUrl })),
    telegram: {
      configured: !!(s.TELEGRAM_BOT_TOKEN && s.TELEGRAM_CHAT_ID),
      botToken: mask(s.TELEGRAM_BOT_TOKEN),
      chatId: s.TELEGRAM_CHAT_ID || '',
    },
    email: {
      configured: !!(s.GMAIL_ADDRESS && s.GMAIL_APP_PASSWORD),
      address: s.GMAIL_ADDRESS || '',
      appPassword: mask(s.GMAIL_APP_PASSWORD),
    },
    github: { configured: !!s.GITHUB_TOKEN, token: mask(s.GITHUB_TOKEN) },
    hubspot: { configured: !!s.HUBSPOT_ACCESS_TOKEN, token: mask(s.HUBSPOT_ACCESS_TOKEN) },
    stripe: { configured: !!s.STRIPE_SECRET_KEY, key: mask(s.STRIPE_SECRET_KEY) },
    custom: Object.entries(custom).map(([name, val]) => ({ name, masked: mask(val) })),
  };
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

export function saveSection(section, data) {
  const s = readEnvFile(SETTINGS_FILE);
  switch (section) {
    case 'telegram':
      if (data.botToken && !isMasked(data.botToken)) s.TELEGRAM_BOT_TOKEN = data.botToken.trim();
      if (data.chatId) s.TELEGRAM_CHAT_ID = data.chatId.trim();
      break;
    case 'email':
      if (data.address) s.GMAIL_ADDRESS = data.address.trim();
      if (data.appPassword && !isMasked(data.appPassword)) s.GMAIL_APP_PASSWORD = data.appPassword.trim();
      break;
    case 'github':
      if (data.token && !isMasked(data.token)) s.GITHUB_TOKEN = data.token.trim();
      break;
    case 'openai':
      if (data.key && !isMasked(data.key)) s.OPENAI_API_KEY = data.key.trim();
      break;
    case 'gemini':
      if (data.key && !isMasked(data.key)) s.GEMINI_API_KEY = data.key.trim();
      break;
    case 'hubspot':
      if (data.token && !isMasked(data.token)) s.HUBSPOT_ACCESS_TOKEN = data.token.trim();
      break;
    case 'stripe':
      if (data.key && !isMasked(data.key)) s.STRIPE_SECRET_KEY = data.key.trim();
      break;
    default:
      throw new Error(`unknown section: ${section}`);
  }
  writeEnvFile(SETTINGS_FILE, s);
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
  const s = readEnvFile(SETTINGS_FILE);
  if (!s.TELEGRAM_BOT_TOKEN || !s.TELEGRAM_CHAT_ID) throw new Error('Telegram not configured');
  const body = JSON.stringify({ chat_id: s.TELEGRAM_CHAT_ID, text: '✅ AgentRemote connected' });
  const result = await fetch(`https://api.telegram.org/bot${s.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const json = await result.json();
  if (!json.ok) throw new Error(json.description || 'Telegram API error');
  return 'Test message sent';
}

export async function testEmail() {
  const s = readEnvFile(SETTINGS_FILE);
  if (!s.GMAIL_ADDRESS || !s.GMAIL_APP_PASSWORD) throw new Error('Email not configured');
  return new Promise((resolve, reject) => {
    const script = `
import imaplib, sys
try:
    m = imaplib.IMAP4_SSL('imap.gmail.com', 993)
    m.login(${JSON.stringify(s.GMAIL_ADDRESS)}, ${JSON.stringify(s.GMAIL_APP_PASSWORD)})
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

let claudeLoginProc = null;

// Spawn `claude login`, capture the OAuth URL it prints, return it.
// The process stays alive until the user completes OAuth in the browser.
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
