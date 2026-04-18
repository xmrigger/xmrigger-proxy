'use strict';
/**
 * xmrigger-proxy test suite — prevhash extraction + alert quorum logic
 * Run: node test/index.js
 */

const { test, describe }    = require('node:test');
const assert                = require('node:assert/strict');
const { StratumProxy }      = require('../src/stratum-proxy');
const { createAlertQuorum } = require('../src/alert-quorum');

// ── _prevhashFromBlob ─────────────────────────────────────────────────────────

describe('_prevhashFromBlob — Monero blob prevhash extraction', () => {

  // Build a StratumProxy instance just to access the method.
  // No TCP server is started (we never call .start()).
  function makeProxy() {
    return new StratumProxy({
      listenPort: 0,
      poolHost:   '127.0.0.1',
      poolPort:   3333,
    });
  }

  // Synthetic Monero blob construction:
  //   major_version   (1-byte LEB128 varint, < 0x80)
  //   minor_version   (1-byte LEB128 varint)
  //   timestamp       (1-byte LEB128 varint, or multi-byte)
  //   prev_hash       (32 bytes = 64 hex chars)
  //   nonce           (4 bytes = 8 hex chars) — and any trailing data is fine
  //
  // The parser reads varints as pairs of hex chars until the high bit is clear.

  const KNOWN_PREVHASH = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

  /** Build a minimal valid blob with single-byte varints. */
  function makeSyntheticBlob(prevhash = KNOWN_PREVHASH) {
    const major     = '10';  // 0x10 = 16 decimal, < 0x80 → single-byte varint
    const minor     = '10';
    const timestamp = '01';  // 0x01 < 0x80
    const nonce     = '00000000';
    return major + minor + timestamp + prevhash + nonce;
  }

  test('extracts correct prevhash from synthetic blob with single-byte varints', () => {
    const proxy   = makeProxy();
    const blob    = makeSyntheticBlob(KNOWN_PREVHASH);
    const result  = proxy._prevhashFromBlob(blob);
    assert.strictEqual(result, KNOWN_PREVHASH,
      'extracted prevhash must match the 32-byte field embedded in the blob');
  });

  test('extracts correct prevhash from blob with multi-byte timestamp varint', () => {
    // Two-byte LEB128 varint: first byte has MSB set (0x80+), second does not.
    // e.g., 0x8001 encodes the value 128 in LEB128 (0x80 | 0x00, then 0x01).
    const proxy       = makeProxy();
    const major       = '10';
    const minor       = '10';
    const timestamp   = '8001';  // two-byte varint — high bit set on first byte
    const nonce       = 'deadc0de';
    const blob        = major + minor + timestamp + KNOWN_PREVHASH + nonce;
    const result      = proxy._prevhashFromBlob(blob);
    assert.strictEqual(result, KNOWN_PREVHASH,
      'multi-byte timestamp varint must be skipped correctly');
  });

  test('extracts prevhash from a blob that has extra trailing data', () => {
    const proxy  = makeProxy();
    const extra  = '00'.repeat(76);  // 76 bytes of tx data after nonce
    const blob   = makeSyntheticBlob(KNOWN_PREVHASH) + extra;
    const result = proxy._prevhashFromBlob(blob);
    assert.strictEqual(result, KNOWN_PREVHASH,
      'trailing data after prevhash+nonce must not affect extraction');
  });

  test('returns null for a blob that is too short to contain prevhash', () => {
    const proxy  = makeProxy();
    // 3 varint bytes (6 hex chars) + only 30 bytes (60 hex chars) — 2 bytes short
    const short  = '101001' + 'ff'.repeat(30);
    const result = proxy._prevhashFromBlob(short);
    assert.strictEqual(result, null,
      'too-short blob must return null without throwing');
  });

  test('returns null for completely empty blob', () => {
    const proxy  = makeProxy();
    const result = proxy._prevhashFromBlob('');
    assert.strictEqual(result, null, 'empty blob must return null');
  });

  test('returns null for non-hex garbage string', () => {
    const proxy  = makeProxy();
    const result = proxy._prevhashFromBlob('ZZZZ not hex at all !!!');
    assert.strictEqual(result, null, 'non-hex blob must return null without throwing');
  });

  test('returns null for blob with only varint bytes and no prevhash', () => {
    const proxy  = makeProxy();
    // Only the three varint fields, no room for prevhash
    const result = proxy._prevhashFromBlob('101001');
    assert.strictEqual(result, null, 'blob without prevhash must return null');
  });

  test('_extractPrevhash uses _prevhashFromBlob as fallback when prev_hash absent', () => {
    // When a pool omits prev_hash but includes blob (e.g. HashVault),
    // _extractPrevhash must call _prevhashFromBlob automatically.
    const proxy = makeProxy();
    const blob  = makeSyntheticBlob(KNOWN_PREVHASH);
    const msg   = {
      method: 'job',
      params: { blob, job_id: 'abc123' },  // no prev_hash field
    };
    const result = proxy._extractPrevhash(msg);
    assert.strictEqual(result, KNOWN_PREVHASH,
      '_extractPrevhash must extract from blob when prev_hash is absent');
  });

  test('_extractPrevhash prefers prev_hash over blob when both present', () => {
    const proxy     = makeProxy();
    const blob      = makeSyntheticBlob(KNOWN_PREVHASH);
    const directPH  = 'direct00direct00direct00direct00direct00direct00direct00direct000';
    const msg       = {
      method: 'job',
      params: { blob, prev_hash: directPH },
    };
    const result = proxy._extractPrevhash(msg);
    assert.strictEqual(result, directPH,
      '_extractPrevhash must prefer prev_hash over blob-derived value');
  });

});

