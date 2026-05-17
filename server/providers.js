// Provider configurations for supported AI CLIs.
// Each provider defines how to launch, parse output, and detect approvals.

function esc(str) {
  return str.replace(/"/g, '\\"');
}

// ── Codex ─────────────────────────────────────────────────────────────────

function extractCodexResponses(output) {
  const lines = output.split('\n');
  const responses = [];
  let block = null;
  let trailingEmpties = 0;

  const flush = () => {
    if (block !== null) { responses.push(block.trim()); block = null; trailingEmpties = 0; }
  };

  for (const line of lines) {
    const isResponse = /^\s*•\s/.test(line) && !/[◦•] Working \(\d+s/.test(line);
    const isPrompt   = /^\s*›/.test(line);
    const isSep      = /^─{5,}/.test(line);
    const isEmpty    = !line.trim();

    if (isResponse) {
      flush(); block = line; trailingEmpties = 0;
    } else if (block !== null) {
      if (isPrompt || isSep) { flush(); }
      else if (isEmpty) { trailingEmpties++; block += '\n'; }
      else { block += '\n'.repeat(trailingEmpties + 1) + line; trailingEmpties = 0; }
    }
  }
  flush();
  return responses.filter(Boolean);
}

// ── Claude CLI ────────────────────────────────────────────────────────────
// Claude CLI renders responses as plain text blocks between ❯ prompt lines.
// Response text is stripped of ANSI and leading/trailing whitespace.

function extractClaudeResponses(output) {
  // Strip ANSI escape sequences
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n');
  const responses = [];
  let block = [];
  let afterInput = false;

  for (const line of lines) {
    const isPrompt = /^\s*[❯>]\s/.test(line) || /^\s*[❯>]\s*$/.test(line);
    if (isPrompt) {
      if (afterInput && block.length > 0) {
        const text = block.join('\n').trim();
        if (text) responses.push(text);
      }
      block = [];
      // If prompt line has content, user submitted input — next lines are the response
      afterInput = /^\s*[❯>]\s+\S/.test(line);
    } else if (afterInput) {
      block.push(line);
    }
  }

  if (afterInput && block.length > 0) {
    const text = block.join('\n').trim();
    if (text) responses.push(text);
  }

  return responses.filter(Boolean);
}

// ── Gemini CLI ────────────────────────────────────────────────────────────
// Gemini CLI uses a similar prompt/response pattern.

function extractGeminiResponses(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n');
  const responses = [];
  let block = [];
  let afterInput = false;

  for (const line of lines) {
    // Gemini uses ">" prompt or "✦" markers
    const isPrompt = /^\s*[>✦]\s/.test(line) || /^\s*[>✦]\s*$/.test(line);
    if (isPrompt) {
      if (afterInput && block.length > 0) {
        const text = block.join('\n').trim();
        if (text) responses.push(text);
      }
      block = [];
      afterInput = /^\s*[>✦]\s+\S/.test(line);
    } else if (afterInput) {
      block.push(line);
    }
  }

  if (afterInput && block.length > 0) {
    const text = block.join('\n').trim();
    if (text) responses.push(text);
  }

  return responses.filter(Boolean);
}

// ── Provider map ──────────────────────────────────────────────────────────

export const PROVIDERS = {
  codex: {
    label: 'Codex',
    icon: '⚡',
    launch: (task) => `codex --no-alt-screen -a untrusted "${esc(task)}"`,
    extractResponses: extractCodexResponses,
    approvalPatterns: [
      /Would you like to (?:make the following edits|run the following command)/i,
      /Press enter to confirm or esc to cancel/i,
      /Yes, proceed/i,
      /\[\s*y\/n\s*\]/i,
      /approve\?/i,
      /allow this action/i,
      /\(yes\/no\)/i,
    ],
    noisePatterns: [
      /gpt-\S+.*·/,
      /[◦•] Working \(\d+s/,
      /esc to interrupt/,
      /Press enter to confirm/,
      /^\s*›/,
      /^\s*[╭╰│─]/,
      /Codex \(v\d/,
      /model:.*\/model/,
      /directory:/,
      /^  Tip:/,
      /let's\s*\n?\s*build together/,
    ],
  },

  claude: {
    label: 'Claude',
    icon: '🟣',
    // --dangerously-skip-permissions disables interactive permission prompts so
    // the session behaves like Codex's -a untrusted mode (approvals via our UI).
    launch: (task) => `claude --dangerously-skip-permissions "${esc(task)}"`,
    extractResponses: extractClaudeResponses,
    approvalPatterns: [
      /\[Y\/n\]/,
      /allow this action/i,
      /\(yes\/no\)/i,
      /approve\?/i,
      /Do you want to proceed/i,
      /press enter to allow/i,
      /bash command.*\?/i,
    ],
    noisePatterns: [
      /^\s*[❯>]\s*$/,       // empty prompt line
      /claude-[a-z0-9-]+/,  // model name status
      /✻\s+Thinking/,
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
      /^\s*\x1b/,           // raw ANSI-only lines
    ],
  },

  gemini: {
    label: 'Gemini',
    icon: '✨',
    launch: (task) => `gemini --skip-trust "${esc(task)}"`,
    extractResponses: extractGeminiResponses,
    approvalPatterns: [
      /\[Y\/n\]/,
      /allow this action/i,
      /\(yes\/no\)/i,
      /approve\?/i,
      /Do you want to proceed/i,
      /run command/i,
    ],
    noisePatterns: [
      /^\s*[>✦]\s*$/,
      /Gemini \d/,
      /^\s*[◆◇]\s*$/,
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,
    ],
  },
};

export const DEFAULT_PROVIDER = 'codex';

export function getProvider(name) {
  return PROVIDERS[name] || PROVIDERS[DEFAULT_PROVIDER];
}
