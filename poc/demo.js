#!/usr/bin/env node
/**
 * poc/demo.js — xmrigger-proxy full integration demo
 *
 * Two XmrProxy instances, each with a mock Stratum pool, a real encrypted
 * xmrigger-mesh between them, and PrevhashMonitor detection wired end-to-end.
 *
 * No XMRig needed. No real pools. One command.
 *
 * Phases (15 s each, ~72 s total):
 *   SYNC   — both pools on same chain tip
 *   FORK   — Proxy B's pool switches to private chain
 *   [9 s]  — divergence confirmed, Proxy B evacuates
 *   REVEAL — Pool B reveals, chains sync
 *   SYNC2  — normal operation
 *
 * node poc/demo.js
 *
 * @license LGPL-2.1
 */
'use strict';

const net  = require('net');
const http = require('http');
const { XmrProxy } = require('..');

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R      = '\x1b[0m';
const B      = s => `\x1b[1m${s}${R}`;
const green  = s => `\x1b[32m${s}${R}`;
const yellow = s => `\x1b[33m${s}${R}`;
const red    = s => `\x1b[31m${s}${R}`;
const cyan   = s => `\x1b[36m${s}${R}`;
const grey   = s => `\x1b[90m${s}${R}`;
const magenta= s => `\x1b[35m${s}${R}`;

const ts  = () => new Date().toISOString().slice(11, 23);
function line(colour, label, msg) {
  process.stdout.write(`${grey(ts())}  ${colour(label.padEnd(18))}  ${msg}\n`);
}

// ── Mock prevhash values ──────────────────────────────────────────────────────
const BLOCK_100      = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f60100';
const BLOCK_101_PRIV = 'deadbeef0000deadbeef0000deadbeef0000deadbeef0000deadbeef00000101';
const BLOCK_101_PUB  = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a60101';

const PHASES = [
  { name: 'SYNC',   phA: BLOCK_100,      phB: BLOCK_100,      desc: 'Both pools on same chain tip' },
  { name: 'FORK',   phA: BLOCK_100,      phB: BLOCK_101_PRIV, desc: 'Pool B on private fork!' },
  { name: 'REVEAL', phA: BLOCK_101_PUB,  phB: BLOCK_101_PUB,  desc: 'Pool B reveals — chains sync' },
  { name: 'SYNC2',  phA: BLOCK_101_PUB,  phB: BLOCK_101_PUB,  desc: 'Normal operation resumed' },
];
const PHASE_MS = 15_000;
let phaseIdx = 0;

