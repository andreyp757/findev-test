import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
// Profile production in a dedicated Chromium instance; verify exact counts, pause, and Worker disposal.
// Retain only the latest snapshot and a fixed-size histogram, never trade history.
const project = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(
  new URL(
    `../performance-results/${new Date().toISOString().replaceAll(":", "-")}/`,
    import.meta.url,
  ),
);
const durationMs = Number(process.env.PERF_DURATION_MS ?? 300000);
const heapGrowthLimit = Number(process.env.PERF_HEAP_GROWTH_MIB ?? 5) * 1048576;
const frameGapLimit = Number(process.env.PERF_FRAME_P95_MS ?? 50);
if (!Number.isFinite(durationMs) || durationMs < 10000 || durationMs > 3600000)
  throw new Error("PERF_DURATION_MS must be 10000..3600000");
if (
  !Number.isFinite(heapGrowthLimit) ||
  heapGrowthLimit <= 0 ||
  !Number.isFinite(frameGapLimit) ||
  frameGapLimit <= 0
)
  throw new Error("Invalid performance budgets");
await mkdir(output, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = {
  startedAt: new Date().toISOString(),
  environment: {
    os: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    ramBytes: os.totalmem(),
    node: process.versions.node,
  },
  samples: [],
  checkpoints: [],
  phases: [],
  errors: [],
  notes: [
    "CPU throttling applies to the page; it is not a whole-device simulation.",
    "Heap checks use explicit GC at checkpoints; periodic samples do not force GC.",
    "RSS includes JS/Wasm/native structures; do not add these metrics together.",
  ],
  budgets: {
    durationMs,
    heapGrowthLimit,
    frameGapLimit,
    lifecycleHeapGrowthBytes: 1048576,
    lifecycleDomNodeGrowth: 20,
    lifecycleEventListenerGrowth: 5,
  },
};
const log = (message, data) =>
  console.log(
    JSON.stringify({ at: new Date().toISOString(), message, ...data }),
  );
const save = () =>
  writeFile(`${output}/results.json`, JSON.stringify(result, null, 2));
// Start a dedicated server on an available port to isolate the profiling run.
const server = spawn(process.execPath, ["scripts/serve-production.mjs"], {
  cwd: project,
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "inherit"],
});
let browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Preview startup timeout")),
      10000,
    );
    let log = "";
    server.stdout.on("data", (chunk) => {
      log += chunk;
      const match = log.match(
        /Local: (http:\/\/127\.0\.0\.1:\d+\/findev-test\/)/,
      );
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Preview exited: ${code}`));
    });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const root = await browser.newBrowserCDPSession();
  const main = await context.newCDPSession(page);
  let workerSession = null;
  function nestedSession(sessionId) {
    let next = 0;
    const pending = new Map();
    const onMessage = (e) => {
      if (e.sessionId !== sessionId) return;
      const m = JSON.parse(e.message);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error
        ? p.reject(new Error(JSON.stringify(m.error)))
        : p.resolve(m.result);
    };
    root.on("Target.receivedMessageFromTarget", onMessage);
    return {
      dispose: () => {
        root.off("Target.receivedMessageFromTarget", onMessage);
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error("Worker CDP session disposed"));
        }
        pending.clear();
      },
      send: (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++next;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Worker CDP timeout: ${method}`));
          }, 10000);
          pending.set(id, { resolve, reject, timer });
          root
            .send("Target.sendMessageToTarget", {
              sessionId,
              message: JSON.stringify({ id, method, params }),
            })
            .catch((e) => {
              clearTimeout(timer);
              pending.delete(id);
              reject(e);
            });
        }),
    };
  }
  async function processes() {
    const { processInfo } = await root.send("SystemInfo.getProcessInfo");
    const renderer = processInfo.filter((p) => p.type === "renderer");
    let rss = {};
    if (renderer.length) {
      try {
        const text = execFileSync(
          "/bin/ps",
          ["-o", "pid=,rss=", "-p", renderer.map((p) => p.id).join(",")],
          { encoding: "utf8" },
        );
        for (const line of text.trim().split("\n")) {
          const [pid, kb] = line.trim().split(/\s+/).map(Number);
          rss[pid] = kb * 1024;
        }
      } catch (e) {
        result.notes.push(`ps unavailable: ${e.message}`);
      }
    }
    return {
      rendererCount: renderer.length,
      rendererRssBytes: renderer.every((p) => rss[p.id] !== undefined)
        ? renderer.reduce((s, p) => s + rss[p.id], 0)
        : null,
      rendererCpuSeconds: renderer.reduce((s, p) => s + p.cpuTime, 0),
      rendererPids: renderer.map((p) => p.id),
    };
  }
  async function metrics() {
    const x = await main.send("Performance.getMetrics");
    return Object.fromEntries(x.metrics.map((x) => [x.name, x.value]));
  }
  async function wasmMemory() {
    if (!workerSession) return [];
    try {
      const proto = await workerSession.send("Runtime.evaluate", {
        expression: "WebAssembly.Memory.prototype",
        objectGroup: "findev-measure",
      });
      const objects = await workerSession.send("Runtime.queryObjects", {
        prototypeObjectId: proto.result.objectId,
        objectGroup: "findev-measure",
      });
      return (
        await workerSession.send("Runtime.callFunctionOn", {
          objectId: objects.objects.objectId,
          functionDeclaration:
            "function(){return Array.from(this,m=>m.buffer.byteLength)}",
          returnByValue: true,
        })
      ).result.value;
    } finally {
      await workerSession
        .send("Runtime.releaseObjectGroup", { objectGroup: "findev-measure" })
        .catch(() => {});
    }
  }
  async function sample(label, gc = false) {
    if (gc) {
      // Let Angular finish routing and rendering before comparing retained DOM and heap.
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(null)),
            );
          }),
      );
      await main.send("HeapProfiler.collectGarbage");
      if (workerSession)
        await workerSession.send("HeapProfiler.collectGarbage");
    }
    const [mainHeap, workerHeap, dom, proc, state] = await Promise.all([
      main.send("Runtime.getHeapUsage"),
      workerSession ? workerSession.send("Runtime.getHeapUsage") : null,
      main.send("Memory.getDOMCounters"),
      processes(),
      page.evaluate(() => {
        const p = window.__marketPerf;
        if (!p) return null;
        return {
          runId: p.runId,
          status: p.status,
          trades: String(p.latest?.trades ?? 0n),
          batches: p.latest?.batches ?? 0,
          snapshots: p.snapshots,
          rows: p.latest?.rows.length ?? 0,
          visibility: document.visibilityState,
        };
      }),
    ]);
    const item = {
      label,
      time: new Date().toISOString(),
      mainHeap,
      workerHeap,
      dom,
      ...proc,
      state,
    };
    if (gc) {
      item.wasmMemoryBytes = await wasmMemory();
      result.checkpoints.push(item);
    } else result.samples.push(item);
    await save();
    return item;
  }
  await page.addInitScript(() => {
    const p = (window.__marketPerf = {
      runId: 0,
      status: "Unknown",
      latest: null,
      snapshots: 0,
      createdWorkers: 0,
      phase: null,
    });
    const Base = window.Worker;
    window.Worker = class extends Base {
      constructor(url, options) {
        super(url, options);
        p.createdWorkers++;
        this.addEventListener("message", ({ data }) => {
          if (data.type === "STATUS" && data.runId >= p.runId) {
            p.runId = data.runId;
            p.status = data.status;
          }
          if (data.type === "ERROR" && data.runId >= p.runId) {
            p.status = "Error";
          }
          if (data.type === "SNAPSHOT" && data.runId >= p.runId) {
            p.runId = data.runId;
            p.latest = data;
            p.snapshots++;
          }
        });
      }
      postMessage(command, ...args) {
        if (command.type === "START_RUN") {
          p.runId = command.runId;
          p.status = "Initializing";
          p.latest = null;
        }
        return super.postMessage(command, ...args);
      }
    };
    const tick = (now) => {
      const s = p.phase;
      if (s) {
        const gap = now - s.previous;
        s.previous = now;
        s.frames++;
        s.maxFrameGap = Math.max(s.maxFrameGap, gap);
        s.histogram[Math.min(999, Math.floor(gap * 2))]++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      if (!p.phase) return;
      for (const e of list.getEntries()) {
        p.phase.longTasks++;
        p.phase.longTaskDuration += e.duration;
        p.phase.maxLongTask = Math.max(p.phase.maxLongTask, e.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  });
  page.on("pageerror", (e) => {
    if (result.errors.length < 20) result.errors.push(e.message);
  });
  async function ready(status = "Running") {
    await page.waitForFunction(
      (s) => window.__marketPerf?.status === s,
      status,
      { timeout: 20000 },
    );
  }
  async function pause() {
    const t = performance.now();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await ready("Paused");
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    return performance.now() - t;
  }
  async function resume() {
    const t = performance.now();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await ready();
    return performance.now() - t;
  }
  function assertRetainedMemory(before, after, label) {
    const growth = {
      label,
      mainHeapBytes: after.mainHeap.usedSize - before.mainHeap.usedSize,
      workerHeapBytes: after.workerHeap.usedSize - before.workerHeap.usedSize,
      domNodes: after.dom.nodes - before.dom.nodes,
      eventListeners: after.dom.jsEventListeners - before.dom.jsEventListeners,
    };
    result.lifecycleGrowth ??= [];
    result.lifecycleGrowth.push(growth);
    // Compare the same paused dashboard after GC, allowing small engine/cache fluctuations.
    assert.ok(
      growth.mainHeapBytes <= result.budgets.lifecycleHeapGrowthBytes,
      `${label}: main retained heap grew over 1 MiB`,
    );
    assert.ok(
      growth.workerHeapBytes <= result.budgets.lifecycleHeapGrowthBytes,
      `${label}: Worker retained heap grew over 1 MiB`,
    );
    assert.ok(
      growth.domNodes <= result.budgets.lifecycleDomNodeGrowth,
      `${label}: retained DOM nodes grew`,
    );
    assert.ok(
      growth.eventListeners <= result.budgets.lifecycleEventListenerGrowth,
      `${label}: retained event listeners grew`,
    );
    assert.deepEqual(
      after.wasmMemoryBytes,
      before.wasmMemoryBytes,
      `${label}: Wasm memory did not plateau`,
    );
    assert.equal(page.workers().length, 1, `${label}: expected one Worker`);
    log("lifecycle memory verified", growth);
  }
  async function phase(name, durationMs) {
    const before = await sample(`${name}: before load (post-GC)`, true);
    const cpu0 = await metrics();
    const proc0 = await processes();
    await page.evaluate(() => {
      const p = window.__marketPerf;
      p.phase = {
        previous: performance.now(),
        frames: 0,
        maxFrameGap: 0,
        histogram: new Uint32Array(1000),
        longTasks: 0,
        longTaskDuration: 0,
        maxLongTask: 0,
      };
    });
    const start = performance.now();
    const at0 = await page.evaluate(() => ({
      trades: String(window.__marketPerf.latest.trades),
      batches: window.__marketPerf.latest.batches,
      snapshots: window.__marketPerf.snapshots,
    }));
    let nextLog = 30000;
    while (performance.now() - start < durationMs) {
      await sleep(
        Math.min(10000, Math.max(0, durationMs - (performance.now() - start))),
      );
      const s = await sample(name);
      if (performance.now() - start >= nextLog) {
        nextLog += 30000;
        log(name, {
          seconds: Math.round((performance.now() - start) / 1000),
          mainUsedMiB: s.mainHeap.usedSize / 1048576,
          workerUsedMiB: s.workerHeap?.usedSize / 1048576,
          rendererRssMiB: s.rendererRssBytes / 1048576,
          trades: s.state?.trades,
        });
      }
    }
    const elapsedMs = performance.now() - start;
    const cpu1 = await metrics();
    const proc1 = await processes();
    const stats = await page.evaluate(() => {
      const p = window.__marketPerf,
        s = p.phase;
      p.phase = null;
      return {
        ...s,
        histogram: Array.from(s.histogram),
        trades: String(p.latest.trades),
        batches: p.latest.batches,
        snapshots: p.snapshots,
      };
    });
    const quantile = (q) => {
      const limit = stats.frames * q;
      let n = 0;
      for (let i = 0; i < stats.histogram.length; i++) {
        n += stats.histogram[i];
        if (n >= limit) return (i + 1) / 2;
      }
      return 500;
    };
    const item = {
      name,
      durationMs: elapsedMs,
      generatedTrades: Number(BigInt(stats.trades) - BigInt(at0.trades)),
      batches: stats.batches - at0.batches,
      snapshots: stats.snapshots - at0.snapshots,
      frameCount: stats.frames,
      frameGapP95MsUpperBound: quantile(0.95),
      maxFrameGapMs: stats.maxFrameGap,
      longTasks: stats.longTasks,
      longTaskDurationMs: stats.longTaskDuration,
      maxLongTaskMs: stats.maxLongTask,
      mainTaskTimeMs: (cpu1.TaskDuration - cpu0.TaskDuration) * 1000,
      mainScriptTimeMs: (cpu1.ScriptDuration - cpu0.ScriptDuration) * 1000,
      rendererCpuPercentOfOneCore:
        ((proc1.rendererCpuSeconds - proc0.rendererCpuSeconds) /
          (elapsedMs / 1000)) *
        100,
    };
    item.observedTradesPerSecond = (item.generatedTrades * 1000) / elapsedMs;
    item.after = await sample(`${name}: after load (post-GC)`, true);
    assert.equal(before.wasmMemoryBytes.length, 1, "Expected one Wasm memory");
    assert.deepEqual(
      item.after.wasmMemoryBytes,
      before.wasmMemoryBytes,
      "Wasm memory grew during sustained load",
    );
    result.phases.push(item);
    await save();
    log("phase completed", {
      name,
      tradesPerSecond: item.observedTradesPerSecond,
      frameGapP95Ms: item.frameGapP95MsUpperBound,
      mainHeapMiB: item.after.mainHeap.usedSize / 1048576,
      workerHeapMiB: item.after.workerHeap.usedSize / 1048576,
    });
    assert.ok(
      item.after.mainHeap.usedSize - before.mainHeap.usedSize <=
        heapGrowthLimit,
      "Main retained heap growth exceeds budget",
    );
    assert.ok(
      item.after.workerHeap.usedSize - before.workerHeap.usedSize <=
        heapGrowthLimit,
      "Worker retained heap growth exceeds budget",
    );
    assert.ok(
      item.frameGapP95MsUpperBound <= frameGapLimit,
      "Frame gap p95 exceeds budget",
    );
    return item;
  }
  try {
    result.browser = await browser.version();
    await main.send("Performance.enable");
    await sample("empty browser before app", true);
    await page.goto(url);
    await ready();
    await sleep(3000);
    await sample("default 5 instruments", true);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByLabel("Instrument count", { exact: true }).fill("50");
    await page.getByLabel("Updates per batch", { exact: true }).fill("1000");
    await page.getByLabel("Batch interval", { exact: true }).fill("50");
    await page.getByRole("button", { name: "Apply settings" }).click();
    await ready();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await sleep(5000);
    const targets = await root.send("Target.getTargets");
    const w = targets.targetInfos.find(
      (t) => t.type === "worker" && t.url.startsWith(url),
    );
    if (!w) throw new Error("No market worker target");
    const { sessionId } = await root.send("Target.attachToTarget", {
      targetId: w.targetId,
      flatten: false,
    });
    workerSession = nestedSession(sessionId);
    await workerSession.send("Runtime.enable");
    result.workerTarget = w.url;
    await phase("max 50 instruments, 1000/50ms, normal CPU", durationMs);
    await main.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await phase(
      "max settings, CDP page CPU throttle 4x",
      Math.min(durationMs, 60000),
    );
    await main.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    result.pauseMs = await pause();
    const paused = await sample("paused baseline", true);
    await sleep(15000);
    const pausedLater = await sample("paused after 15 seconds", true);
    result.pausePreservesTrades =
      paused.state.trades === pausedLater.state.trades;
    assert.ok(result.pausePreservesTrades, "Trades changed while paused");
    // Warm route and event-handler code before measuring repeated lifecycle operations.
    for (let i = 0; i < 10; i++) {
      await resume();
      await pause();
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    }
    const lifecycleBaseline = await sample("lifecycle warm baseline", true);
    result.controlLatencies = [];
    for (let i = 0; i < 50; i++) {
      result.controlLatencies.push({
        resumeMs: await resume(),
        pauseMs: await pause(),
      });
    }
    const afterControls = await sample("after 50 pause/resume cycles", true);
    assertRetainedMemory(
      lifecycleBaseline,
      afterControls,
      "50 pause/resume cycles",
    );
    for (let i = 0; i < 50; i++) {
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    }
    const afterRoutes = await sample("after 100 route changes", true);
    assertRetainedMemory(afterControls, afterRoutes, "100 route changes");
    // Validate all completed batches in the long run with an independent exact replay.
    const final = await page.evaluate(() => {
      const s = window.__marketPerf.latest;
      return {
        runId: s.runId,
        trades: String(s.trades),
        batches: s.batches,
        rows: s.rows.map((r) => ({
          ...r,
          volume: String(r.volume),
          notionalCents: String(r.notionalCents),
        })),
      };
    });
    const wasm = await import("../wasm/market-producer/pkg/market_producer.js");
    const { WASM_ASSET_FILE } =
      await import("../wasm/market-producer/pkg/wasm-asset.js");
    await wasm.default({
      module_or_path: await readFile(
        `${project}/public/wasm/${WASM_ASSET_FILE}`,
      ),
    });
    const generator = new wasm.MarketGenerator(50, 0x12345678);
    const oracle = Array.from({ length: 50 }, () => ({
      volume: 0n,
      notionalCents: 0n,
      lastPriceCents: null,
      spreadCents: null,
      imbalance: null,
    }));
    try {
      for (let k = 0; k < final.batches; k++) {
        const b = generator.generateBatch(1000);
        for (let i = 0; i < b.length; i += 7) {
          const row = oracle[b[i]];
          row.volume += BigInt(b[i + 2]);
          row.notionalCents += BigInt(b[i + 1]) * BigInt(b[i + 2]);
          row.lastPriceCents = b[i + 1];
          row.spreadCents = b[i + 4] - b[i + 3];
          row.imbalance =
            b[i + 5] + b[i + 6] === 0
              ? null
              : (b[i + 5] - b[i + 6]) / (b[i + 5] + b[i + 6]);
        }
      }
    } finally {
      generator.free();
    }
    for (let i = 0; i < 50; i++)
      for (const key of [
        "volume",
        "notionalCents",
        "lastPriceCents",
        "spreadCents",
        "imbalance",
      ])
        if (String(oracle[i][key]) !== String(final.rows[i][key]))
          throw new Error(`Replay mismatch ${i} ${key}`);
    if (BigInt(final.trades) !== BigInt(final.batches) * 1000n)
      throw new Error("Trade count mismatch");
    result.accounting = {
      runId: final.runId,
      trades: final.trades,
      batches: final.batches,
      all50InstrumentsExact: true,
    };
    log("exact replay verified", result.accounting);
    let resetBaseline = afterRoutes;
    for (let group = 0; group < 10; group++) {
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      for (let i = 0; i < 100; i++) {
        await page
          .getByLabel("Instrument count", { exact: true })
          .fill(i % 2 ? "50" : "1");
        await page
          .getByLabel("Updates per batch", { exact: true })
          .fill(i % 2 ? "1000" : "1");
        await page.getByRole("button", { name: "Apply settings" }).click();
        await ready();
      }
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
      await page.waitForFunction(
        () => window.__marketPerf.latest?.runId === window.__marketPerf.runId,
      );
      await pause();
      const afterResets = await sample(
        `after ${(group + 1) * 100} alternating Apply resets`,
        true,
      );
      assertRetainedMemory(
        resetBaseline,
        afterResets,
        `Apply group ${group + 1}`,
      );
      assertRetainedMemory(
        afterRoutes,
        afterResets,
        `Apply cumulative ${(group + 1) * 100}`,
      );
      resetBaseline = afterResets;
    }
    result.liveWorkers = page.workers().length;
    result.createdWorkers = await page.evaluate(
      () => window.__marketPerf.createdWorkers,
    );
    assert.equal(result.liveWorkers, 1);
    assert.equal(result.createdWorkers, 1);
    assert.deepEqual(result.errors, []);
    result.finishedAt = new Date().toISOString();
    await save();
    workerSession.dispose();
    workerSession = null;
    await context.close();
    await sleep(1000);
    const finalTargets = await root.send("Target.getTargets");
    result.workerTargetsAfterContextClose = finalTargets.targetInfos.filter(
      (t) => t.type === "worker",
    ).length;
    result.afterCloseProcesses = await processes();
    assert.equal(result.workerTargetsAfterContextClose, 0);
    await save();
    log("completed", {
      output,
      errors: result.errors,
      liveWorkers: result.liveWorkers,
      createdWorkers: result.createdWorkers,
      workersAfterClose: result.workerTargetsAfterContextClose,
    });
  } catch (e) {
    result.failure = e.stack;
    await save();
    console.error(e);
    process.exitCode = 1;
  } finally {
    workerSession?.dispose();
    await browser.close();
  }
} finally {
  await browser?.close();
  if (server.pid && server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await stopped;
  }
}
