/**
 * Назначение файла: Общая оболочка: шапка, навигация, область текущей страницы и подвал.
 * Получение корневого MarketEngine запускает один движок, который переживает смену экранов.
 */
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { MarketEngine } from "./market/market-engine";

@Component({
  selector: "app-root",
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./app.html",
  styleUrl: "./app.css",
})
export class App {
  readonly engine = inject(MarketEngine);

  skipToMain(event: Event): void {
    event.preventDefault();
    document.getElementById("main")?.focus();
  }
}
