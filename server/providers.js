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
// Claude CLI uses ● as a response marker (similar to Codex's •).
// Blocks continue until the next ❯ prompt, ✻/✽/✢/✶ timing line, or ─── separator.
// Tool-call blocks (● Update(...), ● Bash(...) etc.) are skipped — only
// prose responses are forwarded to Telegram.

// Matches tool-call ● lines: old-style "● ToolName(..." and new-style summaries
// "● Reading 1 file…", "● Searching for 1 pattern…", "● Committed abc123…"
const CLAUDE_TOOL_CALL = /^\s*●\s+(?:[A-Z][a-zA-Z]+[·(]|Call(?:ing|ed)\s|[A-Z][a-z]+(?:ing|ed) (?:\w+ )?\d)/;
// Matches the feedback prompt Claude occasionally shows
const CLAUDE_FEEDBACK  = /How is Claude doing this session/;

function extractClaudeResponses(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n');
  const responses = [];
  let block = null;
  let skipBlock = false;
  let trailingEmpties = 0;

  const flush = () => {
    if (block !== null && !skipBlock) { responses.push(block.trim()); }
    block = null; skipBlock = false; trailingEmpties = 0;
  };

  for (const line of lines) {
    const isResponse = /^\s*●\s/.test(line);
    // Only unindented ❯ is the user prompt — questionnaire options use indented ❯
    const isPrompt   = /^❯/.test(line);
    const isSep      = /^─{5,}/.test(line);
    // Old-style ✻/✽/… spinners and new-style "* Roosting… (4s …)" / "· Roosting… (12s …)"
    const isTiming   = /^\s*[✻✽✢✶✸]/.test(line) || /^\s*[*·] \w[\w ]*[….]? \(\d+[ms]/.test(line);
    const isEmpty    = !line.trim();

    // Mutable lines that must be excluded from prose blocks to keep texts stable.
    const isInProgressStatus = /^\s{2,}[A-Z][a-z]+ing (?:for )?\d/.test(line);
    const isStatusBar = /\/clear to start fresh/.test(line);
    // Inline tool invocations (Fetch/WebSearch) inside prose blocks appear and
    // disappear as parallel tools complete — skip them so prose stays stable.
    const isInlineToolCall = /^\s+(?:Fetch|Web Search|WebSearch)\(/.test(line);

    if (isResponse) {
      flush();
      const text = line.replace(/^\s*●\s*/, '');
      skipBlock = CLAUDE_TOOL_CALL.test(line) || CLAUDE_FEEDBACK.test(text);
      block = text;
      trailingEmpties = 0;
    } else if (block !== null) {
      if (isPrompt || isSep || isTiming) { flush(); }
      else if (isInProgressStatus || isStatusBar || isInlineToolCall) { /* skip mutable/unstable lines */ }
      else if (isEmpty) { trailingEmpties++; block += '\n'; }
      else {
        // Strip trailing run-timer ("… (12s)", "… (1m 30s)") that Claude Code
        // embeds at the end of the last code line while a tool executes. It
        // updates every poll and makes otherwise-identical lines differ.
        const lineClean = line.replace(/\s*…\s*\(\d[^)]*\)\s*$/, '');
        block += '\n'.repeat(trailingEmpties + 1) + lineClean;
        trailingEmpties = 0;
      }
    }
  }
  flush();
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
    launch: (task) => task ? `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox "${esc(task)}"` : `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox`,
    extractResponses: extractCodexResponses,
    approvalPatterns: [
      /Would you like to (?:make the following edits|run the following command)/i,
      /Press enter to confirm or esc to cancel/i,
      /Do you trust the contents of this directory/i,
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
    launch: (task) => task ? `claude --dangerously-skip-permissions "${esc(task)}"` : `claude --dangerously-skip-permissions`,
    resumePattern: /claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
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
      /^\s*❯/,                      // prompt lines
      /Claude Code v[\d.]+/,        // version header
      /(?:Sonnet|Opus|Haiku).*·/,    // model status line
      /▐▛|▝▜|▘▘/,                   // logo box-drawing
      /[✻✽✢✶✸]/,                    // timing/thinking indicators (all spinner variants)
      /^\s*[*·] \w[\w ]*[….]? \(\d+[ms]/,  // new-style timing (* Roosting… (4s), · Roosting… (12s))
      /⏵⏵ bypass permissions/,      // status bar
      /^─{5,}/,                     // separators
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,     // spinners
      /\b(low|medium|high)\s*·\s*\/effort/,  // effort indicator
      /^\s*Call(?:ing|ed)\s/,        // tool call progress sub-lines ("  Calling HubSpot…")
      /Smooshing/,                   // thinking display text
      /^\s*⎿/,                      // tip/sub-item prefix
      /^\s+(?:Read|Ran|Listed|Wrote|Written|Edited|Created|Deleted|Fetched|Searched|Committed|Updated|Removed|Copied|Moved)\s+\d/, // tool completion summaries
      /^\s+Committed\s+[0-9a-f]{6,}/, // "  Committed 6d057c…" (hash, not digit count)
      /ctrl\+b.*background/,        // background run hint
      /\/clear to start fresh/,     // token-count status bar ("~93k uncached · /clear to start fresh")
    ],
  },

  gemini: {
    label: 'Gemini',
    icon: '✨',
    launch: (task) => task ? `gemini --skip-trust "${esc(task)}"` : `gemini --skip-trust`,
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
