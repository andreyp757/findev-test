import { InstrumentMetrics } from "./market-data";
import { ProducerSettings } from "./producer-settings";

/** Exact cumulative totals shared by regular snapshots and error checkpoints. */
export interface MarketSnapshot {
  rows: readonly InstrumentMetrics[];
  trades: bigint;
  batches: number;
}

export type ProducerStatus = "Initializing" | "Running" | "Paused" | "Error";

// Only ERROR events carry the Error status, ensuring a required message and dedicated handling.
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
