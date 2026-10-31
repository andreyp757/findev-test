//! Назначение файла: настоящий детерминированный симулятор рынка для native-тестов и WebAssembly.
//! Rust владеет случайной последовательностью, ценами инструментов и генерацией всех полей сделки.
//! JavaScript получает готовые порции; экспортированные объекты освобождаются через wasm-bindgen free().

use wasm_bindgen::prelude::*;

const MAX_PRICE: u32 = 1_000_000;
const WIDTH: usize = 7;

/// Псевдослучайный xorshift32 с seed: ноль заменяем, иначе последовательность застрянет в нулях.
/// Алгоритм нужен для воспроизводимой симуляции, а не криптографии или торговых прогнозов.
#[wasm_bindgen]
pub struct MarketGenerator {
    random: u32,
    prices: Vec<u32>,
}

#[wasm_bindgen]
impl MarketGenerator {
    #[wasm_bindgen(constructor)]
    pub fn new(instrument_count: u32, seed: u32) -> Result<MarketGenerator, String> {
        if !(1..=50).contains(&instrument_count) {
            return Err("Instrument count must be between 1 and 50".into());
        }
        Ok(Self {
            random: if seed == 0 { 0x9e3779b9 } else { seed },
            prices: (0..instrument_count).map(|i| 10_000 + i * 2_500).collect(),
        })
    }

    /// Создаёт ровно count обновлений. wasm-bindgen копирует Vec в отдельный Uint32Array.
    /// Массивом владеет JS; сам генератор нужно явно освободить при замене или завершении.
    #[wasm_bindgen(js_name = generateBatch)]
    pub fn generate_batch(&mut self, count: u32) -> Result<Vec<u32>, String> {
        if !(1..=1000).contains(&count) {
            return Err("Batch size must be between 1 and 1000".into());
        }
        let mut batch = Vec::with_capacity(count as usize * WIDTH);
        for _ in 0..count {
            let index = self.next() as usize % self.prices.len();
            let step = (self.next() % 41) as i32 - 20;
            // Ограниченный шаг от предыдущей цены: у каждого инструмента своя сохраняемая середина котировки.
            let midpoint = (self.prices[index] as i32 + step).clamp(10, MAX_PRICE as i32) as u32;
            self.prices[index] = midpoint;
            let half_spread = 1 + self.next() % 5;
            // Нижняя граница midpoint равна 10, half_spread не больше 5: bid всегда положителен.
            let bid = midpoint - half_spread;
            let ask = midpoint + half_spread;
            let price = if self.next() & 1 == 0 { bid } else { ask };
            let quantity = 1 + self.next() % 100;
            let bid_quantity = self.next() % 1001;
            let ask_quantity = self.next() % 1001;
            // ABI: порядок полей закреплён в market-data.ts и e2e/wasm-contract.spec.ts.
            batch.extend_from_slice(&[
                index as u32,
                price,
                quantity,
                bid,
                ask,
                bid_quantity,
                ask_quantity,
            ]);
        }
        Ok(batch)
    }
}

impl MarketGenerator {
    fn next(&mut self) -> u32 {
        let mut x = self.random;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.random = x;
        x
    }
}

// Native-тесты проверяют модель без браузера; реальную связку JS/Wasm проверяет отдельный smoke.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_invariants_at_boundaries() {
        for instruments in [1, 50] {
            let mut generator = MarketGenerator::new(instruments, 42).unwrap();
            for count in [1, 100, 1000] {
                let updates = generator.generate_batch(count).unwrap();
                assert_eq!(updates.len(), count as usize * WIDTH);
                for row in updates.chunks_exact(WIDTH) {
                    assert!(row[0] < instruments);
                    assert!(row[1] > 0 && row[3] > 0);
                    assert!(row[3] < row[4]);
                    assert!(row[1] == row[3] || row[1] == row[4]);
                    assert!(row[2] > 0);
                    assert!(row[5] <= 1000 && row[6] <= 1000);
                }
            }
        }
    }
    #[test]
    fn deterministic_and_persistent_across_calls() {
        let mut a = MarketGenerator::new(5, 123).unwrap();
        let mut b = MarketGenerator::new(5, 123).unwrap();
        let mut split = a.generate_batch(17).unwrap();
        split.extend(a.generate_batch(83).unwrap());
        assert_eq!(split, b.generate_batch(100).unwrap());
    }
    #[test]
    fn per_instrument_prices_evolve_from_previous_midpoints() {
        let mut generator = MarketGenerator::new(50, 7).unwrap();
        let mut previous: Vec<i32> = (0..50).map(|i| 10_000 + i * 2500).collect();
        for _ in 0..100 {
            for row in generator.generate_batch(1000).unwrap().chunks_exact(WIDTH) {
                let index = row[0] as usize;
                let midpoint = ((row[3] + row[4]) / 2) as i32;
                assert!((midpoint - previous[index]).abs() <= 20);
                previous[index] = midpoint;
            }
        }
    }
    #[test]
    fn zero_seed_is_safe_and_reproducible() {
        let mut a = MarketGenerator::new(1, 0).unwrap();
        let mut b = MarketGenerator::new(1, 0).unwrap();
        assert_eq!(
            a.generate_batch(100).unwrap(),
            b.generate_batch(100).unwrap()
        );
        assert_ne!(a.prices[0], 10_000);
    }
    #[test]
    fn bounds_survive_long_runs() {
        let mut generator = MarketGenerator::new(1, 91).unwrap();
        generator.prices[0] = 10;
        generator.generate_batch(1000).unwrap();
        assert!((10..=MAX_PRICE).contains(&generator.prices[0]));
        generator.prices[0] = MAX_PRICE;
        generator.generate_batch(1000).unwrap();
        assert!((10..=MAX_PRICE).contains(&generator.prices[0]));
    }
    #[test]
    fn rejects_invalid_sizes() {
        assert!(MarketGenerator::new(0, 1).is_err());
        assert!(MarketGenerator::new(51, 1).is_err());
        let mut generator = MarketGenerator::new(1, 1).unwrap();
        assert!(generator.generate_batch(0).is_err());
        assert!(generator.generate_batch(1001).is_err());
    }
}
