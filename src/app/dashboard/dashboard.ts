/**
 * Назначение файла: Экран рынка: отображает сигналы сервиса и передаёт действия Pause / Resume.
 * Компонент форматирует готовые значения; генератор и накопление сделок работают в Worker.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { MarketEngine } from "../market/market-engine";
import {
  imbalance,
  integer,
  throughput,
  usd,
  usdRatio,
} from "../market/market-format";

@Component({
  selector: "app-dashboard",
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./dashboard.html",
  styleUrl: "./dashboard.css",
})
export class Dashboard {
  readonly engine = inject(MarketEngine);
  readonly integer = integer;
  readonly throughput = throughput;
  readonly usd = usd;
  readonly usdRatio = usdRatio;
  readonly imbalance = imbalance;
  readonly abs = Math.abs;
  readonly rate = computed(
    () =>
      (this.engine.settings().updatesPerBatch * 1000) /
      this.engine.settings().batchIntervalMs,
  );

  toggle(): void {
    this.engine.status() === "Paused"
      ? this.engine.resume()
      : this.engine.pause();
  }
}
