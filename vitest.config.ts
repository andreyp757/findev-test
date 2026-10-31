/**
 * Назначение файла: Настраивает быстрые тесты TypeScript: файлы *.spec.ts и среду Node по умолчанию.
 * Тест сервиса выбирает jsdom своей директивой; browser-сценарии запускаются отдельно через Playwright.
 */
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/**/*.spec.ts"], environment: "node" },
});
