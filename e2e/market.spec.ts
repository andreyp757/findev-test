/**
 * Назначение файла: Проверяет собранное приложение в настоящем Chromium: интерфейс, Worker, Wasm и жизненный цикл.
 * Независимый повтор потока проверяет каждую строку; производственный накопитель не служит собственным эталоном.
 */
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { WorkerEvent } from "../src/app/market/worker-protocol";
import type { InstrumentMetrics } from "../src/app/market/market-data";
import { WASM_ASSET_FILE } from "../wasm/market-producer/pkg/wasm-asset.js";
import { symbols } from "../src/app/market/producer-settings";

type SerializedRow = Omit<InstrumentMetrics, "volume" | "notionalCents"> & {
  volume: string;
  notionalCents: string;
};

interface CapturedSnapshot {
  runId: number;
  trades: string;
  batches: number;
  rows: SerializedRow[];
}

declare global {
  interface Window {
    __snapshots: CapturedSnapshot[];
  }
}

import init, {
  MarketGenerator,
} from "../wasm/market-producer/pkg/market_producer.js";

test("real Wasm in one Worker; navigation, validation, pause and Apply", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(
    page.locator("tbody tr").first().locator(".price"),
  ).not.toHaveText("N/A");
  expect(page.workers()).toHaveLength(1);
  expect(
    await page
      .workers()[0]
      .evaluate(() =>
        performance.getEntriesByType("resource").map((e) => e.name),
      ),
  ).toContain(`http://127.0.0.1:4173/findev-test/wasm/${WASM_ASSET_FILE}`);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  const paused = await page.locator("tbody").innerText();
  await page.waitForTimeout(650);
  expect(await page.locator("tbody").innerText()).toBe(paused);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Instrument count", { exact: true }).fill("1.5");
  await expect(
    page.getByRole("button", { name: "Apply settings" }),
  ).toBeDisabled();
  await page.getByLabel("Instrument count", { exact: true }).blur();
  await expect(
    page.getByText("Enter a whole number from 1 to 50.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Instrument count", { exact: true }).fill("2");
  await page.getByLabel("Batch interval", { exact: true }).fill("2000");
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Instrument count", { exact: true }).fill("2");
  await page.getByLabel("Batch interval", { exact: true }).fill("2000");
  await page.getByRole("button", { name: "Apply settings" }).click();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("tbody tr").first().locator(".price")).toHaveText(
    "N/A",
  );
  await expect(
    page.locator("tbody tr").first().locator(".price"),
  ).not.toHaveText("N/A", { timeout: 4000 });
  expect(page.workers()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("maximum settings remain responsive and aggregate every batch", async ({
  page,
}) => {
  // Наблюдаем реальный протокол сообщений, не подменяя производитель тестовым генератором.
  await page.addInitScript(() => {
    const BaseWorker = window.Worker;
    window.__snapshots = [];
    window.Worker = class extends BaseWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener(
          "message",
          ({ data }: MessageEvent<WorkerEvent>) => {
            if (data.type === "SNAPSHOT")
              window.__snapshots.push({
                runId: data.runId,
                trades: String(data.trades),
                batches: data.batches,
                rows: data.rows.map((row) => ({
                  ...row,
                  volume: String(row.volume),
                  notionalCents: String(row.notionalCents),
                })),
              });
          },
        );
      }
    };
  });
  await page.goto("#/settings");
  await page.getByLabel("Instrument count", { exact: true }).fill("50");
  await page.getByLabel("Updates per batch", { exact: true }).fill("1000");
  await page.getByLabel("Batch interval", { exact: true }).fill("50");
  await page.getByRole("button", { name: "Apply settings" }).click();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  const start = Date.now();
  const frameGaps = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const gaps: number[] = [];
        let previous = performance.now();
        const end = previous + 2000;
        const tick = (now: number) => {
          gaps.push(now - previous);
          previous = now;
          if (now < end) requestAnimationFrame(tick);
          else resolve(gaps);
        };
        requestAnimationFrame(tick);
      }),
  );
  const pauseStart = Date.now();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  // Фиксируем реакцию UI до повторного расчёта эталона, чтобы не измерять лишнюю работу.
  const pauseResponseMs = Date.now() - pauseStart;
  const elapsedMs = Date.now() - start;
  const samples = await page.evaluate(() =>
    window.__snapshots.filter((s) => s.runId === 2),
  );
  const last = samples.at(-1);
  if (!last) throw new Error("No maximum-rate snapshot received");
  expect(BigInt(last.trades)).toBe(BigInt(last.batches) * 1000n);
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(
      () => window.__snapshots.filter((s) => s.runId === 2).length,
    ),
  ).toBe(samples.length);
  await init({
    module_or_path: await readFile(`public/wasm/${WASM_ASSET_FILE}`),
  });
  const replay = new MarketGenerator(50, 0x12345678);
  // Независимый эталон: только в тесте сохраняем повтор потока и группируем сделки.
  // Формулы считаем напрямую, иначе ошибка общего накопителя могла бы совпасть с ошибкой эталона.
  const history: number[][][] = Array.from({ length: 50 }, () => []);
  try {
    for (let i = 0; i < last.batches; i++) {
      const b = replay.generateBatch(1000);
      for (let j = 0; j < b.length; j += 7)
        history[b[j]].push(Array.from(b.subarray(j, j + 7)));
    }
  } finally {
    replay.free();
  }
  const names = symbols(50);
  const expectedRows = history.map((trades, index) => {
    const latest = trades.at(-1);
    const volume = trades.reduce(
      (sum, [, , quantity]) => sum + BigInt(quantity),
      0n,
    );
    const notional = trades.reduce(
      (sum, [, price, quantity]) => sum + BigInt(price) * BigInt(quantity),
      0n,
    );
    return {
      symbol: names[index],
      volume: String(volume),
      notionalCents: String(notional),
      lastPriceCents: latest?.[1] ?? null,
      spreadCents: latest ? latest[4] - latest[3] : null,
      imbalance:
        !latest || latest[5] + latest[6] === 0
          ? null
          : (latest[5] - latest[6]) / (latest[5] + latest[6]),
    };
  });
  expect(last.rows).toEqual(expectedRows);
  expect(samples.length).toBeLessThanOrEqual(Math.ceil(elapsedMs / 150) + 3);
  expect(last.batches).toBeGreaterThan(15);
  const sorted = frameGaps.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      nominalTradesPerSecond: 20000,
      observedBatches: last.batches,
      trades: last.trades,
      elapsedMs,
      snapshots: samples.length,
      pauseResponseMs,
      frameGapP95Ms: sorted[Math.floor(sorted.length * 0.95)],
    }),
  );
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
});

