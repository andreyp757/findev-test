import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { DEFAULT_SETTINGS } from "./producer-settings";
import { Generator, ProducerRuntime } from "./producer-runtime";
import { WorkerCommand, WorkerEvent } from "./worker-protocol";

const start = (runId = 1): WorkerCommand => ({
  type: "START_RUN",
  runId,
  settings: {
    ...DEFAULT_SETTINGS,
    instrumentCount: 1,
    updatesPerBatch: 1,
    batchIntervalMs: 50,
  },
  seed: 42,
  wasmBaseUrl: "/wasm/",
});

const mockGenerator = (): Generator => {
  let freed = false;
  return {
    generateBatch: vi.fn(() => {
      if (freed) throw new Error("Use after free");
      return new Uint32Array([0, 100, 2, 99, 100, 6, 4]);
    }),
    free: vi.fn(() => {
      if (freed) throw new Error("Double free");
      freed = true;
    }),
  };
};

describe("Worker producer lifecycle", () => {
  let runtime: ProducerRuntime;
  let generator: Generator;
  let events: WorkerEvent[];
  beforeEach(async () => {
    vi.useFakeTimers();
    events = [];
    runtime = new ProducerRuntime(
      async () => {
        generator = mockGenerator();
        return generator;
      },
      (event) => events.push(event),
    );
    runtime.handle(start());
    await Promise.resolve();
  });
  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
  });
  const snapshots = (events: WorkerEvent[]) =>
    events.filter((e) => e.type === "SNAPSHOT");
  it("pauses generation and resumes without catch-up or losing totals", async () => {
    await vi.advanceTimersByTimeAsync(50);
    const first = snapshots(events)[0];
    runtime.handle({ type: "ACK", runId: 1, sequence: first.sequence });
    runtime.handle({ type: "PAUSE", runId: 1 });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(generator.generateBatch).toHaveBeenCalledTimes(1);
    runtime.handle({ type: "RESUME", runId: 1 });
    await vi.advanceTimersByTimeAsync(49);
    expect(generator.generateBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshots(events).at(-1)?.rows[0].volume).toBe(4n);
  });
  it("repeated controls never duplicate timers", async () => {
    for (let i = 0; i < 10; i++) {
      runtime.handle({ type: "PAUSE", runId: 1 });
      runtime.handle({ type: "RESUME", runId: 1 });
      runtime.handle({ type: "RESUME", runId: 1 });
    }
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(generator.generateBatch).toHaveBeenCalledTimes(4);
  });
  it("limits snapshots to one in flight while still counting every trade", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshots(events)).toHaveLength(1);
    expect(generator.generateBatch).toHaveBeenCalledTimes(20);
    runtime.handle({ type: "PAUSE", runId: 1 });
    runtime.handle({ type: "ACK", runId: 1, sequence: 1 });
    expect(snapshots(events).at(-1)?.rows[0].volume).toBe(40n);
  });
  it("publishes all completed trades before confirming pause, even with an ACK delayed", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    runtime.handle({ type: "PAUSE", runId: 1 });
    expect(
      events.filter((e) => e.type === "STATUS" && e.status === "Paused"),
    ).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    runtime.handle({ type: "ACK", runId: 1, sequence: 1 });
    expect(events.at(-2)).toMatchObject({
      type: "SNAPSHOT",
      trades: 20n,
      batches: 20,
      rows: [expect.objectContaining({ volume: 40n, notionalCents: 4000n })],
    });
    expect(events.at(-1)).toEqual({
      type: "STATUS",
      runId: 1,
      status: "Paused",
    });
    const eventCount = events.length;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(generator.generateBatch).toHaveBeenCalledTimes(20);
    expect(events).toHaveLength(eventCount);
  });
  it("flushes accumulated data on ACK without waiting another slow batch interval", async () => {
    runtime.handle({
      type: "START_RUN",
      runId: 2,
      settings: {
        ...DEFAULT_SETTINGS,
        instrumentCount: 1,
        updatesPerBatch: 1,
        batchIntervalMs: 2000,
      },
      seed: 42,
      wasmBaseUrl: "/wasm/",
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4000);
    expect(snapshots(events)).toHaveLength(1);
    runtime.handle({ type: "ACK", runId: 2, sequence: 1 });
    expect(snapshots(events)).toHaveLength(2);
    expect(snapshots(events).at(-1)).toMatchObject({
      runId: 2,
      trades: 2n,
      rows: [expect.objectContaining({ volume: 4n })],
    });
    expect(generator.generateBatch).toHaveBeenCalledTimes(2);
  });
  it("includes an exact final checkpoint when failure occurs behind snapshot backpressure", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    vi.mocked(generator.generateBatch).mockImplementation(() => {
      throw new Error("Wasm trap");
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(events.at(-1)).toMatchObject({
      type: "ERROR",
      runId: 1,
      message: "Wasm trap",
      snapshot: {
        trades: 20n,
        batches: 20,
        rows: [expect.objectContaining({ volume: 40n, notionalCents: 4000n })],
      },
    });
    expect(generator.free).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores stale commands and stale acknowledgements", async () => {
    runtime.handle({ type: "PAUSE", runId: 0 });
    await vi.advanceTimersByTimeAsync(50);
    runtime.handle({ type: "ACK", runId: 1, sequence: 999 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshots(events)).toHaveLength(1);
    expect(generator.generateBatch).toHaveBeenCalledTimes(21);
  });
  it("Apply frees old generator, resets metrics, and starts after pause", async () => {
    await vi.advanceTimersByTimeAsync(50);
    runtime.handle({ type: "PAUSE", runId: 1 });
    const previous = generator;
    runtime.handle(start(2));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(previous.free).toHaveBeenCalledTimes(1);
    expect(generator).not.toBe(previous);
    expect(generator.free).not.toHaveBeenCalled();
    expect(snapshots(events).at(-1)?.runId).toBe(2);
    expect(snapshots(events).at(-1)?.rows[0].volume).toBe(2n);
  });
  it("does not emit a deferred old pause or accept an old ACK after Apply", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    runtime.handle({ type: "PAUSE", runId: 1 });
    runtime.handle(start(2));
    await Promise.resolve();
    const boundary = events.length;
    runtime.handle({ type: "ACK", runId: 1, sequence: 1 });
    await vi.advanceTimersByTimeAsync(50);
    expect(events.slice(boundary).every((e) => e.runId === 2)).toBe(true);
    expect(snapshots(events).at(-1)).toMatchObject({
      runId: 2,
      trades: 1n,
      rows: [expect.objectContaining({ volume: 2n })],
    });
    expect(vi.getTimerCount()).toBe(1);
  });
  it("resume cancels deferred pause confirmation without duplicate timers", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    runtime.handle({ type: "PAUSE", runId: 1 });
    runtime.handle({ type: "RESUME", runId: 1 });
    runtime.handle({ type: "ACK", runId: 1, sequence: 1 });
    expect(
      events.filter((e) => e.type === "STATUS" && e.status === "Paused"),
    ).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(generator.generateBatch).toHaveBeenCalledTimes(21);
  });
  it("disposes timers and the generator", async () => {
    runtime.handle({ type: "DISPOSE", runId: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(generator.free).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(generator.generateBatch).not.toHaveBeenCalled();
  });
  it("reports runtime errors and stops generation", async () => {
    vi.mocked(generator.generateBatch).mockImplementation(() => {
      throw new Error("broken generator");
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(events.at(-1)).toMatchObject({
      type: "ERROR",
      runId: 1,
      message: "broken generator",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(generator.free).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid settings without creating a generator", async () => {
    runtime.handle({
      ...start(2),
      type: "START_RUN",
      settings: { ...DEFAULT_SETTINGS, instrumentCount: 0 },
      seed: 1,
      wasmBaseUrl: "",
    });
    expect(events.at(-1)).toMatchObject({ type: "ERROR", runId: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("asynchronous Wasm initialization", () => {
  it("rapid Apply frees obsolete results and only schedules the latest run", async () => {
    vi.useFakeTimers();
    const resolvers: ((value: Generator) => void)[] = [];
    const events: WorkerEvent[] = [];
    const runtime = new ProducerRuntime(
      () => new Promise((resolve) => resolvers.push(resolve)),
      (e) => events.push(e),
    );
    runtime.handle(start(1));
    runtime.handle(start(2));
    runtime.handle(start(3));
    const a = mockGenerator(),
      b = mockGenerator(),
      c = mockGenerator();
    resolvers[2](c);
    resolvers[0](a);
    resolvers[1](b);
    await Promise.resolve();
    expect(a.free).toHaveBeenCalledOnce();
    expect(b.free).toHaveBeenCalledOnce();
    expect(c.free).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(events.at(-1)).toMatchObject({ runId: 3, status: "Running" });
    runtime.dispose();
    vi.useRealTimers();
  });
  it("can pause before initialization finishes and dispose an unresolved generator", async () => {
    vi.useFakeTimers();
    let resolve!: (g: Generator) => void;
    const events: WorkerEvent[] = [];
    const runtime = new ProducerRuntime(
      () => new Promise((r) => (resolve = r)),
      (e) => events.push(e),
    );
    runtime.handle(start());
    runtime.handle({ type: "PAUSE", runId: 1 });
    const g = mockGenerator();
    resolve(g);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(events.at(-1)).toMatchObject({ status: "Paused" });
    runtime.handle(start(2));
    runtime.dispose();
    const late = mockGenerator();
    resolve(late);
    await Promise.resolve();
    expect(late.free).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
  it("ignores a rejected obsolete initialization after a newer run is active", async () => {
    vi.useFakeTimers();
    let rejectOld!: (reason: Error) => void;
    const events: WorkerEvent[] = [];
    const generator = mockGenerator();
    let attempts = 0;
    const runtime = new ProducerRuntime(
      () =>
        ++attempts === 1
          ? new Promise((_, reject) => (rejectOld = reject))
          : Promise.resolve(generator),
      (e) => events.push(e),
    );
    runtime.handle(start(1));
    runtime.handle(start(2));
    await Promise.resolve();
    rejectOld(new Error("old Wasm load failed"));
    await Promise.resolve();
    expect(events.at(-1)).toMatchObject({
      type: "STATUS",
      runId: 2,
      status: "Running",
    });
    expect(events.some((e) => e.type === "ERROR")).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    runtime.dispose();
    vi.useRealTimers();
  });
  it("releases every obsolete generator after a large out-of-order Apply burst", async () => {
    vi.useFakeTimers();
    const pending: {
      resolve: (g: Generator) => void;
      reject: (error: Error) => void;
    }[] = [];
    const events: WorkerEvent[] = [];
    const runtime = new ProducerRuntime(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      (event) => events.push(event),
    );
    const generators: Generator[] = [];
    try {
      for (let run = 1; run <= 200; run++) runtime.handle(start(run));
      for (let index = pending.length - 1; index >= 0; index--) {
        if (index % 7 === 0) {
          pending[index].reject(new Error("Obsolete initialization failed"));
        } else {
          const generator = mockGenerator();
          generators.push(generator);
          pending[index].resolve(generator);
        }
      }
      await Promise.resolve();
      expect(events.filter((event) => event.type === "ERROR")).toHaveLength(0);
      expect(
        events.filter(
          (event) => event.type === "STATUS" && event.status === "Running",
        ),
      ).toEqual([{ type: "STATUS", runId: 200, status: "Running" }]);
      expect(vi.getTimerCount()).toBe(1);
      expect(generators[0].free).not.toHaveBeenCalled();
      for (const generator of generators.slice(1))
        expect(generator.free).toHaveBeenCalledOnce();
      runtime.dispose();
      runtime.dispose();
      await vi.advanceTimersByTimeAsync(10000);
      for (const generator of generators) {
        expect(generator.free).toHaveBeenCalledOnce();
        expect(generator.generateBatch).not.toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it("surfaces Wasm initialization failure", async () => {
    const events: WorkerEvent[] = [];
    const runtime = new ProducerRuntime(
      async () => {
        throw new Error("Wasm unavailable");
      },
      (e) => events.push(e),
    );
    runtime.handle(start());
    await Promise.resolve();
    expect(events.at(-1)).toMatchObject({
      type: "ERROR",
      runId: 1,
      message: "Wasm unavailable",
      snapshot: {
        trades: 0n,
        batches: 0,
        rows: expect.arrayContaining([
          expect.objectContaining({ volume: 0n, notionalCents: 0n }),
        ]),
      },
    });
    runtime.dispose();
  });
});

describe("monotonic batch deadlines", () => {
  // Control work time and timer delivery separately: fake timers do not model batch duration.
  async function setup(workMs: number) {
    let now = 0;
    let task: { at: number; callback: () => void } | null = null;
    const times: number[] = [];
    const runtime = new ProducerRuntime(
      async () => {
        const generator = mockGenerator();
        const original = generator.generateBatch;
        generator.generateBatch = () => {
          times.push(now);
          const batch = original(1);
          now += workMs;
          return batch;
        };
        return generator;
      },
      () => {},
      {
        now: () => now,
        set: (callback, delay) => {
          task = { at: now + delay, callback };
          return task;
        },
        clear: () => {
          task = null;
        },
      },
    );
    runtime.handle(start());
    await Promise.resolve();
    return {
      runtime,
      times,
      next: () => task?.at,
      advance: (ms: number) => {
        now += ms;
      },
      fire: (lateBy = 0) => {
        if (!task) throw new Error("No scheduled batch");
        const current = task;
        task = null;
        now = current.at + lateBy;
        current.callback();
      },
    };
  }
  it("does not add batch computation time to every interval", async () => {
    const s = await setup(12);
    try {
      s.fire();
      s.fire();
      s.fire();
      expect(s.times).toEqual([50, 100, 150]);
      expect(s.next()).toBe(200);
    } finally {
      s.runtime.dispose();
    }
  });
  it("skips missed deadlines after a delayed timer without catch-up bursts", async () => {
    const s = await setup(12);
    try {
      s.fire(500);
      expect(s.times).toEqual([550]);
      expect(s.next()).toBe(612);
      s.fire();
      expect(s.times).toEqual([550, 612]);
    } finally {
      s.runtime.dispose();
    }
  });
  it("yields a full interval when processing itself exceeds the interval", async () => {
    const s = await setup(80);
    try {
      s.fire();
      expect(s.next()).toBe(180);
      s.fire();
      expect(s.times).toEqual([50, 180]);
    } finally {
      s.runtime.dispose();
    }
  });
  it("starts a fresh schedule after pause and resets", async () => {
    const s = await setup(12);
    try {
      s.fire();
      s.runtime.handle({ type: "PAUSE", runId: 1 });
      expect(s.next()).toBeUndefined();
      s.advance(10000);
      s.runtime.handle({ type: "RESUME", runId: 1 });
      expect(s.next()).toBe(10112);
      s.fire();
      s.runtime.handle(start(2));
      await Promise.resolve();
      expect(s.next()).toBe(10174);
    } finally {
      s.runtime.dispose();
    }
  });
});

it("requires error events to use the ERROR variant instead of STATUS", () => {
  // tsc checks this contract too: allowing Error in STATUS must fail compilation.
  expectTypeOf<
    Extract<WorkerEvent, { type: "STATUS" }>["status"]
  >().toEqualTypeOf<"Initializing" | "Running" | "Paused">();
});
