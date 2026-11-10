#!/usr/bin/env node
// claude-usage  [serve|cli|statusline]  [--port 4747] [--open]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { exec } from 'node:child_process';
import { snapshot, fmtNum, fmtIn } from '../lib/usage.mjs';

const args = process.argv.slice(2);
const mode = args.find(a => !a.startsWith('-')) || 'serve';
const flag = n => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : true; };

const bar = (p, w = 20) => { const f = Math.round((Math.min(100, p) / 100) * w); return '█'.repeat(f) + '░'.repeat(w - f); };
const color = p => (p >= 90 ? 31 : p >= 70 ? 33 : 32);
const c = (code, s) => (process.stdout.isTTY || mode === 'statusline' ? `\x1b[${code}m${s}\x1b[0m` : s);

if (mode === 'cli') {
  const s = await snapshot({ force: !!flag('force') });
  if (s.error) console.log(c(33, '⚠ ' + s.error));
  for (const l of s.limits)
    console.log(`${l.label.padEnd(20)} ${c(color(l.pct), bar(l.pct))} ${String(Math.round(l.pct)).padStart(3)}%  Reset in ${fmtIn(l.resetsAt - s.now)}`);
  const t = s.tokens;
  console.log(`\nTokens  5h: ${fmtNum(t.fiveHour.total)}   Woche: ${fmtNum(t.week.total)}   Heute: ${fmtNum(t.today.total)}   ~${fmtNum(t.burnPerMin)}/min`);
} else if (mode === 'statusline') {
  // For Claude Code's statusLine setting. Runs locally, costs no tokens.
  // Drain stdin (Claude Code pipes session JSON) without blocking.
  process.stdin.resume(); process.stdin.on('data', () => {});
  const s = await snapshot();
  const f = s.limits.find(l => l.key === 'five_hour');
  const w = s.limits.find(l => l.key === 'seven_day');
  const part = (n, l) => l ? c(color(l.pct), `${n} ${Math.round(l.pct)}%`) + ` ↻${fmtIn(l.resetsAt - s.now)}` : `${n} –`;
  process.stdout.write(`${part('5h', f)} │ ${part('Wo', w)} │ ${fmtNum(s.tokens.fiveHour.total)} tok`);
  process.exit(0);
} else {
  const port = Number(flag('port') || process.env.PORT || 4747);
  const htmlPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html');
  const html = await readFile(htmlPath);
  createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/data')) {
        const body = JSON.stringify(await snapshot({ force: req.url.includes('force=1') }));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end(String(e?.message || e));
    }
  }).listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`Claude Usage Dashboard → ${url}  (Strg+C zum Beenden)`);
    if (flag('open')) exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} ${url}`);
  });
}
