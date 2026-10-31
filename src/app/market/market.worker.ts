/// <reference lib="webworker" />
/**
 * Назначение файла: Точка входа фонового Worker: загружает настоящий Wasm и подключает ProducerRuntime.
 * Обёртка и имя бинарника входят в сборку Worker; DOM и компоненты Angular здесь не используются.
 */
import init, {
  MarketGenerator,
} from "../../../wasm/market-producer/pkg/market_producer";
import { WASM_ASSET_FILE } from "../../../wasm/market-producer/pkg/wasm-asset";
import { ProducerRuntime } from "./producer-runtime";
import { WorkerCommand } from "./worker-protocol";

// Кешируем загрузку модуля на жизнь Worker, но сам генератор для каждого run создаём заново.
let initialized: Promise<unknown> | undefined;

const runtime = new ProducerRuntime(
  async (count, seed, wasmBaseUrl) => {
    // JS-обёртка уже включена в Worker; по сети загружается только бинарник нужной версии.
    initialized ??= init({
      module_or_path: new URL(WASM_ASSET_FILE, wasmBaseUrl).href,
    });
    await initialized;
    return new MarketGenerator(count, seed);
  },
  (event) => postMessage(event),
);

addEventListener("message", ({ data }: MessageEvent<WorkerCommand>) =>
  runtime.handle(data),
);
