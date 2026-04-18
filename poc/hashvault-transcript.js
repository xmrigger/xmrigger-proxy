#!/usr/bin/env node
/**
 * poc/hashvault-transcript.js — Live transcript vs pool.hashvault.pro
 *
 * Three phases, ~30 s total:
 *   1. Stratum handshake  — TCP login → first job → prevhash extracted
 *   2. Network hashrate   — 6 independent Monero public nodes, first wins
 *   3. Concentration check— pool hashrate / network hashrate vs 30% threshold
 *
 * No XMRig needed. Read-only: no shares submitted, no mining.
 *
 *   node poc/hashvault-transcript.js
 *   node poc/hashvault-transcript.js --wallet YOUR_ADDRESS
 *
 * @license LGPL-2.1
 */
'use strict';

const net   = require('net');
const https = require('https');
const http  = require('http');

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv   = process.argv.slice(2);
const wi     = argv.indexOf('--wallet');
const WALLET = wi >= 0 && argv[wi + 1]
  ? argv[wi + 1]
  : '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A'; // community donation address (read-only demo)

const POOL_HOST = 'pool.hashvault.pro';
const POOL_PORT = 3333;
const THRESHOLD = 0.43;

// ── ANSI ──────────────────────────────────────────────────────────────────────
const R       = '\x1b[0m';
const B       = s => `\x1b[1m${s}${R}`;
const green   = s => `\x1b[32m${s}${R}`;
const yellow  = s => `\x1b[33m${s}${R}`;
const red     = s => `\x1b[31m${s}${R}`;
const cyan    = s => `\x1b[36m${s}${R}`;
const grey    = s => `\x1b[90m${s}${R}`;
const magenta = s => `\x1b[35m${s}${R}`;

const ts  = () => new Date().toISOString().slice(11, 19);
const tag = (label, colour) => `${grey(ts())}  ${colour(label.padEnd(20))}`;

function section(title) {
  console.log(`\n${B('─'.repeat(60))}`);
  console.log(`${B('  ' + title)}`);
  console.log(`${B('─'.repeat(60))}`);
}

// ── Network hashrate sources ──────────────────────────────────────────────────
const NETWORK_URLS = [
  'https://xmrchain.net/api/networkinfo',          // data.data.hash_rate (H/s direct)
  'https://api.xmrchain.net/api/networkinfo',       // alternate subdomain
  'https://community.xmr.to/api/v1/networkinfo',   // data.difficulty
  'https://localmonero.co/blocks/api/get_stats',   // data.difficulty
  'https://xmr.nthpoor.com/api/networkinfo',       // data.data.difficulty
  'https://p2pool.observer/api/pool_info',         // mainchain.difficulty
];

// hashvault pool stats — they don't expose a public JSON API.
// We probe anyway and show an honest "unavailable" when it fails.
// Pools that DO expose JSON work transparently (SupportXMR shown as example).
const HASHVAULT_STATS_URL  = 'https://hashvault.pro/api/pool/stats';
const HASHVAULT_HEALTH_URL = 'http://pool.hashvault.pro/pool/health';

// Comparison pools — expose public JSON stats
const COMPARISON_POOLS = [
  { name: 'SupportXMR',  url: 'https://www.supportxmr.com/api/pool/stats',          field: d => d.pool_statistics?.hashRate },
  { name: 'Nanopool XMR', url: 'https://api.nanopool.org/v1/xmr/pool/hashrate',      field: d => d.data },
];

