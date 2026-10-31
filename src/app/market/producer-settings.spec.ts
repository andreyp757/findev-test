/**
 * Назначение файла: Проверяет настройки по умолчанию, целочисленность, границы и уникальность символов.
 * Эти тесты не дают форме и производителю незаметно принять недопустимую конфигурацию.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  LIMITS,
  symbols,
  validSettings,
} from "./producer-settings";

describe("settings", () => {
  it("has valid requested defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      instrumentCount: 5,
      updatesPerBatch: 100,
      batchIntervalMs: 500,
    });
    expect(validSettings(DEFAULT_SETTINGS)).toBe(true);
  });
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    it(`validates integer boundaries for ${key}`, () => {
      for (const value of [min, max])
        expect(validSettings({ ...DEFAULT_SETTINGS, [key]: value })).toBe(true);
      for (const value of [min - 1, max + 1, min + 0.5, NaN, Infinity])
        expect(validSettings({ ...DEFAULT_SETTINGS, [key]: value })).toBe(
          false,
        );
    });
  }
  it("generates 50 unique stable symbols", () => {
    expect(new Set(symbols(50)).size).toBe(50);
    expect(symbols(5)).toEqual(["ALFA", "BETA", "GAMMA", "DELTA", "EPSI"]);
  });
});
