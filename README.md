# FinDev — market core and Worker runtime

The dashboard migration now includes exact cumulative metrics, validated settings, a seeded Rust/WebAssembly generator and its dedicated Worker runtime. The Angular interface follows in the next stage.

Requires Node 22.22.3+, npm, Rust 1.91.0 and wasm-pack 0.15.0.

```sh
npm ci
npm run wasm:build
npm run test:all
npm run typecheck
```

Prices are integer cents. Volume and notional use bigint; VWAP rounds only for display. Book quantities never contribute to trade volume. The Rust generator persists instrument prices and produces seven u32 values per trade. Tests include the required two-trade VWAP example, large exact sums and generator invariants.

## Worker lifecycle

`market.worker.ts` initializes Wasm inside the Worker and connects typed messages to `ProducerRuntime`. `START_RUN` replaces the generator and resets cumulative metrics; `PAUSE` stops scheduling and preserves totals; `RESUME` waits a fresh interval without replaying missed batches. `DISPOSE` cancels pending work and frees the generator.

Every complete valid batch is aggregated before publication. Ordinary snapshots are throttled to 150 ms and only one can await `ACK` at a time. Trades keep accumulating while a snapshot is pending. Pause queues final totals before confirming `Paused`. Runtime errors carry a checkpoint of successfully processed batches.

Commands and snapshots carry `runId`; acknowledgement uses `sequence`. An internal epoch prevents late asynchronous initialization from replacing a newer generator. Injected scheduling and generator dependencies make these lifecycle cases deterministic in tests. The real Worker uses the compiled Rust module, not the test generator.

The Angular main-thread owner and public deployment are not included in this stage. To type-check the Worker independently after building Wasm:

```sh
npx tsc --noEmit -p tsconfig.worker.json
```
