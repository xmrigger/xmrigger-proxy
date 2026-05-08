# Changelog

All notable changes to xmrigger-proxy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-05-08

### Fixed
- **Sidecar bundling**: hoisted `ws` as a direct dependency. Previously `ws`
  was only declared as a transitive dependency through `xmrigger-mesh`
  (`file:../xmrigger-mesh`). When consumers (e.g. `xmrigger-widget`) packaged
  `xmrigger-proxy` into a standalone `.exe` via `pkg`, npm did not install
  `ws` in a layout that pkg could statically resolve, so the bundle shipped
  without `ws` and crashed at launch with `Cannot find module 'ws'`.
  Hoisting `ws` puts it in the consumer's top-level `node_modules` where
  pkg always finds it.

## [0.1.0] — 2026-04-18

### Added
- Initial release.
- `XmrProxy`: integrated Stratum proxy + hashrate-concentration guard.
- Optional encrypted federation mesh via `xmrigger-mesh` (opt-in via
  `--mesh-port` / `--seed`; disabled by default with `--no-mesh`).
- Selfish-mining detection through prevhash divergence across federated
  peers.
- Auto-evacuation to fallback pools on hashrate-threshold or fork
  detection.

[0.1.1]: https://github.com/xmrigger/xmrigger-proxy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/xmrigger/xmrigger-proxy/releases/tag/v0.1.0
