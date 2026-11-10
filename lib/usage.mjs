// Zero-dependency data layer.
// Nothing here talks to a model: limits come from the same endpoint Claude Code's
// /usage command uses, token counts come from the local session logs.
// => The dashboard costs 0 tokens and does not touch your 5h / weekly limit.

import { readFile, writeFile, readdir, stat, mkdir, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const H = 3600e3;
const D = 24 * H;

export const CLAUDE_DIRS = (process.env.CLAUDE_CONFIG_DIR || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .concat([join(HOME, '.claude'), join(HOME, '.config', 'claude')])
  .filter((v, i, a) => a.indexOf(v) === i);

const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(HOME, '.cache'), 'claude-usage-dashboard');
const LIMITS_CACHE = join(CACHE_DIR, 'limits.json');
const LIMITS_TTL = Number(process.env.CLAUDE_USAGE_TTL || 60) * 1e3; // endpoint is rate limited

// ---------------------------------------------------------------- credentials
function sh(cmd, args) {
  return new Promise(res => execFile(cmd, args, { timeout: 4000 }, (e, out) => res(e ? '' : out.trim())));
}

async function readToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  const candidates = [];
  for (const d of CLAUDE_DIRS) {
    try { candidates.push(await readFile(join(d, '.credentials.json'), 'utf8')); } catch {}
  }
  if (platform() === 'darwin') candidates.push(await sh('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']));
  for (const raw of candidates) {
    try {
      const o = JSON.parse(raw).claudeAiOauth;
      if (o?.accessToken) return { token: o.accessToken, expiresAt: o.expiresAt, plan: o.subscriptionType };
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- limits (5h / weekly)
async function fetchLimitsLive() {
  const cred = await readToken();
  if (!cred) return { error: 'Kein Claude-Login gefunden. Einmal `claude` starten und mit dem Abo einloggen.' };
  if (cred.expiresAt && cred.expiresAt < Date.now())
    return { error: 'OAuth-Token abgelaufen. Kurz `claude` öffnen (erneuert den Token), dann aktualisiert sich das Dashboard.' };
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${cred.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-usage-dashboard',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { error: `Limit-Abfrage fehlgeschlagen (HTTP ${r.status})` };
    return { data: await r.json(), plan: cred.plan };
  } catch (e) {
    return { error: `Limit-Abfrage fehlgeschlagen: ${e.message}` };
  }
}

/** Cached across processes (server, CLI, statusline) so the endpoint is hit at most once per TTL. */
export async function getLimits({ force = false } = {}) {
  let cached;
  try { cached = JSON.parse(await readFile(LIMITS_CACHE, 'utf8')); } catch {}
  if (!force && cached && Date.now() - cached.fetchedAt < LIMITS_TTL) return cached;
  const live = await fetchLimitsLive();
  // keep last good data on error, but surface the error
  const out = live.data
    ? { fetchedAt: Date.now(), plan: live.plan, raw: live.data }
    : { ...(cached || {}), fetchedAt: Date.now(), error: live.error };
  try { await mkdir(CACHE_DIR, { recursive: true }); await writeFile(LIMITS_CACHE, JSON.stringify(out)); } catch {}
  return out;
}

/** Normalise the endpoint payload to [{key,label,pct,resetsAt}] */
export function normaliseLimits(raw) {
  const labels = {
    five_hour: '5-Stunden-Limit',
    seven_day: 'Wochenlimit',
    seven_day_opus: 'Wochenlimit Opus',
    seven_day_sonnet: 'Wochenlimit Sonnet',
    seven_day_oauth_apps: 'Wochenlimit Apps',
  };
  const out = [];
  for (const [k, v] of Object.entries(raw || {})) {
    if (!v || typeof v !== 'object' || typeof v.utilization !== 'number') continue;
    out.push({
      key: k,
      label: labels[k] || k.replace(/_/g, ' '),
      pct: v.utilization,
      resetsAt: v.resets_at ? Date.parse(v.resets_at) : null,
    });
  }
  const order = k => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
  return out.sort((a, b) => order(a.key) - order(b.key));
}

// ---------------------------------------------------------------- local token counter
// Incremental JSONL reader: each file is only read from the last byte offset onward,
// files older than 7 days are skipped entirely.
const fileState = new Map(); // path -> { offset, mtime, rows: [] }

async function* walk(dir) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function parseLine(line) {
  if (!line.includes('"usage"')) return null;
  try {
    const j = JSON.parse(line);
    const u = j.message?.usage;
    if (!u || !j.timestamp) return null;
    return {
      id: (j.message.id || '') + ':' + (j.requestId || ''),
      t: Date.parse(j.timestamp),
      model: j.message.model || 'unbekannt',
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0,
      cr: u.cache_read_input_tokens || 0,
    };
  } catch { return null; }
}

async function readNew(path, st) {
  let s = fileState.get(path);
  if (!s || st.size < s.offset) s = { offset: 0, rows: [] }; // new or truncated
  if (st.size > s.offset) {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(st.size - s.offset);
      await fh.read(buf, 0, buf.length, s.offset);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n') + 1; // only consume complete lines
      for (const line of text.slice(0, end).split('\n')) {
        const r = line && parseLine(line);
        if (r) s.rows.push(r);
      }
      s.offset += Buffer.byteLength(text.slice(0, end));
    } finally { await fh.close(); }
  }
  s.mtime = st.mtimeMs;
  fileState.set(path, s);
  return s.rows;
}

export async function getTokenRows(sinceMs) {
  const seen = new Set();
  const rows = [];
  for (const base of CLAUDE_DIRS) {
    for await (const p of walk(join(base, 'projects'))) {
      let st;
      try { st = await stat(p); } catch { continue; }
      if (st.mtimeMs < sinceMs) { fileState.delete(p); continue; }
      for (const r of await readNew(p, st)) {
        if (r.t < sinceMs || seen.has(r.id)) continue; // de-dupe streamed / resumed entries
        seen.add(r.id);
        rows.push(r);
      }
    }
  }
  return rows;
}

function sum(rows) {
  const s = { in: 0, out: 0, cw: 0, cr: 0, total: 0, requests: rows.length, models: {} };
  for (const r of rows) {
    s.in += r.in; s.out += r.out; s.cw += r.cw; s.cr += r.cr;
    const m = (s.models[r.model] ||= { in: 0, out: 0, cw: 0, cr: 0, total: 0, requests: 0 });
    m.in += r.in; m.out += r.out; m.cw += r.cw; m.cr += r.cr; m.requests++;
    m.total += r.in + r.out + r.cw + r.cr;
  }
  s.total = s.in + s.out + s.cw + s.cr;
  return s;
}

// ---------------------------------------------------------------- snapshot
export async function snapshot({ force = false } = {}) {
  const now = Date.now();
  const lim = await getLimits({ force });
  const limits = normaliseLimits(lim.raw);
  const five = limits.find(l => l.key === 'five_hour');
  const week = limits.find(l => l.key === 'seven_day');

  // Align token windows with the official reset times when known, else rolling windows.
  const fiveStart = five?.resetsAt ? five.resetsAt - 5 * H : now - 5 * H;
  const weekStart = week?.resetsAt ? week.resetsAt - 7 * D : now - 7 * D;
  const dayStart = new Date(now).setHours(0, 0, 0, 0);

  const rows = await getTokenRows(Math.min(weekStart, fiveStart, dayStart, now - 7 * D));
  const last30 = rows.filter(r => r.t >= now - 30 * 60e3);

  return {
    now,
    plan: lim.plan || null,
    limitsFetchedAt: lim.raw ? lim.fetchedAt : null,
    error: lim.error || null,
    limits,
    tokens: {
      fiveHour: { start: fiveStart, ...sum(rows.filter(r => r.t >= fiveStart)) },
      week: { start: weekStart, ...sum(rows.filter(r => r.t >= weekStart)) },
      today: { start: dayStart, ...sum(rows.filter(r => r.t >= dayStart)) },
      burnPerMin: Math.round(last30.reduce((a, r) => a + r.in + r.out + r.cw, 0) / 30),
      lastActivity: rows.reduce((a, r) => Math.max(a, r.t), 0) || null,
    },
  };
}

// ---------------------------------------------------------------- formatting helpers (CLI)
export const fmtNum = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' Mrd' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' Mio' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
export function fmtIn(ms) {
  if (ms == null) return '–';
  if (ms <= 0) return 'jetzt';
  const m = Math.round(ms / 60e3), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}T ${h}h` : h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
}
