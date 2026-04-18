'use strict';
/**
 * alert-quorum.js — Federation alert quorum tracker
 *
 * Collects GUARD_ALERT messages from distinct peers. Only when
 * minAlertPeers distinct peers agree within alertWindowMs does the
 * tracker call onQuorum(pool) — preventing a single low-threshold node
 * from flooding the federation with spurious polls.
 *
 * @license LGPL-2.1
 */

/**
 * Create a quorum tracker.
 *
 * @param {object}   opts
 * @param {number}   opts.minAlertPeers   Distinct peers required (default 2)
 * @param {number}   opts.alertWindowMs   Window before bucket expires ms (default 60000)
 * @param {Function} opts.onQuorum        Called with (pool) when quorum reached
 * @returns {{ receive: Function }}
 */
function createAlertQuorum({ minAlertPeers = 2, alertWindowMs = 60_000, onQuorum } = {}) {
  const _buckets = new Map(); // pool → { peers: Set, timer }

  function receive({ payload, peerId }) {
    const key = payload.pool || 'unknown';
    if (!_buckets.has(key)) {
      const timer = setTimeout(() => _buckets.delete(key), alertWindowMs);
      _buckets.set(key, { peers: new Set(), timer });
    }
    const bucket = _buckets.get(key);
    bucket.peers.add(peerId);

    if (bucket.peers.size >= minAlertPeers) {
      clearTimeout(bucket.timer);
      _buckets.delete(key);
      if (onQuorum) onQuorum(key);
    }
  }

  return { receive };
}

module.exports = { createAlertQuorum };
