/**
 * Назначение файла: Хранит значения по умолчанию, допустимые диапазоны и стабильные символы инструментов.
 * Общая проверка нужна сервису и Worker; форма использует те же ограничения для своих контролов.
 */
export interface ProducerSettings {
  readonly instrumentCount: number;
  readonly updatesPerBatch: number;
  readonly batchIntervalMs: number;
}

// Защищаем общий шаблон от случайной записи; активный запуск получает отдельную копию.
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

// Стабильный символ служит ключом строки: новые снимки не требуют заново создавать весь DOM.
export function symbols(count: number): string[] {
  const first = ["ALFA", "BETA", "GAMMA", "DELTA", "EPSI"];
  return Array.from(
    { length: count },
    (_, i) => first[i] ?? `SIM${String(i + 1).padStart(2, "0")}`,
  );
}
