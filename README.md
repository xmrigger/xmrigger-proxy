# xmrigger-proxy

Protects your miner from pools that grow too large or mine dishonestly — transparent, automatic, no XMRig reconfiguration needed.

**[Live demo →](https://xmrigger.github.io/xmrigger-proxy/)**

Part of the [xmrigger suite](https://github.com/xmrigger): `xmrigger` · `xmrigger-mesh` · `xmrigger-proxy`

---

## What it does

```
XMRig → 127.0.0.1:3333 → xmrigger-proxy → pool.hashvault.pro:3333
                                    │
                             xmrigger-mesh
                                    │
                        other xmrigger-proxy nodes
```

The miner points to `127.0.0.1:3333` instead of the pool directly.
Everything else is transparent.

**Guard 1 — Hashrate concentration**
Polls independent sources for the pool's share of total Monero network
hashrate. If it exceeds a threshold (default 43%), starts a grace period
and then switches to a fallback pool.

**Guard 2 — Selfish mining detection**
Extracts `prevhash` from every Stratum job notification. Shares it with
federation peers via xmrigger-mesh. If divergence persists beyond a threshold
(default 20 s), flags the pool as suspect and evacuates.

Guard 2 requires at least one peer in the federation. A single isolated
proxy cannot detect divergence.

---

## Install

`xmrigger-proxy` depends on `xmrigger` and `xmrigger-mesh` as local siblings.
Clone all three into the same directory:

```bash
git clone https://github.com/xmrigger/xmrigger
git clone https://github.com/xmrigger/xmrigger-mesh
git clone https://github.com/xmrigger/xmrigger-proxy
cd xmrigger-proxy
npm install
```

---

## Run

> **Windows / PowerShell:** replace `\` with `` ` `` for line continuation, or use the one-liner form below.

```bash
# bash / Git Bash / macOS / Linux
node bin/xmrigger-proxy.js \
  --pool      pool.hashvault.pro:3333 \
  --fallback  pool.supportxmr.com:3333 \
  --health    http://pool.hashvault.pro/pool/health \
  --seed      wss://peer.example.com:8765
```

```powershell
# PowerShell (Windows)
node bin/xmrigger-proxy.js `
  --pool      pool.hashvault.pro:3333 `
  --fallback  pool.supportxmr.com:3333 `
  --health    http://pool.hashvault.pro/pool/health `
  --seed      wss://peer.example.com:8765
```

```bash
# one-liner (any shell)
node bin/xmrigger-proxy.js --pool pool.hashvault.pro:3333 --fallback pool.supportxmr.com:3333 --health http://pool.hashvault.pro/pool/health --seed wss://peer.example.com:8765
```

Then point XMRig to:

```bash
xmrig --url 127.0.0.1:3333 --user YOUR_ADDRESS
```

All options:

```
--pool        <host:port>   Upstream pool (required)
--listen      <port>        Local port for XMRig (default: 3333)
--bind        <host>        Bind address (default: 127.0.0.1 — localhost only)
                            Set to 0.0.0.0 when miner runs in a separate
                            container or VM network namespace.
--name        <name>        Node name shown in mesh (default: xmrigger-proxy)
--fallback    <host:port>   Fallback pool, repeatable
--threshold   <0.0-1.0>     Hashrate threshold (default: 0.43)
--health      <url>         Pool /health endpoint
--stats       <url>         Independent pool stats URL
--seed        <wss://url>   Mesh peer seed, repeatable
--mesh-port   <port>        Mesh listen port (default: 8765)
--divergence    <seconds>   Prevhash divergence threshold (default: 20)
--alert-quorum  <n>         Peers that must agree before a GUARD_ALERT triggers a local
                            poll (default: 2). Prevents a single low-threshold node from
                            flooding the federation with spurious polls.
--alert-window  <seconds>   Time window for collecting quorum (default: 60)
```

---

## Ports

| Port | Direction | Default | Flag | Notes |
|------|-----------|---------|------|-------|
| `3333` | inbound — XMRig → proxy | `3333` | `--listen` | Change if another process already uses 3333 |
| `8765` | inbound — mesh peers → this node | `8765` | `--mesh-port` | Must be reachable by other xmrigger-proxy nodes |
| pool port | outbound — proxy → pool | from `--pool` | `--pool` | Typically 3333 (plain) or 443/4443 (SSL) |
| fallback port | outbound — proxy → fallback pool | from `--fallback` | `--fallback` | Same as pool port |

Both inbound ports bind to `127.0.0.1` by default. Set `--bind 0.0.0.0` only if XMRig runs in a separate container or VM.

If port `3333` is already in use (e.g. another miner or proxy), pick any free port:

```bash
node bin/xmrigger-proxy.js --pool pool.hashvault.pro:3333 --listen 4444 --mesh-port 9765
# then: xmrig --url 127.0.0.1:4444 --user YOUR_ADDRESS
```

---

## Tests

```bash
npm test
# or: node test/index.js
```

14 tests — no external dependencies, no network calls, no XMRig needed.

Covers: prevhash extraction from Monero blob (single/multi-byte varints,
malformed input), alert quorum logic (dedup, per-pool tracking, exact
threshold).

---

## Demo

### Interactive (browser)

Open [`demo.html`](demo.html) in any browser — no server needed, no install.
Animates the full selfish mining detection scenario: sync → fork → divergence alert → evacuation → resolve.

### Terminal

```bash
node poc/demo.js
```

Two proxy instances, two mock pools, real encrypted mesh, real detection.
No XMRig needed. Runs in ~75 s.

Expected output:

```
[phase →]  SYNC    Both pools on same chain tip
[phase →]  FORK    Pool B on private fork!

🔴 [B] DIVERGE  own=deadbeef… (9s)
   ↳ peer       reports a1b2c3…
   🚨 alert     Pool-B on private fork — SELFISH MINING DETECTED
   action       evacuating miners from Pool-B → fallback

[phase →]  REVEAL  Pool B reveals — chains sync
✓ [B] SYNC  Pool-B back on public chain
```

---

## Use as a library

```js
const { XmrProxy } = require('xmrigger-proxy');

const proxy = new XmrProxy({
  listenPort: 3333,
  poolHost:   'pool.hashvault.pro',
  poolPort:   3333,
  guard: {
    healthUrl:  'http://pool.hashvault.pro/pool/health',
    threshold:  0.43,
    fallbacks:  [{ host: 'pool.supportxmr.com', port: 3333 }],
  },
  mesh: {
    port:         8765,
    seeds:        ['wss://peer.example.com:8765'],
    divergenceMs: 20_000,
  },
});

proxy.on('prevhash-divergence', ({ ownPrevhash, divergentPeers }) => {
  console.error('selfish mining suspected');
});

proxy.on('evacuate', ({ reason, fallback }) => {
  console.log(`switched to ${fallback.host}`);
});

await proxy.start();
```

---

## Known limitations

- **Guard 2 requires federation.** Without mesh peers, prevhash comparison
  is not possible. A single proxy running alone gets only Guard 1.

- **Stratum connection to pool is plaintext.** A network-level attacker
  between the proxy and the pool could inject fake job notifications.
  Use pools that support SSL (`ssl://`) where available.

- **Mesh peer authentication is not implemented.** Any node can join the
  federation. See [xmrigger-mesh](https://github.com/xmrigger/xmrigger-mesh) known limitations.

- **Fallback on divergence uses the first configured fallback only.**
  Multiple-fallback rotation is not implemented.

- **No persistent proxy state.** Restarting the proxy loses the current
  pool connection. Miners reconnect automatically via Stratum.

---

## Dependencies

```
xmrigger  (local)  — detection library
xmrigger-mesh  (local)  — federation transport
ws              ^8.0.0   — WebSocket (via xmrigger-mesh)
```

---

## Related

| Repo | Role |
|------|------|
| [xmrigger](https://github.com/xmrigger/xmrigger) | Detection library — `HashrateMonitor` + `PrevhashMonitor` |
| [xmrigger-mesh](https://github.com/xmrigger/xmrigger-mesh) | Encrypted federation transport — WebSocket gossip mesh |

---

## Project

`xmrigger-proxy` is part of the [TNZX project](https://github.com/tnzx-project).
Released under [LGPL-2.1](LICENSE).
