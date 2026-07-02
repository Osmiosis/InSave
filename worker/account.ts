import type { Stmt } from "./merge";

// Account deletion (PRD 08 §7.1, §10.4). Removes the account's owned app data
// AND its Better Auth records. Sessions/accounts are deleted explicitly rather
// than relying on FK cascade (D1 does not enable foreign_keys by default). Every
// statement is scoped to the one account id — no unscoped deletes.
export function buildAccountDeleteStatements(accountId: string): Stmt[] {
  const p = [accountId];
  return [
    { sql: `DELETE FROM pending_capture WHERE user_id = ?`, params: p },
    { sql: `DELETE FROM collections WHERE user_id = ?`, params: p },
    { sql: `DELETE FROM user_settings WHERE user_id = ?`, params: p },
    { sql: `DELETE FROM push_subscriptions WHERE user_id = ?`, params: p },
    { sql: `DELETE FROM session WHERE userId = ?`, params: p },
    { sql: `DELETE FROM account WHERE userId = ?`, params: p },
    { sql: `DELETE FROM user WHERE id = ?`, params: p },
  ];
}
