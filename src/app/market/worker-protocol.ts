/**
 * Назначение файла: Общий контракт команд и событий между Angular и Worker.
 * Поле type различает варианты сообщения, а runId связывает каждый ответ с конкретным запуском.
 */
import { InstrumentMetrics } from "./market-data";
import { ProducerSettings } from "./producer-settings";

/** Полный точный срез накоплений; используется и в обычном снимке, и при сообщаемой ошибке. */
export interface MarketSnapshot {
  rows: readonly InstrumentMetrics[];
  trades: bigint;
  batches: number;
}

export type ProducerStatus = "Initializing" | "Running" | "Paused" | "Error";

// Error передаётся только событием ERROR: у него обязательны сообщение и отдельная обработка.
export type WorkerStatus = Exclude<ProducerStatus, "Error">;

export type WorkerCommand =
  | {
      type: "START_RUN";
      runId: number;
      settings: ProducerSettings;
      seed: number;
      wasmBaseUrl: string;
    }
  | { type: "PAUSE" | "RESUME" | "DISPOSE"; runId: number }
  | { type: "ACK"; runId: number; sequence: number };

export type WorkerEvent =
  | { type: "STATUS"; runId: number; status: WorkerStatus }
  | ({ type: "SNAPSHOT"; runId: number; sequence: number } & MarketSnapshot)
  | {
      type: "ERROR";
      runId: number;
      message: string;
      snapshot?: MarketSnapshot;
    };
