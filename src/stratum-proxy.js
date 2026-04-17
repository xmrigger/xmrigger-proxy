'use strict';
/**
 * stratum-proxy.js — transparent Stratum TCP proxy
 *
 * Sits between XMRig (or any miner) and the upstream pool.
 * Intercepts job notifications to extract prevhash — no other modification.
 *
 * Monero : mining.notify params[1]  OR  job params.prev_hash
 * Bitcoin: mining.notify params[1]
 *
 * @license LGPL-2.1
 */

const net = require('net');
const { EventEmitter } = require('events');

class StratumProxy extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.listenPort   Port XMRig connects to
   * @param {string} opts.poolHost     Upstream pool host
   * @param {number} opts.poolPort     Upstream pool port
   */
  constructor({ listenPort, poolHost, poolPort }) {
    super();
    this.listenPort = listenPort;
    this.poolHost   = poolHost;
    this.poolPort   = poolPort;
    this._server    = null;
    this.lastPrevhash = null;
  }

  start() {
    return new Promise((resolve) => {
      this._server = net.createServer((miner) => this._onMiner(miner));
      this._server.listen(this.listenPort, '127.0.0.1', resolve);
    });
  }

  stop() {
    if (this._server) this._server.close();
  }

  // ── Per-connection handler ────────────────────────────────────────────────

  _onMiner(miner) {
    const upstream = net.createConnection({ host: this.poolHost, port: this.poolPort });

    let minerBuf    = '';
    let upstreamBuf = '';
    let upstreamReady = false;
    const pendingMinerData = [];

    upstream.on('connect', () => {
      upstreamReady = true;
      for (const d of pendingMinerData) upstream.write(d);
      pendingMinerData.length = 0;
    });

    // miner → upstream (pass-through, buffer until upstream connects)
    miner.on('data', (d) => {
      if (upstream.destroyed) return;
      if (upstreamReady) upstream.write(d);
      else pendingMinerData.push(d);
    });

    // upstream → miner (intercept job notifications)
    upstream.on('data', (d) => {
      upstreamBuf += d.toString();
      const lines = upstreamBuf.split('\n');
      upstreamBuf = lines.pop();

      for (const line of lines) {
        if (!line.trim()) { miner.write('\n'); continue; }
        let msg;
        try { msg = JSON.parse(line); } catch {
          if (!miner.destroyed) miner.write(line + '\n');
          continue;
        }

        // Extract prevhash
        const ph = this._extractPrevhash(msg);
        if (ph && ph !== this.lastPrevhash) {
          this.lastPrevhash = ph;
          this.emit('prevhash', ph);
        }

        if (!miner.destroyed) miner.write(JSON.stringify(msg) + '\n');
      }
    });

    miner.on('error',    () => upstream.destroy());
    upstream.on('error', () => miner.destroy());
    miner.on('close',    () => upstream.destroy());
    upstream.on('close', () => miner.destroy());
  }

  _extractPrevhash(msg) {
    // Monero: job notification
    if (msg.method === 'job' && msg.params && msg.params.prev_hash)
      return msg.params.prev_hash;
    // Monero: login response with embedded job
    if (msg.result && msg.result.job && msg.result.job.prev_hash)
      return msg.result.job.prev_hash;
    // Bitcoin / Stratum v1: mining.notify params[1]
    if (msg.method === 'mining.notify' && Array.isArray(msg.params) && msg.params[1])
      return msg.params[1];
    return null;
  }
}

module.exports = { StratumProxy };
