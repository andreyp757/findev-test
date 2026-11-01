import { Component, input } from "@angular/core";
import { ProducerSettings } from "../../market/producer-settings";
import { ProducerStatus } from "../../market/worker-protocol";

@Component({
  selector: "app-active-configuration",
  templateUrl: "./active-configuration.html",
  styleUrl: "./active-configuration.scss",
})
export class ActiveConfiguration {
  readonly settings = input.required<ProducerSettings>();
  readonly status = input.required<ProducerStatus>();
  readonly runId = input.required<number>();
}
