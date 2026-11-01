// Reuse one formatter per module to avoid locale setup for every cell.
const integerFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

// Rates can be fractional; integer formatting would lose information.
const rateFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

export function throughput(value: number): string {
  return rateFormatter.format(value);
}

export function integer(value: number | bigint): string {
  return integerFormatter.format(value);
}

/** Round a positive fraction to the nearest cent, half up, without converting bigint to number. */
export function usdRatio(numeratorCents: bigint, denominator: bigint): string {
  if (denominator === 0n) return "N/A";
  const cents = (numeratorCents * 2n + denominator) / (2n * denominator);
  return `$${integer(cents / 100n)}.${String(cents % 100n).padStart(2, "0")}`;
}

export function usd(cents: number | null): string {
  return cents === null ? "N/A" : usdRatio(BigInt(cents), 1n);
}

export function imbalance(value: number | null): string {
  if (value === null) return "N/A";
  const formatted = value.toFixed(2);
  // Normalize display only, preserving the metric's sign and precision.
  return formatted === "-0.00" ? "0.00" : formatted;
}
