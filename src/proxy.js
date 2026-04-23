'use strict';
/**
 * proxy.js — XmrProxy: the integrated Monero mining proxy
 *
 * Combines:
 *   - StratumProxy   transparent TCP proxy, extracts prevhash
 *   - HashrateMonitor guard against pool hashrate concentration (>43%)
 *   - PrevhashMonitor guard against selfish mining via prevhash divergence
 *   - MeshNode        encrypted federation for cross-pool prevhash sharing
 *
 * XMRig points to 127.0.0.1:listenPort instead of the pool directly.
 * Everything else is automatic.
 *
 * @version  0.1.0
 * @released 2026-04-18
 * @license  LGPL-2.1
 */

const { EventEmitter }    = require('events');
const { StratumProxy }    = require('./stratum-proxy');
const { HashrateMonitor } = require('xmrigger');
const { PrevhashMonitor } = require('xmrigger');
const { MeshNode, OPEN }  = require('xmrigger-mesh');
const { createAlertQuorum } = require('./alert-quorum');

class XmrProxy extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.listenPort          Port for XMRig to connect to (default 3333)
   * @param {string} [opts.listenHost]        Bind address (default '127.0.0.1')
   *   Set to '0.0.0.0' when XMRig runs in a separate container or VM network namespace.
   * @param {string} opts.poolHost            Upstream pool host
   * @param {number} opts.poolPort            Upstream pool port (default 3333)
   * @param {string} [opts.name]              Proxy name shown in mesh
   * @param {object} [opts.guard]             Guard config
   * @param {number} [opts.guard.threshold]   Hashrate threshold (default 0.43)
   * @param {string} [opts.guard.statsUrl]    Independent pool stats URL
   * @param {string} [opts.guard.healthUrl]   Pool /health endpoint
   * @param {object[]} [opts.guard.fallbacks] Fallback pools [{host,port}]
   * @param {object} [opts.mesh]              Mesh config
   * @param {number} [opts.mesh.port]         Mesh listen port (default 8765)
   * @param {string[]} [opts.mesh.seeds]      Peer seed URLs
   * @param {number} [opts.mesh.divergenceMs]  Divergence threshold ms (default 20000)
   * @param {number} [opts.mesh.minAlertPeers] Quorum of peers required before a GUARD_ALERT
   *   triggers a local poll (default: same as minPeersForAlert, min 2).
   *   Prevents a single low-threshold node from flooding the federation with polls.
   * @param {number} [opts.mesh.alertWindowMs] Time window in ms for collecting quorum alerts
   *   from distinct peers (default 60000). Alerts older than this window are discarded.
   */
  constructor({
    listenPort = 3333,
    listenHost,
    poolHost,
    poolPort   = 3333,
    name       = 'xmrigger-proxy',
    guard      = {},
    mesh       = {},
  } = {}) {
    super();

    if (!poolHost) throw new Error('poolHost is required');

    this.name       = name;
    this.listenPort = listenPort;
    this.listenHost = listenHost || '127.0.0.1';
    this.poolHost   = poolHost;
    this.poolPort   = poolPort;
    this._guard     = guard;
    this._meshConf  = mesh;

    this.stratum          = null;
    this.hashrateMonitor  = null;
    this.prevhashMonitor  = null;
    this.meshNode         = null;
  }

  async start() {
    // ── Stratum proxy ──────────────────────────────────────────────────────
    this.stratum = new StratumProxy({
      listenPort: this.listenPort,
      listenHost: this.listenHost,
      poolHost:   this.poolHost,
      poolPort:   this.poolPort,
    });
    await this.stratum.start();
    this.listenPort = this.stratum._server.address().port;

    // ── Hashrate guard ─────────────────────────────────────────────────────
    const g = this._guard;
    if (g.statsUrl || g.healthUrl) {
      this.hashrateMonitor = new HashrateMonitor({
        poolStatsUrl:   g.statsUrl  || null,
        poolHealthUrl:  g.healthUrl || null,
        threshold:      g.threshold      || 0.43,
        pollIntervalMs: g.pollIntervalMs || 30_000,
        gracePeriodMs:  g.gracePeriodMs  || 60_000,
        fallbackPools:  g.fallbacks      || [],
      });

      this.hashrateMonitor.on('warn',  ({ hashratePct }) => {
        this._log('warn', `pool at ${pct(hashratePct)} — approaching threshold`);
        this.emit('guard-warn', { hashratePct });
      });
      this.hashrateMonitor.on('crit',  ({ hashratePct }) => {
        this._log('crit', `pool at ${pct(hashratePct)} — grace period started`);
        this.emit('guard-crit', { hashratePct });
        // hint federation peers — they decide independently via their own threshold
        this.meshNode?.broadcast(OPEN.GUARD_ALERT, {
          reason: 'hashrate-threshold',
          pool:   `${this.poolHost}:${this.poolPort}`,
        });
      });
      this.hashrateMonitor.on('fork',  () => {
        this._log('crit', 'fork detected — evacuating immediately');
        this.emit('guard-fork');
        this.meshNode?.broadcast(OPEN.GUARD_ALERT, {
          reason: 'fork',
          pool:   `${this.poolHost}:${this.poolPort}`,
        });
      });
      this.hashrateMonitor.on('evacuate', ({ reason, fallback }) => {
        this._onEvacuate(reason, fallback);
      });
      this.hashrateMonitor.on('safe',  ({ hashratePct }) => {
        this._log('info', `pool safe at ${pct(hashratePct)}`);
        this.emit('guard-safe', { hashratePct });
      });

      this.hashrateMonitor.start();
      this._log('info', `hashrate guard active — threshold ${pct(g.threshold || 0.43)}`);
    }

    // ── Mesh node + prevhash guard ─────────────────────────────────────────
    const m = this._meshConf;
    if (m.port != null || (m.seeds && m.seeds.length > 0)) {
      this.meshNode = new MeshNode({
        port:  m.port ?? 8765,
        seeds: m.seeds || [],
        name:  this.name,
        minPeersForAlert: m.minAlertPeers || m.minPeersForAlert || 2,
      });
      await this.meshNode.start();

      this.prevhashMonitor = new PrevhashMonitor({
        poolId:           `${this.poolHost}:${this.poolPort}`,
        getPrevhash:      () => this.stratum.lastPrevhash,
        pollIntervalMs:   m.pollIntervalMs   || 5_000,
        divergenceMs:     m.divergenceMs     || 20_000,
        minPeersForAlert: m.minAlertPeers || m.minPeersForAlert || 2,
      });

      // stratum prevhash → mesh broadcast
      this.prevhashMonitor.on('announce', ({ prevhash }) => {
        this.meshNode.broadcast(OPEN.PREVHASH_ANNOUNCE, {
          prevhash,
          pool: `${this.poolHost}:${this.poolPort}`,
        });
      });

      // mesh peer announcements → prevhash monitor; track per-peer pool for stats
      this._peerInfo = new Map();
      this.meshNode.on(OPEN.PREVHASH_ANNOUNCE, ({ payload, peerId }) => {
        // Validate and cap untrusted peer fields to prevent memory exhaustion
        const pool     = typeof payload.pool     === 'string' ? payload.pool.slice(0, 128)     : null;
        const prevhash = typeof payload.prevhash === 'string' ? payload.prevhash.slice(0, 128) : null;
        if (pool) this._peerInfo.set(peerId, { pool });
        if (prevhash) this.prevhashMonitor.onPeerAnnounce(peerId, prevhash);
      });

      // mesh guard alerts — require quorum before acting
      // A single peer with a low threshold must not force polls on everyone.
      // Only trigger pollNow() when minAlertPeers distinct peers agree within
      // the alert window (alertWindowMs). Each node still uses its own
      // local threshold to decide whether to actually evacuate.
      const minAlertPeers = m.minAlertPeers || m.minPeersForAlert || 2;
      const alertWindowMs = m.alertWindowMs || 60_000;

      const quorum = createAlertQuorum({
        minAlertPeers,
        alertWindowMs,
        onQuorum: (key) => {
          this._log('warn', `quorum reached for ${key} — polling now`);
          if (this.hashrateMonitor) this.hashrateMonitor.pollNow();
        },
      });

      this.meshNode.on(OPEN.GUARD_ALERT, ({ payload, peerId }) => {
        // Cap untrusted strings before logging or passing to quorum
        const reason = typeof payload.reason === 'string' ? payload.reason.slice(0, 64)  : 'unknown';
        const pool   = typeof payload.pool   === 'string' ? payload.pool.slice(0, 128)   : 'unknown';
        this._log('warn', `federation alert: ${reason} on ${pool} from ${peerId}`);
        quorum.receive({ payload: { reason, pool }, peerId });
      });

      this.prevhashMonitor.on('divergence', ({ ownPrevhash, divergentPeers, seenMs }) => {
        this._log('crit',
          `SELFISH MINING DETECTED — own=${ownPrevhash.slice(0,16)}… ` +
          `divergent peers: ${divergentPeers.length}  (${Math.round(seenMs/1000)}s)`
        );
        this.emit('prevhash-divergence', { ownPrevhash, divergentPeers, seenMs });
        // broadcast alert to federation peers
        this.meshNode.broadcast(OPEN.GUARD_ALERT, {
          reason: 'selfish-mining',
          pool:   `${this.poolHost}:${this.poolPort}`,
        });
        // evacuate to first fallback
        const fb = (this._guard.fallbacks || [])[0];
        if (fb) this._onEvacuate('selfish-mining', fb);
      });

      this.prevhashMonitor.on('resolved', ({ prevhash }) => {
        this._log('info', `prevhash sync restored — ${prevhash.slice(0,16)}…`);
        this.emit('prevhash-resolved', { prevhash });
      });

      this.prevhashMonitor.start();
      this._log('info',
        `prevhash guard active — mesh peers: ${(m.seeds || []).length} seed(s)  ` +
        `divergence-threshold: ${(m.divergenceMs || 20_000) / 1000}s`
      );
    }

    this._log('info',
      `listening on ${this.listenHost}:${this.listenPort}  →  ${this.poolHost}:${this.poolPort}`
    );
    this.emit('ready', { listenPort: this.listenPort });
    return this;
  }

  stop() {
    if (this.stratum)         this.stratum.stop();
    if (this.hashrateMonitor) this.hashrateMonitor.stop();
    if (this.prevhashMonitor) this.prevhashMonitor.stop();
    if (this.meshNode)        this.meshNode.stop();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _onEvacuate(reason, fallback) {
    if (fallback) {
      this._log('warn',
        `EVACUATE (${reason}) → ${fallback.host}:${fallback.port}`
      );
      this.poolHost = fallback.host;
      this.poolPort = fallback.port;
      // Update stratum proxy target — new connections go to fallback
      this.stratum.poolHost = fallback.host;
      this.stratum.poolPort = fallback.port;
    } else {
      this._log('crit', `EVACUATE (${reason}) — no fallback configured`);
    }
    this.emit('evacuate', { reason, fallback });
  }

  _log(level, msg) {
    const prefix = { info: '[info]', warn: '[warn]', crit: '[CRIT]' }[level] || '[info]';
    console.log(`[xmrigger-proxy] ${prefix} ${msg}`);
  }
}

function pct(v) { return `${((v || 0) * 100).toFixed(1)}%`; }

module.exports = { XmrProxy };
