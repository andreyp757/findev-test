/**
 * Назначение файла: Загружает настоящий бинарник в Node, проверяет fingerprint и миллион сгенерированных сделок.
 * Это проверка связки JavaScript/Wasm; её время не является измерением отрисовки Angular.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WASM_ASSET_FILE } from "../wasm/market-producer/pkg/wasm-asset.js";
import { performance } from "node:perf_hooks";
import init, {
  MarketGenerator,
} from "../wasm/market-producer/pkg/market_producer.js";
const bytes = await readFile(
  new URL(`../public/wasm/${WASM_ASSET_FILE}`, import.meta.url),
);
const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
assert.equal(
  WASM_ASSET_FILE,
  `market_producer.${digest}.wasm`,
  "Wasm asset name must match its exact bytes",
);
await init({ module_or_path: bytes });
const generator = new MarketGenerator(50, 42);
const start = performance.now();
let trades = 0;
for (let i = 0; i < 1000; i++) {
  const batch = generator.generateBatch(1000);
  assert.equal(batch.length, 7000);
  for (let j = 0; j < batch.length; j += 7) {
    assert.ok(batch[j] < 50 && batch[j + 3] < batch[j + 4]);
    assert.ok(batch[j + 1] === batch[j + 3] || batch[j + 1] === batch[j + 4]);
    trades++;
  }
}
generator.free();
console.log(
  `Wasm smoke: ${trades.toLocaleString()} real Wasm trades generated and validated in ${(performance.now() - start).toFixed(1)}ms (Node, not a browser benchmark).`,
);
