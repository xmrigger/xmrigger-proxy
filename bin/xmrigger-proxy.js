#!/usr/bin/env node
/**
 * bin/xmrigger-proxy.js — CLI entry point
 *
 * Usage:
 *   xmrigger-proxy --pool pool.hashvault.pro:3333 [options]
 *
 * Then point XMRig to 127.0.0.1:3333 instead of the pool directly.
 *
 * Options:
 *   --pool        <host:port>     Upstream pool (required)
 *   --listen      <port>          Local Stratum port for XMRig (default: 3333)
 *   --bind        <host>          Bind address (default: 127.0.0.1)
 *                                 Use 0.0.0.0 when miner runs in a separate container or VM.
 *   --name        <name>          Node name shown in mesh
 *   --fallback    <host:port>     Fallback pool (repeatable)
 *   --threshold   <0.0-1.0>       Hashrate concentration threshold (default: 0.43)
 *   --health      <url>           Pool /health endpoint URL
 *   --stats       <url>           Independent pool stats URL
 *   --mesh-port   <port>          Mesh listen port (default: 8765)
 *   --seed        <wss://url>     Mesh seed peer (repeatable)
 *   --divergence    <seconds>       Prevhash divergence threshold (default: 20)
 *   --alert-quorum  <n>             Peers that must agree before a GUARD_ALERT triggers
 *                                   a local poll (default: 2 — one peer never enough)
 *   --alert-window  <seconds>       Window in which quorum is collected (default: 60)
 *
 * @license LGPL-2.1
 */
'use strict';

const { XmrProxy } = require('../src/proxy');

// ── Arg parsing ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

function get(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
function getAll(name) {
  const out = [];
  for (let i = 0; i < argv.length - 1; i++)
    if (argv[i] === '--' + name) out.push(argv[i + 1]);
  return out;
}

const poolArg    = get('pool', null);
const listenPort = parseInt(get('listen', '3333'));
const listenHost = get('bind', '127.0.0.1');
const name       = get('name', 'xmrigger-proxy');
const threshold  = parseFloat(get('threshold', '0.43'));
const healthUrl  = get('health', null);
const statsUrl   = get('stats',  null);
const meshPort    = parseInt(get('mesh-port', '8765'));
const divergence  = parseInt(get('divergence', '20')) * 1000;
const alertQuorum = parseInt(get('alert-quorum', '2'));
const alertWindow = parseInt(get('alert-window', '60')) * 1000;
const fallbacks   = getAll('fallback').map(s => {
  const [host, port] = s.split(':');
  return { host, port: parseInt(port) || 3333 };
});
const seeds = getAll('seed');

if (!poolArg) {
  console.error('[xmrigger-proxy] --pool <host:port> is required');
  process.exit(1);
}

const [poolHost, poolPortStr] = poolArg.split(':');
const poolPort = parseInt(poolPortStr) || 3333;

// ── Banner ────────────────────────────────────────────────────────────────────
console.log(`
┌─────────────────────────────────────────────────────┐
│           xmrigger-proxy  v0.1.0                   │
├─────────────────────────────────────────────────────┤
│  Pool       ${(poolHost + ':' + poolPort).padEnd(39)}│
│  Listen     ${(listenHost + ':' + listenPort).padEnd(39)}│
│  Threshold  ${(threshold * 100).toFixed(0).padEnd(38)}%│
│  Fallbacks  ${String(fallbacks.length).padEnd(39)}│
│  Mesh seeds ${String(seeds.length).padEnd(39)}│
└─────────────────────────────────────────────────────┘
`);
console.log(`  Point XMRig to:  --url ${listenHost}:${listenPort}\n`);

// ── Start ─────────────────────────────────────────────────────────────────────
const proxy = new XmrProxy({
  listenPort,
  listenHost,
  poolHost,
  poolPort,
  name,
  guard: {
    statsUrl,
    healthUrl,
    threshold,
    fallbacks,
  },
  mesh: {
    port:          meshPort,
    seeds,
    divergenceMs:  divergence,
    minAlertPeers: alertQuorum,
    alertWindowMs: alertWindow,
  },
});

proxy.on('evacuate', ({ reason, fallback }) => {
  if (!fallback) console.error('[xmrigger-proxy] No fallback — staying on current pool');
});

proxy.start().catch(e => {
  console.error('[xmrigger-proxy] Fatal:', e.message);
  process.exit(1);
});

function shutdown() {
  console.log('\n[xmrigger-proxy] shutting down…');
  proxy.stop();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

