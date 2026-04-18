#!/usr/bin/env node
/**
 * poc/mock-miner.js — minimal Stratum miner CLI
 *
 * Connects to xmrigger-proxy (or any Stratum pool) and prints every
 * job notification it receives, including the prevhash field.
 * No XMRig needed — useful for verifying the proxy is alive and passing
 * jobs through correctly.
 *
 * Usage:
 *   node poc/mock-miner.js [--url 127.0.0.1:3333] [--wallet <addr>]
 *
 * @version  0.1.0
 * @released 2026-04-18
 * @license  LGPL-2.1
 */
'use strict';

const net = require('net');

const argv  = process.argv.slice(2);
const get   = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i+1] ? argv[i+1] : d; };
const url   = get('--url', '127.0.0.1:3333');
const wallet= get('--wallet', 'MOCK_WALLET_ADDRESS');

const [host, portStr] = url.split(':');
const port = parseInt(portStr) || 3333;

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R      = '\x1b[0m';
const B      = s => `\x1b[1m${s}${R}`;
const green  = s => `\x1b[32m${s}${R}`;
const cyan   = s => `\x1b[36m${s}${R}`;
const yellow = s => `\x1b[33m${s}${R}`;
const grey   = s => `\x1b[90m${s}${R}`;
const red    = s => `\x1b[31m${s}${R}`;
const ts     = () => new Date().toISOString().slice(11, 23);
const log    = (col, lbl, msg) =>
  process.stdout.write(`${grey(ts())}  ${col(lbl.padEnd(14))}  ${msg}\n`);

console.log(`
${B('┌─────────────────────────────────────────────┐')}
${B('│')}       ${B('xmrigger-proxy — mock miner')}            ${B('│')}
${B('│')}  connecting to ${B(url.padEnd(29))}${B('│')}
${B('└─────────────────────────────────────────────┘')}
`);

let jobCount = 0;
let buf = '';

const sock = net.createConnection({ host, port }, () => {
  log(cyan, '[connected]', `${host}:${port}`);

  // Stratum login
  sock.write(JSON.stringify({
    id: 1, method: 'login',
    params: { login: wallet, pass: 'x', agent: 'mock-miner/0.1' },
  }) + '\n');
  log(cyan, '[login →]', `wallet=${wallet.slice(0, 20)}…`);
});

sock.on('data', d => {
  buf += d.toString();
  const lines = buf.split('\n'); buf = lines.pop();
  for (const line of lines) {
    let msg; try { msg = JSON.parse(line); } catch { continue; }

    // Login response — contains first job
    if (msg.id === 1 && msg.result) {
      const r = msg.result;
      log(green, '[login ✓]', `miner id=${r.id || '?'}`);
      if (r.job) printJob(r.job, 'initial');
      continue;
    }

    // Job notification
    if (msg.method === 'job' && msg.params) {
      printJob(msg.params, 'notify');
      continue;
    }

    // Error
    if (msg.error) {
      log(red => red, '[error]', JSON.stringify(msg.error));
    }
  }
});

sock.on('error', e => { log(red, '[error]', e.message); process.exit(1); });
sock.on('close', ()  => { log(yellow, '[closed]', 'connection closed'); process.exit(0); });

function printJob(job, src) {
  jobCount++;
  const ph = job.prev_hash || job.prevhash || null;
  log(green, `[job #${jobCount}]`, `src=${src}  id=${job.job_id || '?'}`);
  if (ph) {
    log(cyan, '  prevhash', B(ph));
  } else {
    // dump all fields so we can see the real field name
    log(yellow, '  fields', Object.keys(job).join(', '));
  }
  if (job.height)  log(grey, '  height',   String(job.height));
  if (job.target)  log(grey, '  target',   job.target);
}
