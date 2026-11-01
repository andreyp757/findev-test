/** Проверяет реальный Wasm и TypeScript-декодер в Node: ABI, границы и освобождение объектов. */
import assert from "node:assert/strict";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import init, {
  MarketGenerator,
} from "../wasm/market-producer/pkg/market_producer.js";
import { WASM_ASSET_FILE } from "../wasm/market-producer/pkg/wasm-asset.js";
import { MetricAggregator } from "../src/app/market/metric-aggregator";
import { UPDATE_WIDTH } from "../src/app/market/market-data";
import { LIMITS } from "../src/app/market/producer-settings";

test.beforeAll(async () => {
  await init({
    module_or_path: await readFile(`public/wasm/${WASM_ASSET_FILE}`),
  });
});

test("Wasm ABI field order and TS decoding match the fixed seed-42 fixture", () => {
  const generator = new MarketGenerator(2, 42);
  try {
    const batch = generator.generateBatch(3);
    // Фиксированная golden fixture закрепляет все семь позиций, включая разные bid/ask quantities.
    expect(Array.from(batch)).toEqual([
      0, 9984, 57, 9984, 9994, 136, 83, 0, 9970, 28, 9970, 9980, 795, 434, 1,
      12503, 48, 12503, 12505, 700, 566,
    ]);
    expect(UPDATE_WIDTH).toBe(7);
    const metrics = new MetricAggregator(2);
    metrics.process(batch.subarray(0, 14));
    metrics.process(batch.subarray(14));
    expect(metrics.snapshot()).toEqual([
      {
        symbol: "ALFA",
        lastPriceCents: 9970,
        spreadCents: 10,
        volume: 85n,
        notionalCents: 848248n,
        imbalance: 361 / 1229,
      },
      {
        symbol: "BETA",
        lastPriceCents: 12503,
        spreadCents: 2,
        volume: 48n,
        notionalCents: 600144n,
        imbalance: 134 / 1266,
      },
    ]);
  } finally {
    generator.free();
  }
});

test("Wasm accepts TS endpoint limits and produces valid simulator fields", () => {
  for (const instruments of LIMITS.instrumentCount) {
    const generator = new MarketGenerator(instruments, 42);
    const metrics = new MetricAggregator(instruments);
    try {
      for (const count of LIMITS.updatesPerBatch) {
        const batch = generator.generateBatch(count);
        expect(batch.length).toBe(count * 7);
        for (let i = 0; i < batch.length; i += 7) {
          const [index, price, quantity, bid, ask, bidQuantity, askQuantity] =
            batch.subarray(i, i + 7);
          // Обычные assert в цикле не создают тысячи Playwright trace-шагов.
          assert.ok(index < instruments, `instrument at offset ${i}`);
          assert.ok(
            price === bid || price === ask,
            `trade price at offset ${i}`,
          );
          assert.ok(
            bid > 0 && ask > bid && ask <= 1_000_005,
            `quote at offset ${i}`,
          );
          assert.ok(
            quantity >= 1 && quantity <= 100,
            `quantity at offset ${i}`,
          );
          assert.ok(
            bidQuantity <= 1000 && askQuantity <= 1000,
            `book quantity at offset ${i}`,
          );
        }
        expect(() => metrics.process(batch)).not.toThrow();
      }
    } finally {
      generator.free();
    }
  }
});

test("Wasm rejects out-of-range integer sizes without advancing generator state", () => {
  for (const count of [
    LIMITS.instrumentCount[0] - 1,
    LIMITS.instrumentCount[1] + 1,
  ]) {
    // Освобождение выполняется и если контракт случайно изменится и неверный constructor начнёт проходить.
    let unexpected: MarketGenerator | undefined;
    try {
      expect(() => {
        unexpected = new MarketGenerator(count, 42);
      }).toThrow();
    } finally {
      unexpected?.free();
    }
  }
  const generator = new MarketGenerator(1, 42);
  const reference = new MarketGenerator(1, 42);
  try {
    for (const count of [
      LIMITS.updatesPerBatch[0] - 1,
      LIMITS.updatesPerBatch[1] + 1,
    ]) {
      expect(() => generator.generateBatch(count)).toThrow();
    }
    expect(generator.generateBatch(1)).toEqual(reference.generateBatch(1));
  } finally {
    generator.free();
    reference.free();
  }
  // Дроби/NaN проверяются validSettings до вызова Wasm: u32 на JS-границе может приводить числа к целым.
});
