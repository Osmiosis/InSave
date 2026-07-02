import { describe, it, expect } from "vitest";
import { buildAccountDeleteStatements } from "../worker/account";

describe("buildAccountDeleteStatements", () => {
  const stmts = buildAccountDeleteStatements("acct1");
  const byTable = (t: string) => stmts.find((s) => s.sql.includes(` ${t} `) || s.sql.includes(`${t} WHERE`));

  it("deletes the account's owned app rows by user_id", () => {
    for (const table of ["pending_capture", "collections", "user_settings", "push_subscriptions"]) {
      const s = byTable(table);
      expect(s, table).toBeTruthy();
      expect(s!.sql).toContain("WHERE user_id = ?");
      expect(s!.params).toEqual(["acct1"]);
    }
  });

  it("deletes the Better Auth session/account rows by userId and the user by id", () => {
    expect(byTable("session")!.sql).toContain("WHERE userId = ?");
    expect(byTable("account")!.sql).toContain("WHERE userId = ?");
    const user = stmts.find((s) => s.sql.includes("FROM user WHERE id = ?"));
    expect(user).toBeTruthy();
    expect(user!.params).toEqual(["acct1"]);
  });

  it("every statement targets only this account (no unscoped deletes)", () => {
    for (const s of stmts) {
      expect(s.sql).toMatch(/WHERE/);
      expect(s.params).toEqual(["acct1"]);
    }
  });
});
