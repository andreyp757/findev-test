# FinDev — real-time market dashboard

A two-page Angular dashboard backed by exact cumulative metrics and a seeded Rust/WebAssembly generator in a dedicated Worker. All instruments and trades are fictional.

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

To type-check the Worker independently after building Wasm:

```sh
npx tsc --noEmit -p tsconfig.worker.json
```

## Run the dashboard

After installing dependencies and the tools listed above:

```sh
npm start -- --port 4300
```

Open http://127.0.0.1:4300/. On macOS, `./start-local.command --port 4300` checks the toolchain, installs npm dependencies when needed, builds Wasm and starts Angular. Stop with Ctrl+C.

Dashboard is at `#/`; Settings is at `#/settings`. Both pages use the same root-scoped `MarketEngine`. Angular Signals expose state, OnPush components render snapshots, and stable symbol keys preserve table rows. Generation continues across route changes. Settings are a validated local draft until Apply, which resets the run and starts generation even after a pause or an error. Settings are not persisted across reloads.

The main-thread service rejects stale run IDs and callbacks from replaced Workers, acknowledges snapshots and limits startup to 15 seconds. Errors stop the producer and offer retry. The interface uses a light pastel palette, accessible labels, keyboard focus indicators and responsive layouts; the wide data table scrolls within its own container on small screens.

## Production build

```sh
npm run build
npm run build:pages
```

The first command targets `/`; the second targets `/findev-test/`. Both automatically compile Wasm, generate its content-fingerprinted asset name and build the Worker. The static application is written to `dist/terminal/browser`.

Unit tests currently cover metrics, formatting, settings, Worker lifecycle and the Angular state owner. Browser integration tests, the production preview server and automatic public deployment are the next delivery stage. No live deployment is claimed yet.
