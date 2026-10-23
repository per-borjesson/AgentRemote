import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'archived.json');
// Snapshot of live sessions, so ones that vanish without an explicit kill
// (tmux server killed, service restart) can be moved to the archive.
const TRACKED_FILE = join(__dirname, 'tracked.json');

function load(file = FILE, fallback = []) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function persist(entries, file = FILE) {
  try { writeFileSync(file, JSON.stringify(entries, null, 2)); } catch {}
}

export function listArchived() { return load(); }

export function addArchived(entry) {
  const entries = load().filter(e => e.name !== entry.name);
  entries.unshift(entry);
  persist(entries);
}

export function removeArchived(name) {
  persist(load().filter(e => e.name !== name));
}

// Record a live session (keyed by name) with its latest resume ID.
export function trackSession(entry) {
  const tracked = load(TRACKED_FILE, {});
  const prev = tracked[entry.name];
  if (prev && prev.resumeId === entry.resumeId && prev.workdir === entry.workdir) return;
  tracked[entry.name] = entry;
  persist(tracked, TRACKED_FILE);
}

export function untrackSession(name) {
  const tracked = load(TRACKED_FILE, {});
  if (!(name in tracked)) return;
  delete tracked[name];
  persist(tracked, TRACKED_FILE);
}

export function listTracked() { return load(TRACKED_FILE, {}); }
