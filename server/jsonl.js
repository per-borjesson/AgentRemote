import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

function projectDir(workdir) {
  if (!workdir) return null;
  const key = workdir.replace(/\//g, '-');
  const dir = join(process.env.HOME, '.claude', 'projects', key);
  return existsSync(dir) ? dir : null;
}

function activeJsonl(projectPath) {
  try {
    return readdirSync(projectPath)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f, mt: statSync(join(projectPath, f)).mtimeMs }))
      .sort((a, b) => b.mt - a.mt)
      .map(x => join(projectPath, x.f))[0] || null;
  } catch { return null; }
}

export function readJsonlConversation(workdir) {
  const dir = projectDir(workdir);
  if (!dir) return null;
  const file = activeJsonl(dir);
  if (!file) return null;

  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }

  const msgMap = new Map(); // msg id → accumulated state
  const order = [];        // first-appearance order of IDs
  let userCount = 0;
  let lastRole = null;
  let lastStopReason = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry.message;
    if (!msg) continue;

    if (entry.type === 'user') {
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content.trim();
      } else if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(c => c.type === 'text' && c.text?.trim());
        if (!textBlocks.length) continue; // skip tool_result-only entries
        text = textBlocks.map(c => c.text).join('').trim();
      }
      if (!text || text.startsWith('<')) continue; // skip internal command/caveat injections
      const uid = `u${userCount++}`;
      msgMap.set(uid, { role: 'user', text, ts: entry.timestamp || msg.timestamp || null });
      order.push(uid);
      lastRole = 'user';
      lastStopReason = null;
    }

    if (entry.type === 'assistant' && entry.isSidechain === false) {
      const id = msg.id;
      if (!id) continue;
      if (!msgMap.has(id)) {
        order.push(id);
        msgMap.set(id, { role: 'assistant', text: '', tools: [], stop_reason: null, ts: entry.timestamp || null });
      }
      const m = msgMap.get(id);
      m.stop_reason = msg.stop_reason;
      if (entry.timestamp) m.ts = entry.timestamp;
      for (const block of (msg.content || [])) {
        if (block.type === 'text' && block.text) m.text = block.text;
        if (block.type === 'tool_use' && block.name && !m.tools.find(t => t.id === block.id)) {
          m.tools.push({ id: block.id, name: block.name });
        }
      }
      lastRole = 'assistant';
      lastStopReason = msg.stop_reason;
    }
  }

  const conv = [];
  const seen = new Set();
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const m = msgMap.get(id);
    if (m.role === 'user' && m.text) {
      conv.push({ role: 'user', text: m.text, ts: m.ts });
    } else if (m.role === 'assistant' && m.text) {
      conv.push({ role: 'assistant', text: m.text, ts: m.ts, stop_reason: m.stop_reason, tools: m.tools });
    }
  }

  let status = 'idle';
  if (lastRole === 'user') status = 'thinking';
  else if (lastRole === 'assistant') {
    if (lastStopReason === 'end_turn') status = 'waiting';
    else if (lastStopReason === 'tool_use') status = 'working';
    else status = 'thinking';
  }

  return { conv, status };
}
