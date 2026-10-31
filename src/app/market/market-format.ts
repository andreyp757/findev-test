/**
 * Назначение файла: Форматирует USD, дисбаланс, целые счётчики и дробную целевую скорость.
 * Округление выполняется только здесь; накопленные bigint-суммы не переводятся в неточный number.
 */
// Один форматтер на модуль: повторная настройка локали на каждой ячейке заметно дороже.
const integerFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
// Скорость может быть дробной: целочисленный форматтер здесь теряет информацию.
const rateFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
export function throughput(value: number): string {
  return rateFormatter.format(value);
}
export function integer(value: number | bigint): string {
  return integerFormatter.format(value);
}

/** Округляем положительную дробь до ближайшего цента, половины вверх; bigint не превращаем в number. */
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
  // Нормализуем только представление, не меняя знак и точность самой метрики.
  return formatted === "-0.00" ? "0.00" : formatted;
}
