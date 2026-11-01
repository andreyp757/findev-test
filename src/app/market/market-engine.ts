import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from "@angular/core";
import { MetricAggregator } from "./metric-aggregator";
import {
  DEFAULT_SETTINGS,
  ProducerSettings,
  validSettings,
} from "./producer-settings";
import { InstrumentMetrics } from "./market-data";
import {
  MarketSnapshot,
  ProducerStatus,
  WorkerCommand,
  WorkerEvent,
} from "./worker-protocol";

export const STARTUP_TIMEOUT_MS = 15_000;

export interface WorkerPort {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(command: WorkerCommand): void;
  terminate(): void;
}

export const WORKER_FACTORY = new InjectionToken<() => WorkerPort>(
  "Market Worker factory",
  {
    providedIn: "root",
    factory: () => () =>
      new Worker(new URL("./market.worker", import.meta.url), {
        type: "module",
      }),
  },
);

interface EngineState {
  settings: ProducerSettings;
  runId: number;
  status: ProducerStatus;
  rows: readonly InstrumentMetrics[];
  trades: bigint;
  batches: number;
  error: string | null;
}

@Injectable({ providedIn: "root" })
export class MarketEngine {
  private readonly workerFactory = inject(WORKER_FACTORY);
  private worker: WorkerPort | null = null;
  private destroyed = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  // A single state object updates rows, counters, and status atomically.
  private readonly state = signal<EngineState>({
    settings: DEFAULT_SETTINGS,
    runId: 0,
    status: "Initializing",
    rows: new MetricAggregator(5).snapshot(),
    trades: 0n,
    batches: 0,
    error: null,
  });
  readonly settings = computed(() => this.state().settings);
  readonly runId = computed(() => this.state().runId);
  readonly status = computed(() => this.state().status);
  readonly rows = computed(() => this.state().rows);
  readonly trades = computed(() => this.state().trades);
  readonly batches = computed(() => this.state().batches);
  readonly error = computed(() => this.state().error);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
    this.apply(DEFAULT_SETTINGS);
  }

  /** true means the command was accepted; a later Worker status confirms readiness. */
  apply(settings: ProducerSettings): boolean {
    if (this.destroyed || !validSettings(settings)) return false;
    const runId = this.runId() + 1;
    this.clearStartupTimer();
    this.state.set({
      settings: { ...settings },
      runId,
      status: "Initializing",
      rows: new MetricAggregator(settings.instrumentCount).snapshot(),
      trades: 0n,
      batches: 0,
      error: null,
    });
    // Bound startup time for both the Worker script and Wasm; terminate on timeout
    // so a stalled load cannot outlive the Error state.
    this.startupTimer = setTimeout(() => {
      if (this.destroyed || runId !== this.runId()) return;
      this.startupTimer = null;
      if (this.status() === "Initializing")
        this.fail(
          `Market engine initialization timed out after ${STARTUP_TIMEOUT_MS / 1000} seconds. Please retry.`,
        );
    }, STARTUP_TIMEOUT_MS);
    try {
      if (!this.worker) {
        const worker = this.workerFactory();
        this.worker = worker;
        // Ignore callbacks from an old Worker after Retry creates a replacement.
        worker.onmessage = (event) => {
          if (this.worker === worker) this.receive(event.data);
        };
        worker.onerror = (event) => {
          if (this.worker === worker)
            this.fail(
              `Worker failed: ${event.message || "Unable to load market engine"}`,
            );
        };
        worker.onmessageerror = () => {
          if (this.worker === worker)
            this.fail("Unable to decode a Worker message");
        };
      }
      this.worker.postMessage({
        type: "START_RUN",
        runId,
        settings: { ...settings },
        seed: 0x12345678,
        wasmBaseUrl: new URL("wasm/", document.baseURI).href,
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }
    return true;
  }

  pause(): void {
    if (this.status() === "Running")
      this.send({ type: "PAUSE", runId: this.runId() });
  }

  resume(): void {
    if (this.status() === "Paused")
      this.send({ type: "RESUME", runId: this.runId() });
  }

  private send(command: WorkerCommand): void {
    try {
      this.worker?.postMessage(command);
    } catch (error) {
      this.fail(String(error));
    }
  }

  private receive(event: WorkerEvent): void {
    // Reject stale runs before any state change, including ERROR checkpoints.
    if (this.destroyed || event.runId !== this.runId()) return;
    switch (event.type) {
      case "STATUS":
        if (event.status !== "Initializing") this.clearStartupTimer();
        this.state.update((s) => ({ ...s, status: event.status }));
        break;
      case "SNAPSHOT":
        this.state.update((s) => ({
          ...s,
          rows: event.rows,
          trades: event.trades,
          batches: event.batches,
        }));
        this.send({
          type: "ACK",
          runId: event.runId,
          sequence: event.sequence,
        });
        break;
      case "ERROR":
        this.fail(event.message, event.snapshot);
        break;
    }
  }

  private clearStartupTimer(): void {
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private fail(message: string, snapshot?: MarketSnapshot): void {
    this.clearStartupTimer();
    this.state.update((s) => ({
      ...s,
      ...snapshot,
      status: "Error",
      error: message,
    }));
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearStartupTimer();
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    // DISPOSE is best effort; it may not be processed before terminate.
    try {
      worker.postMessage({ type: "DISPOSE", runId: this.runId() });
    } catch {
      /* A broken Worker may reject DISPOSE; terminate still releases its environment. */
    } finally {
      worker.terminate();
    }
  }
}
