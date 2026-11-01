/**
 * Rust → JS ABI: a flat Uint32Array with exactly UPDATE_WIDTH values per trade.
 * Offsets are in u32 elements, not bytes. Partial records are invalid.
 * instrument is an index in [0, instrumentCount); trade price and quantity are > 0;
 * 0 < bidCents < askCents; priceCents equals either bidCents or askCents.
 * Prices are integer cents; quantities are integer units, with zero allowed in the order book.
 * The aggregator accepts the u32 range. Contract tests verify the simulator's narrower ranges.
 * Field order matches Rust's batch.extend_from_slice and is locked by an independent fixture.
 */
export const UPDATE_OFFSET = {
  instrument: 0,
  priceCents: 1,
  quantity: 2,
  bidCents: 3,
  askCents: 4,
  bidQuantity: 5,
  askQuantity: 6,
} as const;

export const UPDATE_WIDTH = 7;

export interface InstrumentMetrics {
  readonly symbol: string;
  readonly lastPriceCents: number | null;
  readonly spreadCents: number | null;
  readonly volume: bigint;
  readonly notionalCents: bigint;
  readonly imbalance: number | null;
}
