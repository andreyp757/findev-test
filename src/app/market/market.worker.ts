/// <reference lib="webworker" />
import init, {
  MarketGenerator,
} from "../../../wasm/market-producer/pkg/market_producer";
import { WASM_ASSET_FILE } from "../../../wasm/market-producer/pkg/wasm-asset";
import { ProducerRuntime } from "./producer-runtime";
import { WorkerCommand } from "./worker-protocol";

// Cache the module for the Worker's lifetime, but create a new generator for each run.
let initialized: Promise<unknown> | undefined;

const runtime = new ProducerRuntime(
  async (count, seed, wasmBaseUrl) => {
    // The JS glue is bundled into the Worker; only the matching binary is fetched.
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
