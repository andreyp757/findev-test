/**
 * Назначение файла: Проверяет финансовые формулы, пустые данные, разделение инструментов и точность больших сумм.
 * Заданные вручную ожидаемые значения позволяют поймать ошибку, даже если интерфейс выглядит правильно.
 */
import { describe, expect, it } from "vitest";
import { MetricAggregator } from "./metric-aggregator";
import { imbalance, usd, usdRatio } from "./market-format";

const batch = (...rows: number[][]) => new Uint32Array(rows.flat());

const t1 = [0, 10000, 10, 9996, 10000, 600, 400];

const t2 = [0, 10200, 30, 10196, 10200, 600, 400];

describe("cumulative market metrics", () => {
  it("matches the mandatory example exactly, across separate batches", () => {
    const a = new MetricAggregator(1);
    a.process(batch(t1));
    a.process(batch(t2));
    const m = a.snapshot()[0];
    expect(usd(m.lastPriceCents)).toBe("$102.00");
    expect(m.volume).toBe(40n);
    expect(usdRatio(m.notionalCents, m.volume)).toBe("$101.50");
    expect(usd(m.spreadCents)).toBe("$0.04");
    expect(imbalance(m.imbalance)).toBe("0.20");
  });
  it("shows unavailable metrics and zero volume before the first trade", () => {
    expect(new MetricAggregator(1).snapshot()[0]).toEqual({
      symbol: "ALFA",
      lastPriceCents: null,
      spreadCents: null,
      volume: 0n,
      notionalCents: 0n,
      imbalance: null,
    });
    expect(usd(null)).toBe("N/A");
    expect(usdRatio(0n, 0n)).toBe("N/A");
  });
  it("counts every repeated instrument trade and keeps instruments isolated", () => {
    const a = new MetricAggregator(2);
    a.process(batch(t1, t2, [1, 500, 7, 499, 500, 0, 20]));
    expect(a.snapshot().map((m) => m.volume)).toEqual([40n, 7n]);
    expect(a.snapshot()[1].imbalance).toBe(-1);
    expect(a.snapshot()[0].lastPriceCents).toBe(10200);
  });
  it("handles zero book quantity independently from traded volume", () => {
    const a = new MetricAggregator(1);
    a.process(batch([0, 100, 5, 99, 100, 0, 0]));
    expect(a.snapshot()[0].imbalance).toBeNull();
    expect(a.snapshot()[0].volume).toBe(5n);
  });
  it("accumulates notional above the safe Number range without losing precision", () => {
    const a = new MetricAggregator(1);
    const row = [0, 4294967295, 4294967295, 4294967294, 4294967295, 0, 1];
    a.process(batch(row, row));
    expect(a.snapshot()[0].notionalCents).toBe(2n * 4294967295n ** 2n);
    expect(
      usdRatio(a.snapshot()[0].notionalCents, a.snapshot()[0].volume),
    ).toBe("$42,949,672.95");
  });
  it("keeps traded volume exact after crossing Number.MAX_SAFE_INTEGER", () => {
    const a = new MetricAggregator(1);
    const row = [0, 100, 4294967295, 99, 100, 1, 1];
    const thousand = new Uint32Array(
      Array.from({ length: 1000 }, () => row).flat(),
    );
    // Для выхода объёма за безопасную границу number нужны 2 097 153 сделки с максимальным u32.
    // Повторно используем небольшую порцию, не храня всю тестовую историю.
    for (let i = 0; i < 2097; i++) a.process(thousand);
    a.process(thousand.subarray(0, 153 * 7));
    const expected = 2_097_153n * 4_294_967_295n;
    expect(expected).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(a.snapshot()[0].volume).toBe(expected);
    expect(a.snapshot()[0].notionalCents).toBe(expected * 100n);
    expect(usdRatio(a.snapshot()[0].notionalCents, expected)).toBe("$1.00");
  });
  it("rounds fractional cents only at presentation", () => {
    expect(usdRatio(302n, 3n)).toBe("$1.01");
    expect(usdRatio(201n, 2n)).toBe("$1.01");
  });
  it("rejects a malformed batch without partially applying it", () => {
    const a = new MetricAggregator(1);
    expect(() => a.process(batch(t1, [1, 100, 1, 99, 100, 1, 1]))).toThrow();
    expect(a.snapshot()[0].volume).toBe(0n);
    expect(() => a.process(new Uint32Array([0]))).toThrow();
  });
  it("keeps previously published snapshots immutable", () => {
    const a = new MetricAggregator(1);
    const before = a.snapshot();
    a.process(batch(t1));
    expect(before[0].volume).toBe(0n);
  });
});

it.each([
  ["instrument", [1, 100, 1, 99, 100, 1, 1]],
  ["price", [0, 0, 1, 99, 100, 1, 1]],
  ["quantity", [0, 100, 0, 99, 100, 1, 1]],
  ["bid", [0, 100, 1, 0, 100, 1, 1]],
  ["crossed book", [0, 100, 1, 100, 99, 1, 1]],
  ["off-market trade", [0, 101, 1, 99, 100, 1, 1]],
])(
  "rejects invalid %s after a valid row without changing existing totals",
  (_, invalid) => {
    const metrics = new MetricAggregator(1);
    metrics.process(batch(t1));
    const before = metrics.snapshot();
    expect(() => metrics.process(batch(t2, invalid as number[]))).toThrow(
      "Invalid market update",
    );
    expect(metrics.snapshot()).toEqual(before);
  },
);
