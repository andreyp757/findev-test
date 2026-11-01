import { InstrumentMetrics, UPDATE_OFFSET, UPDATE_WIDTH } from "./market-data";
import { LIMITS, symbols } from "./producer-settings";

interface Accumulator {
  symbol: string;
  last: number | null;
  volume: bigint;
  notional: bigint;
  bid: number | null;
  ask: number | null;
  bidQuantity: number;
  askQuantity: number;
}

/** Storage scales with instruments rather than trades; totals remain exact. */
export class MetricAggregator {
  private readonly rows: Accumulator[];

  constructor(count: number) {
    if (
      !Number.isInteger(count) ||
      count < LIMITS.instrumentCount[0] ||
      count > LIMITS.instrumentCount[1]
    ) {
      throw new Error("Invalid instrument count");
    }

    this.rows = symbols(count).map((symbol) => ({
      symbol,
      last: null,
      volume: 0n,
      notional: 0n,
      bid: null,
      ask: null,
      bidQuantity: 0,
      askQuantity: 0,
    }));
  }

  process(batch: Uint32Array): void {
    if (batch.length % UPDATE_WIDTH !== 0) {
      throw new Error("Invalid market batch length");
    }

    // Validate the entire batch before changing totals to avoid partial updates on invalid input.
    // Direct indexing avoids two temporary subarray views per trade.
    for (let i = 0; i < batch.length; i += UPDATE_WIDTH) {
      const index = batch[i + UPDATE_OFFSET.instrument];
      const price = batch[i + UPDATE_OFFSET.priceCents];
      const quantity = batch[i + UPDATE_OFFSET.quantity];
      const bid = batch[i + UPDATE_OFFSET.bidCents];
      const ask = batch[i + UPDATE_OFFSET.askCents];

      if (
        !this.rows[index] ||
        price === 0 ||
        quantity === 0 ||
        bid === 0 ||
        bid >= ask ||
        (price !== bid && price !== ask)
      ) {
        throw new Error("Invalid market update");
      }
    }

    for (let i = 0; i < batch.length; i += UPDATE_WIDTH) {
      const index = batch[i + UPDATE_OFFSET.instrument];
      const price = batch[i + UPDATE_OFFSET.priceCents];
      const quantity = batch[i + UPDATE_OFFSET.quantity];
      const bid = batch[i + UPDATE_OFFSET.bidCents];
      const ask = batch[i + UPDATE_OFFSET.askCents];
      const bidQuantity = batch[i + UPDATE_OFFSET.bidQuantity];
      const askQuantity = batch[i + UPDATE_OFFSET.askQuantity];

      const row = this.rows[index];
      row.last = price;

      // Convert operands before multiplication to avoid rounding large products as number.
      row.volume += BigInt(quantity);
      row.notional += BigInt(price) * BigInt(quantity);

      row.bid = bid;
      row.ask = ask;
      row.bidQuantity = bidQuantity;
      row.askQuantity = askQuantity;
    }
  }

  snapshot(): readonly InstrumentMetrics[] {
    return this.rows.map((row) => ({
      symbol: row.symbol,
      lastPriceCents: row.last,
      spreadCents:
        row.bid === null || row.ask === null ? null : row.ask - row.bid,
      volume: row.volume,
      notionalCents: row.notional,
      imbalance:
        row.bidQuantity + row.askQuantity === 0
          ? null
          : (row.bidQuantity - row.askQuantity) /
            (row.bidQuantity + row.askQuantity),
    }));
  }
}