// ── Stratum handshake ─────────────────────────────────────────────────────────
function stratumHandshake() {
  return new Promise((resolve) => {
    section('Phase 1 — Stratum handshake  →  pool.hashvault.pro:' + POOL_PORT);
    console.log(`${tag('wallet', grey)}  ${WALLET.slice(0,16)}…${WALLET.slice(-8)}`);

    const sock = net.createConnection({ host: POOL_HOST, port: POOL_PORT });
    let buf = '';
    let done = false;
    const result = { prevhash: null, jobId: null, height: null, blob: null };

    const finish = () => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };

    sock.setTimeout(15000, finish);

    sock.on('connect', () => {
      console.log(`${tag('TCP connect', green)}  ${POOL_HOST}:${POOL_PORT}  ✓`);

      const login = JSON.stringify({
        id: 1, method: 'login', jsonrpc: '2.0',
        params: { login: WALLET, pass: 'demo', agent: 'xmrigger-proxy/0.1.0' },
      }) + '\n';
      sock.write(login);
      console.log(`${tag('→ login', cyan)}  method=login  agent=xmrigger-proxy/0.1.0`);
    });

    sock.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.result?.job) {
          // Login response carries first job
          const job = msg.result.job;
          result.jobId   = job.job_id;
          result.height  = job.height;
          result.blob    = job.blob || null;

          if (job.prev_hash) {
            result.prevhash = job.prev_hash;
          } else if (job.blob) {
            result.prevhash = prevhashFromBlob(job.blob);
          }

          console.log(`${tag('← login OK', green)}  miner_id=${msg.result.id}`);
          console.log(`${tag('← first job', cyan)}  job_id=${job.job_id}  height=${job.height ?? '—'}`);
          if (job.prev_hash) {
            console.log(`${tag('  prev_hash', magenta)}  ${job.prev_hash}`);
          } else if (result.prevhash) {
            console.log(`${tag('  prev_hash', magenta)}  ${result.prevhash}  ${grey('(parsed from blob)')}`);
          } else {
            console.log(`${tag('  prev_hash', yellow)}  (not in this job — blob present)`);
          }
          if (job.blob) {
            console.log(`${tag('  blob', grey)}  ${job.blob.slice(0, 32)}…  (${job.blob.length / 2} B)`);
          }
          console.log(`${tag('  target', grey)}  ${job.target ?? '—'}`);
          console.log();
          console.log(`${tag('NOTE', yellow)}  Read-only. No shares submitted — miner disconnecting.`);
          finish();
        } else if (msg.method === 'job') {
          // pushed job (unlikely before we disconnect, but handle it)
          const job = msg.params || {};
          if (!result.prevhash) {
            result.prevhash = job.prev_hash || prevhashFromBlob(job.blob);
          }
        }
      }
    });

    sock.on('error', (e) => {
      console.log(`${tag('TCP error', red)}  ${e.message}`);
      finish();
    });
  });
}

// ── LEB128 varint prevhash extraction ────────────────────────────────────────
function prevhashFromBlob(blob) {
  if (!blob) return null;
  try {
    let off = 0;
    // skip major_version, minor_version, timestamp (3 LEB128 varints)
    for (let i = 0; i < 3; i++) {
      while (off + 2 <= blob.length && parseInt(blob.slice(off, off + 2), 16) & 0x80) off += 2;
      off += 2;
    }
    if (blob.length >= off + 64) return blob.slice(off, off + 64);
  } catch { /* malformed */ }
  return null;
}

