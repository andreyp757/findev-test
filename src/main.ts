/**
 * Назначение файла: Точка входа приложения: создаёт корневой компонент Angular и подключает общие провайдеры.
 * Здесь выбираются zoneless-обновления и маршруты через #; рыночная логика остаётся в Worker.
 */
import { provideZonelessChangeDetection } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, withHashLocation } from "@angular/router";
import { App } from "./app/app";
import { routes } from "./app/app.routes";

bootstrapApplication(App, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withHashLocation()),
  ],
}).catch((error) => {
  console.error(error);
  document.body.textContent =
    "Application failed to initialize. Please reload.";
});
