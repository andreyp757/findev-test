/** Проверяет точность представления больших сумм и округление при общем Intl.NumberFormat. */
import { describe, expect, it } from "vitest";
import { imbalance, integer, usd, usdRatio } from "./market-format";

describe("market formatting", () => {
  it("formats bigint beyond Number precision without conversion", () => {
    expect(integer(900719925474099312345n)).toBe("900,719,925,474,099,312,345");
    expect(usdRatio(900719925474099312345n, 1n)).toBe(
      "$9,007,199,254,740,993,123.45",
    );
  });
  it("rounds half cents upward and carries into dollars", () => {
    expect(usdRatio(199n, 2n)).toBe("$1.00");
    expect(usdRatio(198n, 2n)).toBe("$0.99");
    expect(usdRatio(1n, 3n)).toBe("$0.00");
    expect(usdRatio(2n, 3n)).toBe("$0.01");
    expect(usd(0)).toBe("$0.00");
    expect(usd(null)).toBe("N/A");
    expect(usdRatio(0n, 0n)).toBe("N/A");
  });
});

describe("imbalance presentation", () => {
  it.each([
    [-1 / 1999, "0.00"],
    [1 / 1999, "0.00"],
    [-0, "0.00"],
    [0, "0.00"],
    [-0.0049, "0.00"],
    [-0.0051, "-0.01"],
    [-0.2, "-0.20"],
    [1, "1.00"],
    [null, "N/A"],
  ])("formats %s as %s without negative zero", (value, expected) => {
    expect(imbalance(value)).toBe(expected);
  });
});
