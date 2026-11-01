import { Component, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { MarketEngine } from "../market/market-engine";
import { RunSummary } from "./run-summary/run-summary";
import { InstrumentTable } from "./instrument-table/instrument-table";

@Component({
  selector: "app-dashboard",
  host: { class: "dashboard" },
  imports: [RouterLink, RunSummary, InstrumentTable],
  templateUrl: "./dashboard.html",
  styleUrl: "./dashboard.scss",
})
export class Dashboard {
  readonly engine = inject(MarketEngine);

  toggle(): void {
    if (this.engine.status() === "Paused") {
      this.engine.resume();
    } else {
      this.engine.pause();
    }
  }
}
