import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Server-side text-to-speech: Piper (local neural TTS) → ffmpeg → MP3 stream.
// Played in the browser through a normal <audio> element, which Android keeps
// playing with the screen off (Web Speech API stops when the page is hidden).
// Tools and voices live outside the repo: ~/.local/share/agentremote-tts/
const TTS_DIR = process.env.TTS_DIR || join(process.env.HOME, '.local', 'share', 'agentremote-tts');
const PIPER = join(TTS_DIR, 'piper', 'piper');
const FFMPEG = join(TTS_DIR, 'ffmpeg');
const VOICES = { sv: 'sv_SE-nst-medium', en: 'en_US-lessac-medium' };
const SAMPLE_RATE = 22050; // both voices (see their .onnx.json)

export function ttsAvailable() {
  return existsSync(PIPER) && existsSync(FFMPEG) && existsSync(voicePath('en'));
}

function voicePath(lang) {
  return join(TTS_DIR, 'voices', `${VOICES[lang] || VOICES.en}.onnx`);
}

// <audio src> can't POST a long text, so the client registers the text first
// and then points the audio element at /api/tts/:id. Entries expire after 10 min.
const pending = new Map(); // id → { text, lang, at }

export function registerTts(text, lang) {
  const now = Date.now();
  for (const [id, e] of pending) if (now - e.at > 600000) pending.delete(id);
  const id = randomUUID();
  pending.set(id, { text: String(text).slice(0, 20000), lang: lang === 'sv' ? 'sv' : 'en', at: now });
  return id;
}

export function streamTts(id, res) {
  const entry = pending.get(id);
  if (!entry) return res.status(404).end();
  const voice = existsSync(voicePath(entry.lang)) ? voicePath(entry.lang) : voicePath('en');
  const piper = spawn(PIPER, ['-m', voice, '--output-raw'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const ffmpeg = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
    '-f', 'mp3', '-b:a', '48k', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  piper.stdout.pipe(ffmpeg.stdin);
  piper.stdin.end(entry.text);
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  ffmpeg.stdout.pipe(res);
  const kill = () => { piper.kill(); ffmpeg.kill(); };
  res.on('close', kill);
  piper.on('error', kill);
  ffmpeg.on('error', () => { kill(); if (!res.headersSent) res.status(500); res.end(); });
}