// ── Alert quorum logic ────────────────────────────────────────────────────────
//
// Tests import createAlertQuorum directly from src/alert-quorum.js —
// the same module used by proxy.js. Changes to the production code are
// automatically reflected here.

describe('Alert quorum logic', () => {

  test('single peer does NOT trigger quorum (minAlertPeers=2)', () => {
    let pollCalled = false;
    const quorum = createAlertQuorum({
      minAlertPeers: 2,
      alertWindowMs: 5_000,
      onQuorum: () => { pollCalled = true; },
    });

    quorum.receive({ payload: { pool: 'pool.example.com:3333', reason: 'hashrate-threshold' }, peerId: 'peer-A' });

    assert.strictEqual(pollCalled, false,
      'pollNow must NOT be triggered by a single peer when minAlertPeers=2');
  });

  test('two distinct peers trigger quorum and call onQuorum', () => {
    let pollCalled = false;
    let pollPool   = null;
    const quorum = createAlertQuorum({
      minAlertPeers: 2,
      alertWindowMs: 5_000,
      onQuorum: (pool) => { pollCalled = true; pollPool = pool; },
    });

    const pool = 'pool.example.com:3333';
    quorum.receive({ payload: { pool, reason: 'hashrate-threshold' }, peerId: 'peer-A' });
    quorum.receive({ payload: { pool, reason: 'hashrate-threshold' }, peerId: 'peer-B' });

    assert.ok(pollCalled, 'onQuorum must be triggered when 2 distinct peers alert');
    assert.strictEqual(pollPool, pool, 'onQuorum must receive the pool key');
  });

  test('same peer sending two alerts does NOT trigger quorum (Set dedup)', () => {
    let pollCalled = false;
    const quorum = createAlertQuorum({
      minAlertPeers: 2,
      alertWindowMs: 5_000,
      onQuorum: () => { pollCalled = true; },
    });

    const pool = 'pool.example.com:3333';
    quorum.receive({ payload: { pool, reason: 'fork' }, peerId: 'peer-A' });
    quorum.receive({ payload: { pool, reason: 'fork' }, peerId: 'peer-A' });

    assert.strictEqual(pollCalled, false,
      'duplicate alerts from same peer must not reach quorum');
  });

  test('alerts for different pools are tracked independently', () => {
    const polled = new Set();
    const quorum = createAlertQuorum({
      minAlertPeers: 2,
      alertWindowMs: 5_000,
      onQuorum: (pool) => polled.add(pool),
    });

    const poolA = 'pool-a.com:3333';
    const poolB = 'pool-b.com:3333';

    quorum.receive({ payload: { pool: poolA, reason: 'fork' }, peerId: 'peer-1' });
    quorum.receive({ payload: { pool: poolA, reason: 'fork' }, peerId: 'peer-2' });
    quorum.receive({ payload: { pool: poolB, reason: 'fork' }, peerId: 'peer-1' });

    assert.ok(polled.has(poolA),  'poolA must reach quorum');
    assert.ok(!polled.has(poolB), 'poolB must not reach quorum with only 1 peer');
  });

  test('quorum requires exactly minAlertPeers distinct peers', () => {
    let pollCount = 0;
    const quorum = createAlertQuorum({
      minAlertPeers: 3,
      alertWindowMs: 5_000,
      onQuorum: () => { pollCount++; },
    });

    const pool = 'pool.example.com:3333';
    quorum.receive({ payload: { pool, reason: 'hashrate-threshold' }, peerId: 'peer-X' });
    assert.strictEqual(pollCount, 0, 'not reached after 1 peer');

    quorum.receive({ payload: { pool, reason: 'hashrate-threshold' }, peerId: 'peer-Y' });
    assert.strictEqual(pollCount, 0, 'not reached after 2 peers (need 3)');

    quorum.receive({ payload: { pool, reason: 'hashrate-threshold' }, peerId: 'peer-Z' });
    assert.strictEqual(pollCount, 1, 'reached exactly at 3 distinct peers');

    // A fourth alert must NOT fire again (bucket deleted after quorum)
    quorum.receive({ payload: { pool, reason: 'hashrate-threshold' }, peerId: 'peer-W' });
    assert.strictEqual(pollCount, 1, 'quorum fires exactly once per window');
  });

});
