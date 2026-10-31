/**
 * Назначение файла: Описывает числовой формат обновления Rust и готовые метрики одной строки.
 * Единицы измерения общие для обоих потоков: цена в центах, накопленные объём и стоимость в bigint.
 */
/**
 * ABI Rust → JS: плоский Uint32Array, ровно UPDATE_WIDTH значений на сделку.
 * Смещения считаются в элементах u32, не байтах. Частичных записей нет.
 * instrument — индекс [0, instrumentCount); цена/количество сделки > 0;
 * 0 < bidCents < askCents; priceCents совпадает с bidCents или askCents.
 * Цены — целые центы; количества — целые единицы, стакан допускает нули.
 * Накопитель принимает диапазон u32. Более узкие диапазоны симулятора проверяет контрактный тест.
 * Порядок полей согласован с batch.extend_from_slice в Rust и зафиксирован независимой fixture.
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
