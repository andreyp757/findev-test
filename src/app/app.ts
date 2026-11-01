import { Component, inject } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { MarketEngine } from "./market/market-engine";

@Component({
  selector: "app-root",
  host: { class: "app-shell" },
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: "./app.html",
  styleUrl: "./app.scss",
})
export class App {
  readonly engine = inject(MarketEngine);

  skipToMain(event: Event): void {
    event.preventDefault();
    document.getElementById("main")?.focus();
  }
}
