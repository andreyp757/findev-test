/**
 * Назначение файла: Собирает Rust/Wasm и автоматически готовит бинарник для Angular.
 * Имя по хешу связывает содержимое Wasm с его Worker/glue и защищает от старого браузерного кеша.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
const result = spawnSync(
  "wasm-pack",
  [
    "build",
    "wasm/market-producer",
    "--target",
    "web",
    "--release",
    "--out-dir",
    "pkg",
    "--",
    "--locked",
  ],
  { stdio: "inherit" },
);
if (result.error) {
  console.error(
    "wasm-pack is required. See README.md for setup.",
    result.error.message,
  );
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
// Новое содержимое получает новый URL: кеш не должен подставлять старый Wasm новому glue.
const bytes = readFileSync("wasm/market-producer/pkg/market_producer_bg.wasm");
const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const filename = `market_producer.${digest}.wasm`;
mkdirSync("public/wasm", { recursive: true });
writeFileSync(`public/wasm/${filename}`, bytes);
for (const old of readdirSync("public/wasm")) {
  if (
    old !== filename &&
    (old === "market_producer_bg.wasm" ||
      /^market_producer\.[a-f0-9]{16}\.wasm$/.test(old))
  )
    unlinkSync(`public/wasm/${old}`);
}
// Создаём рядом с glue константу имени: её импортирует Worker, а не основной поток.
writeFileSync(
  "wasm/market-producer/pkg/wasm-asset.js",
  `export const WASM_ASSET_FILE = ${JSON.stringify(filename)};\n`,
);
writeFileSync(
  "wasm/market-producer/pkg/wasm-asset.d.ts",
  "export declare const WASM_ASSET_FILE: string;\n",
);
