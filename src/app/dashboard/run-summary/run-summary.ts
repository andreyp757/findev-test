import { Component, computed, input } from "@angular/core";
import { ProducerSettings } from "../../market/producer-settings";
import { integer, throughput } from "../../market/market-format";

@Component({
  selector: "app-run-summary",
  templateUrl: "./run-summary.html",
  styleUrl: "./run-summary.scss",
})
export class RunSummary {
  readonly settings = input.required<ProducerSettings>();
  readonly trades = input.required<bigint>();
  readonly batches = input.required<number>();
  readonly integer = integer;
  readonly throughput = throughput;
  readonly rate = computed(
    () =>
      (this.settings().updatesPerBatch * 1000) /
      this.settings().batchIntervalMs,
  );
}
