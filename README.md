# xmr-proxy

Transparent Stratum proxy for Monero miners. Sits between XMRig (or any
Stratum miner) and the upstream pool. Adds two safety guards.

---

## What it does

```
XMRig → 127.0.0.1:3333 → xmr-proxy → pool.hashvault.pro:3333
                               │
                          xmr-mesh
                               │
                     other xmr-proxy nodes
```

The miner points to `127.0.0.1:3333` instead of the pool directly.
Everything else is transparent.

**Guard 1 — Hashrate concentration**
Polls independent sources for the pool's share of total Monero network
hashrate. If it exceeds a threshold (default 30%), starts a grace period
and then switches to a fallback pool.

**Guard 2 — Selfish mining detection**
Extracts `prevhash` from every Stratum job notification. Shares it with
federation peers via xmr-mesh. If divergence persists beyond a threshold
(default 20 s), flags the pool as suspect and evacuates.

Guard 2 requires at least one peer in the federation. A single isolated
proxy cannot detect divergence.

---

## Install

```bash
git clone https://github.com/xmr-hashguard/xmr-proxy
cd xmr-proxy
npm install
```

---

## Run

> **Windows / PowerShell:** replace `\` with `` ` `` for line continuation, or use the one-liner form below.

```bash
# bash / Git Bash / macOS / Linux
node bin/xmr-proxy.js \
  --pool      pool.hashvault.pro:3333 \
  --fallback  pool.supportxmr.com:3333 \
  --health    http://pool.hashvault.pro/pool/health \
  --seed      wss://peer.example.com:8765
```

```powershell
# PowerShell (Windows)
node bin/xmr-proxy.js `
  --pool      pool.hashvault.pro:3333 `
  --fallback  pool.supportxmr.com:3333 `
  --health    http://pool.hashvault.pro/pool/health `
  --seed      wss://peer.example.com:8765
```

```bash
# one-liner (any shell)
node bin/xmr-proxy.js --pool pool.hashvault.pro:3333 --fallback pool.supportxmr.com:3333 --health http://pool.hashvault.pro/pool/health --seed wss://peer.example.com:8765
```

Then point XMRig to:

```bash
xmrig --url 127.0.0.1:3333 --user YOUR_ADDRESS
```

All options:

```
--pool        <host:port>   Upstream pool (required)
--listen      <port>        Local port for XMRig (default: 3333)
--fallback    <host:port>   Fallback pool, repeatable
--threshold   <0.0-1.0>     Hashrate threshold (default: 0.30)
--health      <url>         Pool /health endpoint
--stats       <url>         Independent pool stats URL
--seed        <wss://url>   Mesh peer seed, repeatable
--mesh-port   <port>        Mesh listen port (default: 8765)
--divergence  <seconds>     Prevhash divergence threshold (default: 20)
```

---

## Demo

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
const { XmrProxy } = require('xmr-proxy');

const proxy = new XmrProxy({
  listenPort: 3333,
  poolHost:   'pool.hashvault.pro',
  poolPort:   3333,
  guard: {
    healthUrl:  'http://pool.hashvault.pro/pool/health',
    threshold:  0.30,
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
  federation. See [xmr-mesh](../xmr-mesh) known limitations.

- **Fallback on divergence uses the first configured fallback only.**
  Multiple-fallback rotation is not implemented.

- **No persistent proxy state.** Restarting the proxy loses the current
  pool connection. Miners reconnect automatically via Stratum.

---

## Dependencies

```
xmr-hashguard   (local)  — detection library
xmr-mesh        (local)  — federation transport
ws              ^8.0.0   — WebSocket (via xmr-mesh)
```

---

## Related

| Repo | Role |
|------|------|
| [xmr-hashguard](https://github.com/xmr-hashguard/xmr-hashguard) | Detection library — `HashrateMonitor` + `PrevhashMonitor` |
| [xmr-mesh](https://github.com/xmr-hashguard/xmr-mesh) | Encrypted federation transport — WebSocket gossip mesh |

---

## License

[LGPL-2.1](LICENSE)
