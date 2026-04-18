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
 * @version  0.1.0
 * @released 2026-04-18
 * @license  LGPL-2.1
 */

const net = require('net');
const { EventEmitter } = require('events');

class StratumProxy extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.listenPort   Port XMRig connects to
   * @param {string} opts.poolHost     Upstream pool host
   * @param {number} opts.poolPort     Upstream pool port
   * @param {string} [opts.listenHost] Bind address (default: '127.0.0.1').
   *   Override to '0.0.0.0' when running inside a Docker container or VM
   *   where the miner connects from a different network namespace.
   *   Keep the default for local setups — it prevents remote access to the proxy.
   */
  constructor({ listenPort, poolHost, poolPort, listenHost }) {
    super();
    this.listenPort = listenPort;
    this.listenHost = listenHost || '127.0.0.1'; // localhost-only by default — safer for desktop use
    this.poolHost   = poolHost;
    this.poolPort   = poolPort;
    this._server    = null;
    this._sockets   = new Set(); // track live connections for clean shutdown
    this.lastPrevhash = null;
  }

  start() {
    return new Promise((resolve) => {
      this._server = net.createServer((miner) => this._onMiner(miner));
      this._server.listen(this.listenPort, this.listenHost, resolve);
    });
  }

  stop() {
    if (this._server) {
      this._server.close();
      // close() stops accepting new connections but leaves existing ones open;
      // destroy them explicitly so the port is released immediately
      for (const s of this._sockets) s.destroy();
      this._sockets.clear();
    }
  }

  // ── Per-connection handler ────────────────────────────────────────────────

  _onMiner(miner) {
    this._sockets.add(miner);
    miner.on('close', () => this._sockets.delete(miner));
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
    let job = null;
    if (msg.method === 'job' && msg.params)           job = msg.params;
    if (msg.result && msg.result.job)                 job = msg.result.job;

    if (job) {
      // Preferred: pool exposes prev_hash directly (SupportXMR, MoneroOcean, etc.)
      if (job.prev_hash) return job.prev_hash;
      // Fallback: parse from Monero block header blob (pools that omit prev_hash, e.g. HashVault)
      if (job.blob) return this._prevhashFromBlob(job.blob);
    }

    // Bitcoin / Stratum v1: mining.notify params[1]
    if (msg.method === 'mining.notify' && Array.isArray(msg.params) && msg.params[1])
      return msg.params[1];

    return null;
  }

  _prevhashFromBlob(blob) {
    // Monero block header layout (all fields LEB128-varint encoded):
    //   [major_version][minor_version][timestamp][prev_hash 32 B][nonce 4 B]...
    // Parse two version varints then one timestamp varint, then read 32 bytes.
    try {
      let off = 0;
      for (let field = 0; field < 3; field++) {   // skip major, minor, timestamp
        while (parseInt(blob.slice(off, off + 2), 16) & 0x80) off += 2;
        off += 2;
      }
      if (blob.length >= off + 64) return blob.slice(off, off + 64);
    } catch { /* malformed blob */ }
    return null;
  }
}

module.exports = { StratumProxy };
