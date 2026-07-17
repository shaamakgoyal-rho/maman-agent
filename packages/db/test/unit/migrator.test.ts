import { describe, expect, it } from "vitest";
import { loadMigrations } from "../../src/migrator.js";
import { migrationsDir } from "../integration/setup.js";

describe("loadMigrations", () => {
  it("loads every migration with a matching down file, in order", () => {
    const migrations = loadMigrations(migrationsDir);
    expect(migrations.length).toBeGreaterThanOrEqual(5);
    const ids = migrations.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
    for (const m of migrations) {
      expect(m.upSql.length).toBeGreaterThan(0);
      expect(m.downSql.length).toBeGreaterThan(0);
    }
  });

  it("throws when a down file is missing", () => {
    expect(() => loadMigrations("/nonexistent-dir")).toThrow();
  });
});
