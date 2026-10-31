# FinDev — market calculation core

First stage of the dashboard migration: exact cumulative metrics, validated settings and a seeded Rust/WebAssembly market generator. UI and Worker integration follow in separate stages.

Requires Node 22.22.3+, npm, Rust 1.91.0 and wasm-pack 0.15.0.

```sh
npm ci
npm run wasm:build
npm run test:all
npm run typecheck
```

Prices are integer cents. Volume and notional use bigint; VWAP rounds only for display. Book quantities never contribute to trade volume. The Rust generator persists instrument prices and produces seven u32 values per trade. Tests include the required two-trade VWAP example, large exact sums and generator invariants.
