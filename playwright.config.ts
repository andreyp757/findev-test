/**
 * Назначение файла: Настраивает browser-тесты production-сборки под путём репозитория GitHub Pages.
 * Поднимает локальный preview и сохраняет трассу сбоя; один исполнитель упрощает измерения нагрузки.
 */
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4173/findev-test/",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/serve-production.mjs",
    url: "http://127.0.0.1:4173/findev-test/",
    reuseExistingServer: !process.env["CI"],
  },
});
