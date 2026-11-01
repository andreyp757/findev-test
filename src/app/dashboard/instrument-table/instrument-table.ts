import { Component, input } from "@angular/core";
import { InstrumentMetrics } from "../../market/market-data";
import { ProducerStatus } from "../../market/worker-protocol";
import { imbalance, integer, usd, usdRatio } from "../../market/market-format";

@Component({
  selector: "app-instrument-table",
  templateUrl: "./instrument-table.html",
  styleUrl: "./instrument-table.scss",
})
export class InstrumentTable {
  readonly rows = input.required<readonly InstrumentMetrics[]>();
  readonly runId = input.required<number>();
  readonly status = input.required<ProducerStatus>();
  readonly integer = integer;
  readonly usd = usd;
  readonly usdRatio = usdRatio;
  readonly imbalance = imbalance;
  readonly abs = Math.abs;
}
