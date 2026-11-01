/**
 * Run TypeScript *.spec.ts tests in Node by default.
 * The service test opts into jsdom; Playwright runs browser scenarios separately.
 */
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/**/*.spec.ts"], environment: "node" },
});