test("Wasm load failure is visible and retry recovers", async ({
  page,
  context,
}) => {
  await context.route("**/wasm/*.wasm", (route) => route.abort());
  await page.goto("");
  await expect(page.getByRole("alert")).toContainText(
    "Market engine unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeDisabled();
  await context.unroute("**/wasm/*.wasm");
  await page
    .getByRole("button", { name: "Retry with current settings" })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator("tbody tr").first().locator(".price"),
  ).not.toHaveText("N/A");
});

test("mobile layout keeps navigation and settings usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("");
  await expect(
    page.getByRole("heading", { name: "Market overview", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByLabel("Instrument count", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("hung Wasm startup times out and can be retried", async ({
  page,
  context,
}) => {
  await page.clock.install();
  let stalled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await context.route("**/wasm/*.wasm", async (route) => {
    stalled = true;
    await gate;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto("");
    await expect.poll(() => stalled).toBe(true);
    await page.clock.fastForward(15_001);
    await expect(page.getByRole("alert")).toContainText(
      "initialization timed out",
    );
    await expect(
      page.getByRole("button", { name: "Pause", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
    await context.unroute("**/wasm/*.wasm");
    await page.clock.resume();
  }
  await page
    .getByRole("button", { name: "Retry with current settings" })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator("tbody tr").first().locator(".price"),
  ).not.toHaveText("N/A");
});

test("malformed request paths do not crash the production preview", async ({
  request,
}) => {
  expect((await request.get("%E0%A4%A")).status()).toBe(400);
  expect((await request.get("")).status()).toBe(200);
});