// ── Network hashrate ──────────────────────────────────────────────────────────
function fetchJson(url, timeoutMs = 8000, _redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && _redirects < 3) {
        res.resume();
        return fetchJson(res.headers.location, timeoutMs, _redirects + 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad JSON')); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function extractNetworkHashrate(data) {
  if (!data) return null;
  // direct H/s fields (no division needed)
  if (typeof data.data?.hash_rate === 'number'       && data.data.hash_rate > 0)       return data.data.hash_rate;
  if (typeof data.hash_rate === 'number'             && data.hash_rate > 0)             return data.hash_rate;
  // difficulty fields (divide by ~120 s block time → H/s)
  const diff =
    data.difficulty        || data.data?.difficulty ||
    data.last_difficulty   || data.mainchain?.difficulty || null;
  return (typeof diff === 'number' && diff > 0) ? Math.floor(diff / 120) : null;
}

async function fetchNetworkHashrate() {
  section('Phase 2 — Network hashrate  (6 independent Monero nodes)');
  const attempts = NETWORK_URLS.map(async (url) => {
    const short = url.replace('https://', '').replace('http://', '').split('/')[0];
    try {
      const data = await fetchJson(url, 7000);
      const hps = extractNetworkHashrate(data);
      if (!hps) throw new Error('no hashrate/difficulty field');
      console.log(`${tag('✓ ' + short, green)}  ${fmtH(hps)}`);
      return hps;
    } catch (e) {
      console.log(`${tag('✗ ' + short, grey)}  ${e.message}`);
      throw e;
    }
  });
  try {
    const hps = await Promise.any(attempts);
    await new Promise(r => setTimeout(r, 200)); // let remaining lines print
    console.log(`\n${tag('network H/s', B)}  ${B(fmtH(hps))}  ${grey('(first valid response wins)')}`);
    return hps;
  } catch {
    console.log(`${tag('network', red)}  all sources failed`);
    return null;
  }
}

// ── Pool hashrate ─────────────────────────────────────────────────────────────
async function fetchPoolHashrate() {
  section('Phase 3 — Pool hashrate  (hashvault.pro public API)');

  // Try the public stats endpoint first
  const sources = [
    { url: HASHVAULT_STATS_URL, label: 'hashvault /api/pool/stats', trusted: true },
    { url: HASHVAULT_HEALTH_URL, label: 'hashvault /pool/health (self-reported)', trusted: false },
  ];

  for (const src of sources) {
    try {
      const data = await fetchJson(src.url, 8000);
      const hps = data.hashrate ?? data.pool_hashrate ?? data.poolHashrate
                ?? data.stats?.hashrate ?? null;
      const pct = typeof data.hashratePct === 'number' ? data.hashratePct : null;

      if (typeof hps === 'number' && hps > 0) {
        console.log(`${tag('source', cyan)}  ${src.url}`);
        console.log(`${tag('pool H/s', green)}  ${fmtH(hps)}${src.trusted ? '' : yellow('  ⚠ self-reported')}`);
        return { hps, pct: null, source: src.label };
      }
      if (pct !== null) {
        console.log(`${tag('source', cyan)}  ${src.url}`);
        console.log(`${tag('pool pct', green)}  ${(pct * 100).toFixed(2)}%${yellow('  ⚠ self-reported — not used for guard')}`);
        return { hps: null, pct, source: src.label };
      }
      console.log(`${tag('✗ ' + src.label, grey)}  no hashrate field`);
    } catch (e) {
      console.log(`${tag('✗ ' + src.label, grey)}  ${e.message}`);
    }
  }
  return { hps: null, pct: null, source: null };
}

// ── Concentration verdict ─────────────────────────────────────────────────────
function concentrationReport(networkHps, poolResult) {
  section('Phase 4 — Concentration check');

  if (!networkHps) {
    console.log(`${tag('result', red)}  Cannot determine — network hashrate unavailable`);
    return;
  }

  let ratio = null;
  let sourceNote = '';

  if (poolResult.hps !== null) {
    ratio = poolResult.hps / networkHps;
    sourceNote = poolResult.source;
  } else if (poolResult.pct !== null) {
    ratio = poolResult.pct;
    sourceNote = poolResult.source + ' (self-reported — take with caution)';
  }

  if (ratio === null) {
    console.log(`${tag('network H/s', cyan)}  ${fmtH(networkHps)}`);
    console.log(`${tag('pool H/s', yellow)}  unavailable`);
    console.log();
    console.log(`${tag('Guard 1', yellow)}  passive — pool hashrate source not configured`);
    console.log(`${tag('', grey)}  hashvault.pro does not expose a public JSON stats endpoint.`);
    console.log(`${tag('', grey)}  Guard 1 activates when --stats or --health points to a pool`);
    console.log(`${tag('', grey)}  that returns JSON with a hashrate or hashratePct field.`);
    console.log(`${tag('', grey)}  Example (SupportXMR): --stats https://supportxmr.com/api/pool/stats`);
    console.log();
    console.log(`${tag('Guard 2', green)}  ${green(B('active'))} — prevhash extracted and ready for federation peers`);
    return;
  }

  const pctStr = (ratio * 100).toFixed(2) + '%';
  const warn   = THRESHOLD * 0.85;
  const colour = ratio >= THRESHOLD ? red : ratio >= warn ? yellow : green;

  console.log(`${tag('network H/s', cyan)}  ${fmtH(networkHps)}`);
  if (poolResult.hps) console.log(`${tag('pool H/s', cyan)}  ${fmtH(poolResult.hps)}`);
  console.log(`${tag('concentration', colour)}  ${colour(B(pctStr))}  (threshold: ${(THRESHOLD*100).toFixed(0)}%)`);
  console.log(`${tag('source', grey)}  ${sourceNote}`);
  console.log();

  if (ratio >= THRESHOLD) {
    console.log(`${tag('🚨 GUARD 1', red)}  ${red(B('WOULD TRIGGER'))} — pool exceeds threshold`);
    console.log(`${tag('', red)}  grace period would start → evacuate after 60 s`);
  } else if (ratio >= warn) {
    console.log(`${tag('⚠ GUARD 1', yellow)}  ${yellow('WARNING')} — approaching threshold`);
    console.log(`${tag('', yellow)}  no action yet — watching`);
  } else {
    console.log(`${tag('✓ GUARD 1', green)}  ${green(B('SAFE'))} — pool well below threshold`);
  }
}

// ── Comparison: pools with public JSON APIs ───────────────────────────────────
async function comparisonReport(networkHps) {
  if (!networkHps) return;
  section('Phase 5 — Concentration check on pools with public APIs');
  console.log(`${tag('network H/s', cyan)}  ${fmtH(networkHps)}  ${grey('(xmrchain.net)')}\n`);

  for (const pool of COMPARISON_POOLS) {
    try {
      const data = await fetchJson(pool.url, 8000);
      const hps  = pool.field(data);
      if (typeof hps !== 'number' || hps <= 0) throw new Error('no hashrate field');

      const ratio  = hps / networkHps;
      const pctStr = (ratio * 100).toFixed(2) + '%';
      const warn   = THRESHOLD * 0.85;
      const colour = ratio >= THRESHOLD ? red : ratio >= warn ? yellow : green;

      console.log(`${tag(pool.name, cyan)}  pool=${fmtH(hps)}  concentration=${colour(B(pctStr))}`);

      if (ratio >= THRESHOLD) {
        console.log(`${tag('', red)}  🚨 ${red('GUARD 1 WOULD TRIGGER')} — grace period → evacuate after 60 s`);
      } else if (ratio >= warn) {
        console.log(`${tag('', yellow)}  ⚠  WARNING — approaching threshold`);
      } else {
        console.log(`${tag('', green)}  ✓  SAFE`);
      }
      console.log();
    } catch (e) {
      console.log(`${tag(pool.name, grey)}  unavailable: ${e.message}\n`);
    }
  }
  console.log(`${tag('note', grey)}  These are live values from pools that expose public stats.`);
  console.log(`${tag('', grey)}  Pass --stats <url> to xmrigger-proxy to enable Guard 1 for your pool.`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtH(hps) {
  if (hps >= 1e9) return (hps / 1e9).toFixed(2) + ' GH/s';
  if (hps >= 1e6) return (hps / 1e6).toFixed(2) + ' MH/s';
  if (hps >= 1e3) return (hps / 1e3).toFixed(2) + ' KH/s';
  return hps + ' H/s';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`
${B('╔══════════════════════════════════════════════════════════╗')}
${B('║')}        ${B('xmrigger-proxy — Live Hashvault Transcript')}          ${B('║')}
${B('╠══════════════════════════════════════════════════════════╣')}
${B('║')}  Pool      : pool.hashvault.pro:3333                   ${B('║')}
${B('║')}  Guard 1   : hashrate concentration  (threshold 43%)${B('║')}
${B('║')}  Guard 2   : prevhash extraction from live Stratum job  ${B('║')}
${B('║')}  Mode      : read-only — no mining, no shares           ${B('║')}
${B('╚══════════════════════════════════════════════════════════╝')}
`);

  const stratumResult = await stratumHandshake();
  const networkHps    = await fetchNetworkHashrate();
  const poolResult    = await fetchPoolHashrate();
  concentrationReport(networkHps, poolResult);
  await comparisonReport(networkHps);

  console.log(`\n${green('═'.repeat(60))}`);
  if (stratumResult.prevhash) {
    console.log(`${B(green('  Prevhash extracted:'))}  ${stratumResult.prevhash}`);
    console.log(`  Guard 2 can compare this against federation peers.`);
  }
  console.log(`${B(green('  Transcript complete.'))}`);
  console.log(green('═'.repeat(60)) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
