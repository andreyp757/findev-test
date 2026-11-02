// @vitest-environment jsdom
import "@angular/compiler";
import { Injector, runInInjectionContext } from "@angular/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketEngine, WORKER_FACTORY, WorkerPort } from "./market-engine";
import { WorkerCommand, WorkerEvent } from "./worker-protocol";
import { DEFAULT_SETTINGS } from "./producer-settings";
import { MetricAggregator } from "./metric-aggregator";
import { Settings } from "../settings/settings";

describe("application state and settings form", () => {
  let port: WorkerPort;
  let engine: MarketEngine;
  let injector: ReturnType<typeof Injector.create>;
  let commands: WorkerCommand[];
  let injectorDestroyed = false;
  const emit = (event: WorkerEvent) =>
    port.onmessage?.({ data: event } as MessageEvent<WorkerEvent>);
  beforeEach(() => {
    vi.useFakeTimers();
    injectorDestroyed = false;
    commands = [];
    port = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: vi.fn((c) => commands.push(c)),
      terminate: vi.fn(),
    };
    injector = Injector.create({
      providers: [
        MarketEngine,
        { provide: WORKER_FACTORY, useValue: () => port },
      ],
    });
    engine = injector.get(MarketEngine);
  });
  afterEach(() => {
    if (!injectorDestroyed) injector.destroy();
    vi.useRealTimers();
  });
  it("starts with defaults and no data", () => {
    expect(engine.settings()).toEqual(DEFAULT_SETTINGS);
    expect(engine.rows()).toHaveLength(5);
    expect(engine.rows()[0].volume).toBe(0n);
    expect(commands[0].type).toBe("START_RUN");
  });
  it("isolates form edits and validates fractions, empty input and boundaries", () => {
    const page = runInInjectionContext(injector, () => new Settings());
    page.form.controls.instrumentCount.setValue(50);
    expect(engine.settings().instrumentCount).toBe(5);
    expect(commands).toHaveLength(1);
    for (const value of [0, 51, 1.5, NaN]) {
      page.form.controls.instrumentCount.setValue(value);
      page.apply();
      expect(commands).toHaveLength(1);
      expect(page.form.invalid).toBe(true);
    }
    page.form.controls.instrumentCount.setValue(1);
    expect(page.form.valid).toBe(true);
    page.form.patchValue({
      instrumentCount: 50,
      updatesPerBatch: 1000,
      batchIntervalMs: 50,
    });
    expect(page.form.valid).toBe(true);
  });
  it("Apply resets totals and always starts a new run after pause", () => {
    const metrics = new MetricAggregator(5);
    metrics.process(new Uint32Array([0, 100, 7, 99, 100, 1, 1]));
    emit({
      type: "SNAPSHOT",
      runId: 1,
      sequence: 1,
      rows: metrics.snapshot(),
      trades: 1n,
      batches: 1,
    });
    emit({ type: "STATUS", runId: 1, status: "Paused" });
    const page = runInInjectionContext(injector, () => new Settings());
    page.form.controls.instrumentCount.setValue(2);
    page.apply();
    expect(engine.runId()).toBe(2);
    expect(engine.rows()).toHaveLength(2);
    expect(engine.rows()[0].volume).toBe(0n);
    expect(engine.status()).toBe("Initializing");
    expect(engine.trades()).toBe(0n);
    expect(commands.at(-1)).toMatchObject({ type: "START_RUN", runId: 2 });
  });
  it("rejects previous-run snapshots, statuses and errors", () => {
    engine.apply({ ...DEFAULT_SETTINGS, instrumentCount: 1 });
    emit({
      type: "SNAPSHOT",
      runId: 1,
      sequence: 1,
      rows: [],
      trades: 999n,
      batches: 5,
    });
    emit({ type: "STATUS", runId: 1, status: "Paused" });
    emit({
      type: "ERROR",
      runId: 1,
      message: "old error",
      snapshot: { rows: [], trades: 999n, batches: 999 },
    });
    expect(engine.rows()).toHaveLength(1);
    expect(engine.trades()).toBe(0n);
    expect(engine.status()).toBe("Initializing");
    expect(engine.error()).toBeNull();
  });
  it("rapid Apply retains one worker and only the latest run", () => {
    for (let i = 0; i < 20; i++)
      engine.apply({ ...DEFAULT_SETTINGS, instrumentCount: i + 1 });
    emit({ type: "STATUS", runId: 20, status: "Running" });
    expect(engine.status()).toBe("Initializing");
    emit({ type: "STATUS", runId: 21, status: "Running" });
    expect(engine.status()).toBe("Running");
    expect(engine.runId()).toBe(21);
    expect(port.terminate).not.toHaveBeenCalled();
  });
  it("does not apply invalid service inputs", () => {
    expect(engine.apply({ ...DEFAULT_SETTINGS, updatesPerBatch: 0 })).toBe(
      false,
    );
    expect(engine.runId()).toBe(1);
  });
  it("navigation-created settings pages share the same producer and paused state", () => {
    emit({ type: "STATUS", runId: 1, status: "Paused" });
    const a = runInInjectionContext(injector, () => new Settings());
    const b = runInInjectionContext(injector, () => new Settings());
    expect(a.engine).toBe(b.engine);
    expect(b.engine.status()).toBe("Paused");
    expect(commands).toHaveLength(1);
  });
  it("sends pause/resume commands and acknowledges snapshots", () => {
    emit({ type: "STATUS", runId: 1, status: "Running" });
    engine.pause();
    expect(commands.at(-1)).toMatchObject({ type: "PAUSE" });
    emit({ type: "STATUS", runId: 1, status: "Paused" });
    engine.resume();
    expect(commands.at(-1)).toMatchObject({ type: "RESUME" });
    emit({
      type: "SNAPSHOT",
      runId: 1,
      sequence: 5,
      rows: engine.rows(),
      trades: 0n,
      batches: 0,
    });
    expect(commands.at(-1)).toEqual({ type: "ACK", runId: 1, sequence: 5 });
  });
  it("surfaces initialization and runtime failures and allows retry", () => {
    emit({ type: "ERROR", runId: 1, message: "Wasm failed to load" });
    expect(engine.status()).toBe("Error");
    expect(engine.error()).toBe("Wasm failed to load");
    expect(port.terminate).toHaveBeenCalledOnce();
    engine.apply(DEFAULT_SETTINGS);
    expect(engine.runId()).toBe(2);
    expect(engine.error()).toBeNull();
    port.onerror?.({ message: "script load failed" } as ErrorEvent);
    expect(engine.error()).toContain("script load failed");
  });
  it("terminates a hung startup and clears the deadline on retry, ready, and destroy", () => {
    vi.advanceTimersByTime(15_000);
    expect(engine.status()).toBe("Error");
    expect(engine.error()).toMatch(/initialization timed out/i);
    expect(port.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    engine.apply(DEFAULT_SETTINGS);
    emit({ type: "STATUS", runId: 2, status: "Running" });
    vi.advanceTimersByTime(60_000);
    expect(engine.status()).toBe("Running");
    expect(vi.getTimerCount()).toBe(0);
    engine.apply(DEFAULT_SETTINGS);
    engine.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("restarts the startup deadline on Apply and ignores late previous-run readiness", () => {
    vi.advanceTimersByTime(14_000);
    engine.apply(DEFAULT_SETTINGS);
    emit({ type: "STATUS", runId: 1, status: "Running" });
    vi.advanceTimersByTime(14_999);
    expect(engine.status()).toBe("Initializing");
    vi.advanceTimersByTime(1);
    expect(engine.status()).toBe("Error");
    expect(port.terminate).toHaveBeenCalledOnce();
  });
  it("atomically retains final totals supplied with an error", () => {
    const rows = new MetricAggregator(5);
    rows.process(new Uint32Array([0, 100, 10, 99, 100, 6, 4]));
    emit({
      type: "ERROR",
      runId: 1,
      message: "runtime failure",
      snapshot: { rows: rows.snapshot(), trades: 1n, batches: 1 },
    });
    expect(engine.status()).toBe("Error");
    expect(engine.rows()[0].volume).toBe(10n);
    expect(engine.rows()[0].notionalCents).toBe(1000n);
    expect(engine.trades()).toBe(1n);
    expect(engine.batches()).toBe(1);
  });
  it("does not report a successful Apply if posting the start command fails", () => {
    vi.mocked(port.postMessage).mockImplementation(() => {
      throw new Error("Worker unavailable");
    });
    expect(engine.apply(DEFAULT_SETTINGS)).toBe(false);
    expect(engine.status()).toBe("Error");
    expect(vi.getTimerCount()).toBe(0);
    const page = runInInjectionContext(injector, () => new Settings());
    page.apply();
    expect(page.feedback).toContain("Worker unavailable");
  });
  it("ignores callbacks retained from a failed Worker after replacement", () => {
    const lateMessage = port.onmessage;
    const lateError = port.onerror;
    emit({ type: "ERROR", runId: 1, message: "old failure" });
    port = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    engine.apply(DEFAULT_SETTINGS);
    lateMessage?.({
      data: { type: "STATUS", runId: 2, status: "Running" },
    } as MessageEvent<WorkerEvent>);
    lateError?.({ message: "late old worker error" } as ErrorEvent);
    expect(engine.status()).toBe("Initializing");
    expect(engine.error()).toBeNull();
  });
  it("terminates even if the disposed Worker rejects commands", () => {
    vi.mocked(port.postMessage).mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => engine.destroy()).not.toThrow();
    expect(port.terminate).toHaveBeenCalledOnce();
  });
  it("cleans up once and rejects messages after destruction", () => {
    engine.destroy();
    engine.destroy();
    expect(port.terminate).toHaveBeenCalledOnce();
    expect(commands.at(-1)).toEqual({ type: "DISPOSE", runId: 1 });
    emit({ type: "STATUS", runId: 1, status: "Running" });
    expect(engine.status()).toBe("Initializing");
    expect(engine.apply(DEFAULT_SETTINGS)).toBe(false);
  });
  it("injector destruction detaches every handler and cancels pending startup", () => {
    const message = port.onmessage;
    const error = port.onerror;
    const messageError = port.onmessageerror;
    injector.destroy();
    injectorDestroyed = true;
    expect(port.onmessage).toBeNull();
    expect(port.onerror).toBeNull();
    expect(port.onmessageerror).toBeNull();
    expect(port.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    message?.({
      data: { type: "STATUS", runId: 1, status: "Running" },
    } as MessageEvent<WorkerEvent>);
    error?.({ message: "late error" } as ErrorEvent);
    messageError?.({} as MessageEvent);
    expect(engine.error()).toBeNull();
    expect(engine.apply(DEFAULT_SETTINGS)).toBe(false);
  });

  it("message decoding failure releases handlers, timer, and Worker", () => {
    port.onmessageerror?.({} as MessageEvent);
    expect(engine.status()).toBe("Error");
    expect(port.onmessage).toBeNull();
    expect(port.onerror).toBeNull();
    expect(port.onmessageerror).toBeNull();
    expect(port.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("failed snapshot ACK terminates the Worker instead of leaving it producing", () => {
    emit({ type: "STATUS", runId: 1, status: "Running" });
    vi.mocked(port.postMessage).mockImplementation(() => {
      throw new Error("ACK unavailable");
    });
    emit({
      type: "SNAPSHOT",
      runId: 1,
      sequence: 1,
      rows: engine.rows(),
      trades: 10n,
      batches: 1,
    });
    expect(engine.trades()).toBe(10n);
    expect(engine.status()).toBe("Error");
    expect(port.terminate).toHaveBeenCalledOnce();
    expect(port.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
