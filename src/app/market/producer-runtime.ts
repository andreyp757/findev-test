import { UPDATE_WIDTH } from "./market-data";
import { MetricAggregator } from "./metric-aggregator";
import { ProducerSettings, validSettings } from "./producer-settings";
import {
  MarketSnapshot,
  WorkerCommand,
  WorkerEvent,
  WorkerStatus,
} from "./worker-protocol";

export interface Generator {
  generateBatch(count: number): Uint32Array;
  free(): void;
}

export type GeneratorFactory = (
  count: number,
  seed: number,
  wasmBaseUrl: string,
) => Promise<Generator>;

export interface Scheduler {
  now(): number;
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Worker-only runtime with one rescheduled timeout and an epoch check after loading. */
export class ProducerRuntime {
  private runId = 0;
  private epoch = 0;
  private generator: Generator | null = null;
  private metrics = new MetricAggregator(5);
  private settings: ProducerSettings | null = null;
  private running = false;
  private pausePending = false;
  private timer: unknown = null;
  private nextTickAt: number | null = null;
  private pending: number | null = null;
  private sequence = 0;
  private lastPublished = -Infinity;
  private dirty = false;
  private trades = 0n;
  private batches = 0;

  constructor(
    private readonly create: GeneratorFactory,
    private readonly post: (event: WorkerEvent) => void,
    private readonly clock: Scheduler = realScheduler,
  ) {}

  handle(command: WorkerCommand): void {
    if (command.type === "START_RUN") {
      void this.start(command);
      return;
    }
    if (command.runId !== this.runId) return;
    switch (command.type) {
      case "PAUSE":
        if (this.settings === null) return;
        this.running = false;
        this.pausePending = true;
        this.cancelTimer();
        this.publish(true);
        this.confirmPause();
        break;
      case "RESUME":
        if (this.running || this.settings === null) return;
        this.running = true;
        this.pausePending = false;
        // If Wasm is still loading, start() reads the latest pause state after await.
        if (this.generator) {
          this.status("Running");
          this.schedule();
        }
        break;
      case "ACK":
        if (command.sequence !== this.pending) return;
        this.pending = null;
        // Flush any batch accumulated while awaiting the UI response without waiting for the next tick.
        this.publish(!this.running);
        this.confirmPause();
        break;
      case "DISPOSE":
        this.dispose();
        break;
    }
  }

  private async start(
    command: Extract<WorkerCommand, { type: "START_RUN" }>,
  ): Promise<void> {
    if (command.runId <= this.runId) return;
    this.dispose();
    // Capture the runtime epoch: Apply or DISPOSE may arrive during await.
    const epoch = this.epoch;
    this.runId = command.runId;
    try {
      if (!validSettings(command.settings))
        throw new Error("Invalid producer settings");
      this.settings = { ...command.settings };
      this.metrics = new MetricAggregator(command.settings.instrumentCount);
      this.trades = 0n;
      this.batches = 0;
      this.sequence = 0;
      this.lastPublished = -Infinity;
      this.dirty = false;
      this.pending = null;
      this.running = true;
      this.status("Initializing");
      const generator = await this.create(
        command.settings.instrumentCount,
        command.seed,
        command.wasmBaseUrl,
      );
      // Cancel stale initialization by freeing the late-created object without starting it.
      if (epoch !== this.epoch) {
        generator.free();
        return;
      }
      this.generator = generator;
      this.status(this.running ? "Running" : "Paused");
      if (this.running) this.schedule();
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    }
  }

  // Use monotonic deadlines so batch processing does not extend every interval.
  // If the next deadline is missed, wait a full interval instead of generating catch-up batches.
  private schedule(): void {
    if (
      this.timer !== null ||
      !this.running ||
      !this.generator ||
      !this.settings
    )
      return;
    const now = this.clock.now();
    const interval = this.settings.batchIntervalMs;
    if (this.nextTickAt === null || this.nextTickAt <= now) {
      this.nextTickAt = now + interval;
    }
    const scheduledFor = this.nextTickAt;
    this.timer = this.clock.set(
      () => {
        this.timer = null;
        if (!this.running || !this.generator || !this.settings) return;
        this.nextTickAt = scheduledFor + interval;
        try {
          const batch = this.generator.generateBatch(
            this.settings.updatesPerBatch,
          );
          if (batch.length !== this.settings.updatesPerBatch * UPDATE_WIDTH)
            throw new Error("Unexpected Wasm batch size");
          this.metrics.process(batch);
          this.trades += BigInt(this.settings.updatesPerBatch);
          this.batches++;
          this.dirty = true;
          this.publish(false);
          this.schedule();
        } catch (error) {
          this.fail(error);
        }
      },
      Math.ceil(scheduledFor - now),
    );
  }

  private publish(force: boolean): void {
    if (
      !this.dirty ||
      this.pending !== null ||
      (!force && this.clock.now() - this.lastPublished < 150)
    )
      return;
    // Hold the single snapshot slot until ACK; new trades still update cumulative totals.
    this.pending = ++this.sequence;
    this.lastPublished = this.clock.now();
    this.dirty = false;
    this.post({
      type: "SNAPSHOT",
      runId: this.runId,
      sequence: this.sequence,
      ...this.snapshot(),
    });
  }

  private snapshot(): MarketSnapshot {
    return {
      rows: this.metrics.snapshot(),
      trades: this.trades,
      batches: this.batches,
    };
  }

  private confirmPause(): void {
    // Worker messages are ordered: deliver final data to the UI before Paused.
    if (this.pausePending && !this.dirty) {
      this.pausePending = false;
      this.status("Paused");
    }
  }

  private status(status: WorkerStatus): void {
    this.post({ type: "STATUS", runId: this.runId, status });
  }

  private fail(error: unknown): void {
    // The terminal ERROR carries exact totals even when a regular snapshot awaits ACK.
    // This preserves all successfully processed trades when reporting an error.
    const snapshot = this.settings ? this.snapshot() : undefined;
    this.dispose();
    this.post({
      type: "ERROR",
      runId: this.runId,
      message: error instanceof Error ? error.message : String(error),
      snapshot,
    });
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
    this.nextTickAt = null;
  }

  dispose(): void {
    this.epoch++;
    this.running = false;
    this.pausePending = false;
    this.dirty = false;
    this.cancelTimer();
    this.generator?.free();
    this.generator = null;
    this.settings = null;
    this.pending = null;
  }
}
