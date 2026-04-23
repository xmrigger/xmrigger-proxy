'use strict';
/**
 * stats-server.js — local HTTP stats endpoint for xmrigger-widget
 *
 * Exposes GET http://127.0.0.1:{port}/stats as JSON.
 * Wires into XmrProxy events so state stays current.
 *
 * No external dependencies — only Node.js built-in 'http'.
 *
 * @license LGPL-2.1
 */

const http = require('http');

class StatsServer {
  /**
   * @param {import('./proxy').XmrProxy} proxy
   * @param {number} [port=9090]
   */
  constructor(proxy, port = 9090) {
    this._proxy  = proxy;
    this._port   = port;
    this._server = null;

    this._state = {
      status:      'starting',   // starting | running | safe | warn | crit | evacuating
      pool:        null,         // 'host:port' of current upstream
      hashratePct: null,         // 0.0–1.0, null when unknown
      alert:       null,         // null | 'approaching-threshold' | 'threshold-exceeded' | 'fork' | 'selfish-mining' | reason string
      peers:       0,            // mesh peers currently connected
      connections: 0,            // miners currently connected to the local stratum proxy
      listenPort:  null,         // local Stratum port XMRig connects to
      threshold:   0.43,
      uptime:      Date.now(),
      peerList:    [],           // [{id, pool, hashratePct}] per connected mesh peer
    };
  }

  /** Wire proxy events. Call before start(). */
  wire() {
    const p = this._proxy;

    p.on('ready', ({ listenPort }) => {
      this._patch({
        status:      'running',
        listenPort,
        pool:        `${p.poolHost}:${p.poolPort}`,
        threshold:   p._guard?.threshold ?? 0.43,
      });
    });

    p.on('guard-safe',  ({ hashratePct }) => this._patch({ hashratePct, status: 'safe',       alert: null }));
    p.on('guard-warn',  ({ hashratePct }) => this._patch({ hashratePct, status: 'warn',       alert: 'approaching-threshold' }));
    p.on('guard-crit',  ({ hashratePct }) => this._patch({ hashratePct, status: 'crit',       alert: 'threshold-exceeded' }));
    p.on('guard-fork',  ()               => this._patch({              status: 'crit',       alert: 'fork' }));
    p.on('prevhash-divergence', ()       => this._patch({              status: 'crit',       alert: 'selfish-mining' }));
    p.on('prevhash-resolved',   ()       => this._patch({              status: 'safe',       alert: null }));
    p.on('evacuate', ({ reason, fallback }) => {
      this._patch({
        status: 'evacuating',
        alert:  reason,
        pool:   fallback ? `${fallback.host}:${fallback.port}` : this._state.pool,
      });
    });

    // Sync live counters and latest hashratePct every 5s.
    // HashrateMonitor emits 'safe' only on transitions, so without this
    // the widget would show a stale pct between guard-state changes.
    this._peerTimer = setInterval(() => {
      const updates = {};
      if (p.meshNode) {
        updates.peers    = p.meshNode._sessions.size;
        updates.peerList = Array.from(p.meshNode._sessions.keys()).map(peerId => ({
          id:          peerId.slice(0, 8),
          pool:        p._peerInfo?.get(peerId)?.pool ?? null,
          hashratePct: null,
        }));
      }
      if (p.stratum)   updates.connections = p.stratum._sockets.size;
      if (p.hashrateMonitor) {
        const lp = p.hashrateMonitor.lastPct;
        if (lp !== null && lp !== undefined) updates.hashratePct = lp;
      }
      this._patch(updates);
    }, 5_000);

    return this;
  }

  start() {
    this._server = http.createServer((req, res) => {
      // Restrict to loopback — belt-and-suspenders on top of the listen address
      const remote = req.socket.remoteAddress;
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403);
        res.end();
        return;
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, this._corsHeaders());
        res.end();
        return;
      }

      if (req.url !== '/stats') {
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(200, { ...this._corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(this._state));
    });

    this._server.listen(this._port, '127.0.0.1', () => {
      console.log(`[xmrigger-proxy] [info] stats  →  http://127.0.0.1:${this._port}/stats`);
    });

    return this;
  }

  stop() {
    clearInterval(this._peerTimer);
    this._server?.close();
  }

  _patch(patch) { Object.assign(this._state, patch); }

  _corsHeaders() {
    return {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };
  }
}

module.exports = { StatsServer };
