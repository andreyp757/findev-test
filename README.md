# FinDev — Real-time market dashboard

Angular dashboard with a stateful Rust/WebAssembly simulator running in a dedicated Web Worker. All instruments and trades are fictional.

**[Live demo](https://andreyp757.github.io/findev-test/)** · [Source](https://github.com/andreyp757/findev-test)

## Run locally

Requires Node 22.22.3+ (see `.nvmrc`), npm, Rust/rustup and wasm-pack 0.15.0.

```sh
npm ci
rustup toolchain install 1.91.0 --profile minimal --target wasm32-unknown-unknown
cargo install wasm-pack --version 0.15.0 --locked
npm start -- --port 4300
```

Open http://127.0.0.1:4300/. On macOS you can also use `./start-local.command --port 4300`; it checks tools and installs dependencies when needed. Stop with Ctrl+C.

## Architecture

`Settings draft → MarketEngine → START_RUN / PAUSE / RESUME → Worker → Rust/Wasm → MetricAggregator → SNAPSHOT → MarketEngine Signals → Dashboard`

Angular 22 uses standalone components, Signals, Reactive Forms, OnPush and hash routing. `MarketEngine` is root-scoped, so both pages share one producer. Settings are a draft until Apply. Apply creates a new run, clears totals and starts generation, including after pause or error.

Rust owns seeded randomness, persistent per-instrument prices and all seven fields of each trade. wasm-bindgen returns a copied `Uint32Array`; JavaScript owns the array and the runtime explicitly frees replaced generators. Wasm initializes inside the Worker. The build fingerprints the binary and bundles its matching filename with the Worker, so a stale binary cannot be paired with new glue.

`ProducerRuntime` owns one recursive timer and cumulative metrics. Normal snapshots are throttled to 150 ms, with at most one unacknowledged snapshot. Every valid batch is aggregated before publication; slower rendering never skips trades. Pause cancels generation and confirms only after final totals have been queued. Resume preserves state and waits a full interval without generating catch-up trades. `runId`, an initialization epoch and Worker-instance checks reject stale work. Startup has a 15-second timeout. Reported runtime errors include the last exact checkpoint; an abrupt crash can preserve only the last delivered snapshot.

## Metrics

| Metric    | Definition                                                           |
| --------- | -------------------------------------------------------------------- |
| Last      | Most recent trade price                                              |
| Spread    | Latest ask minus bid                                                 |
| Volume    | Sum of trade quantities since Apply                                  |
| VWAP      | Sum of price × trade quantity divided by volume                      |
| Imbalance | Latest (bid quantity − ask quantity) / (bid quantity + ask quantity) |

Prices stay in integer cents. Volume and notional use `bigint`, including transport between threads. VWAP rounds only when displayed. Book quantities do not contribute to trading volume. Unavailable values and zero denominators display `N/A`; initial volume is zero. Two trades, 10 at $100 and 30 at $102, yield volume 40 and VWAP $101.50.

## Verification

```sh
npm run wasm:build
npm run test:all
npm run typecheck
npm run build:pages
npx playwright install chromium
npm run test:e2e
```

Unit tests cover formulas, exact large sums, settings and deterministic lifecycle races. Native Rust tests cover seeded generation and invariants. Wasm smoke tests process one million trades. Browser tests exercise the real Worker, routes, pause, Apply, load failures, mobile layout, contrast and independent replay at maximum settings. ABI tests load the actual Wasm binary.

Optional sustained measurement: `npm run test:performance`. It builds production and measures roughly five minutes of maximum load plus pause, routing and reset scenarios. Results remain under ignored `performance-results/`; heap, renderer RSS and frame gaps are different measurements and must not be added together. Reported results depend on the machine. No universal throughput or memory guarantee is claimed.

## Build and hosting

`npm run build` builds at `/`. `npm run build:pages` builds for `/findev-test/`. `npm run preview` serves that build at http://127.0.0.1:4173/findev-test/.

GitHub Actions runs Rust, TypeScript, Wasm and browser checks before publishing. Pages must use GitHub Actions as its source and repository variable `ENABLE_PAGES=true`. The public app is available at https://andreyp757.github.io/findev-test/. On November 1, 2026, the deployment passed CI and a live Chromium check confirmed data generation, Pause/Resume, navigation and Apply, one Worker, successful Wasm loading and no page errors. Hash routing preserves both pages on static hosting. Only `dist/terminal/browser` is published; local documentation is excluded from Git and from the build.

## Design decisions and limitations

The code groups market contracts, runtime and tests together in `src/app/market`, with separate `dashboard` and `settings` components. No backend, state-management framework or component library is needed for two pages. There is no event history: retained records scale with at most 50 instruments, while integer totals grow in precision over time. The simulator is deterministic, not a realistic exchange or a cryptographic random source. Background tabs may throttle timers. Browser automation targets Chromium. Fonts have system fallbacks. Settings reset on reload.

Angular 22 is used instead of the original Angular 19 baseline; Node, Rust and dependency versions are pinned for reproducibility. Generated `public/wasm` and `wasm/market-producer/pkg` are rebuilt automatically and are not committed.
