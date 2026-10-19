import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, 'archived.json');

function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; }
}

function persist(entries) {
  try { writeFileSync(FILE, JSON.stringify(entries, null, 2)); } catch {}
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