// ── Mock Stratum pool server ──────────────────────────────────────────────────
function startMockPool(getPrevhash) {
  return new Promise(resolve => {
    const srv = net.createServer(socket => {
      let buf = '';
      socket.on('data', d => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          // respond to login
          if (msg.method === 'login') {
            socket.write(JSON.stringify({
              id: msg.id, jsonrpc: '2.0',
              result: { id: 'miner1', job: {
                job_id: 'j1', prev_hash: getPrevhash(),
                blob: '0'.repeat(76), target: 'ffffffff', height: 3000000,
              }, status: 'OK' },
            }) + '\n');
          }
        }
      });
      // push new job every 3 s
      const iv = setInterval(() => {
        if (socket.destroyed) { clearInterval(iv); return; }
        socket.write(JSON.stringify({
          jsonrpc: '2.0', method: 'job',
          params: { job_id: 'j' + Date.now(), prev_hash: getPrevhash(),
                    blob: '0'.repeat(76), target: 'ffffffff', height: 3000000 },
        }) + '\n');
      }, 3000);
      socket.on('close', () => clearInterval(iv));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`
${B('╔══════════════════════════════════════════════════════════╗')}
${B('║')}       ${B('xmrigger-proxy — Full Integration Demo (v0.1.0)')}        ${B('║')}
${B('╠══════════════════════════════════════════════════════════╣')}
${B('║')}  Stack    : StratumProxy + HashrateGuard + MeshNode    ${B('║')}
${B('║')}  Transport: X25519 ECDH + AES-256-GCM + bucket pad    ${B('║')}
${B('║')}  Threshold: 9 s divergence before alert                ${B('║')}
${B('║')}  Phases   : SYNC → FORK → REVEAL → SYNC2  (15 s each) ${B('║')}
${B('╚══════════════════════════════════════════════════════════╝')}
`);

  // Start two mock pools
  const poolA = await startMockPool(() => PHASES[phaseIdx].phA);
  const poolB = await startMockPool(() => PHASES[phaseIdx].phB);
  line(cyan, '[mock-pools]', `Pool A :${poolA.port}  Pool B :${poolB.port}`);

  // Proxy A — mesh listens on random port, no seeds yet
  const proxyA = new XmrProxy({
    listenPort: 0,
    poolHost: '127.0.0.1', poolPort: poolA.port,
    name: 'Proxy-A (Pool-A honest)',
    mesh: { port: 0, seeds: [], divergenceMs: 9_000, pollIntervalMs: 3_000, minPeersForAlert: 1 },
  });

  // We need port A before starting B — override mesh port to a fixed one
  proxyA._meshConf.port = 19001;
  await proxyA.start();
  line(cyan, '[proxy-a]', `Stratum :${proxyA.listenPort}  mesh :19001`);

  // Proxy B — seeds to Proxy A's mesh
  const proxyB = new XmrProxy({
    listenPort: 0,
    poolHost: '127.0.0.1', poolPort: poolB.port,
    name: 'Proxy-B (Pool-B suspect)',
    mesh: { port: 19002, seeds: ['ws://127.0.0.1:19001'],
            divergenceMs: 9_000, pollIntervalMs: 3_000, minPeersForAlert: 1 },
  });
  await proxyB.start();
  line(cyan, '[proxy-b]', `Stratum :${proxyB.listenPort}  mesh :19002 → seed :19001`);

  await new Promise(r => setTimeout(r, 600));
  line(green, '[mesh]', 'encrypted sessions established');

  // ── Mock miners — keep Stratum pipeline alive so prevhash is extracted ────
  function attachMockMiner(proxyPort, label) {
    const sock = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    sock.on('connect', () => {
      sock.write(JSON.stringify({
        id: 1, method: 'login',
        params: { login: 'wallet_demo', pass: 'x', agent: 'demo-miner' },
      }) + '\n');
    });
    sock.on('error', () => {});
    sock.on('close', () => setTimeout(() => attachMockMiner(proxyPort, label), 2000));
    return sock;
  }
  attachMockMiner(proxyA.listenPort, 'miner-A');
  attachMockMiner(proxyB.listenPort, 'miner-B');
  await new Promise(r => setTimeout(r, 400));
  line(cyan, '[mock-miners]', `connected to proxy-A :${proxyA.listenPort}  proxy-B :${proxyB.listenPort}\n`);

  // ── Events ────────────────────────────────────────────────────────────────
  proxyA.on('prevhash-divergence', ({ ownPrevhash, divergentPeers, seenMs }) => {
    line(red, '🔴 [A] DIVERGE', `own=${ownPrevhash.slice(0,16)}… (${Math.round(seenMs/1000)}s)`);
    for (const p of divergentPeers)
      line(red, '   ↳ peer', `reports ${p.prevhash.slice(0,16)}…`);
  });
  proxyA.on('prevhash-resolved', () =>
    line(green, '✓ [A] SYNC', green('chains agree again')));

  proxyB.on('prevhash-divergence', ({ ownPrevhash, divergentPeers, seenMs }) => {
    line(red, '🔴 [B] DIVERGE', `own=${ownPrevhash.slice(0,16)}… (${Math.round(seenMs/1000)}s)`);
    for (const p of divergentPeers)
      line(red, '   ↳ peer', `reports ${p.prevhash.slice(0,16)}…`);
    line(red, '   🚨 alert', red('Pool-B on private fork — SELFISH MINING DETECTED'));
    line(yellow, '   action', 'evacuating miners from Pool-B → fallback');
  });
  proxyB.on('prevhash-resolved', () =>
    line(green, '✓ [B] SYNC', green('Pool-B back on public chain')));

  // ── Phase ticker ──────────────────────────────────────────────────────────
  const p0 = PHASES[0];
  line(magenta, '[phase →]', `${B(p0.name.padEnd(7))}  ${p0.desc}\n`);

  const phaseTimer = setInterval(() => {
    phaseIdx = Math.min(phaseIdx + 1, PHASES.length - 1);
    const p = PHASES[phaseIdx];
    line(magenta, '[phase →]', `${B(p.name.padEnd(7))}  ${p.desc}`);
  }, PHASE_MS);

  // ── Auto-exit ─────────────────────────────────────────────────────────────
  setTimeout(() => {
    clearInterval(phaseTimer);
    proxyA.stop(); proxyB.stop();
    poolA.srv.close(); poolB.srv.close();
    console.log(`\n${green('═'.repeat(60))}`);
    console.log(`${B(green('  Demo complete.'))}  Full stack: proxy + mesh + detection.`);
    console.log(green('═'.repeat(60)) + '\n');
    process.exit(0);
  }, PHASES.length * PHASE_MS + 12_000);
}

main().catch(e => { console.error(e); process.exit(1); });
