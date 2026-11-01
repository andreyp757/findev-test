export interface ProducerSettings {
  readonly instrumentCount: number;
  readonly updatesPerBatch: number;
  readonly batchIntervalMs: number;
}

// Protect shared defaults from mutation; each active run gets its own copy.
export const DEFAULT_SETTINGS: ProducerSettings = Object.freeze({
  instrumentCount: 5,
  updatesPerBatch: 100,
  batchIntervalMs: 500,
});

export const LIMITS = {
  instrumentCount: [1, 50],
  updatesPerBatch: [1, 1000],
  batchIntervalMs: [50, 2000],
} as const;

export function validSettings(value: ProducerSettings): boolean {
  return Object.entries(LIMITS).every(([key, [min, max]]) => {
    const number = value[key as keyof ProducerSettings];
    return Number.isInteger(number) && number >= min && number <= max;
  });
}

// Use a stable symbol as the row key to reuse DOM nodes across snapshots.
export function symbols(count: number): string[] {
  const first = ["ALFA", "BETA", "GAMMA", "DELTA", "EPSI"];
  return Array.from(
    { length: count },
    (_, i) => first[i] ?? `SIM${String(i + 1).padStart(2, "0")}`,
  );
}
