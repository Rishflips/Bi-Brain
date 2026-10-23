import { z } from "zod";
import { PaddleStore } from "./paddle-store.ts";
import { BrainError } from "../domain/logic.ts";

/** Reuses the proven coordination schema in a separate dodo.sqlite file.
 * Legacy SQL table names are implementation details, never shared provider data.
 * The independent BillingAuthority remains the only allowance writer. */
export class DodoStore extends PaddleStore {
  constructor(
    path: string,
    private readonly sessionClock: () => Date = () => new Date(),
  ) {
    super(path, sessionClock);
  }
  saveCheckout(
    intentId: string,
    version: number,
    sessionId: string,
    url: string,
  ) {
    z.string().uuid().parse(intentId);
    z.string()
      .regex(/^cks_[A-Za-z0-9_-]{1,180}$/)
      .parse(sessionId);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dodo_sessions(
      intent_id TEXT PRIMARY KEY REFERENCES paddle_checkout_intents(intent_id),
      session_id TEXT NOT NULL UNIQUE, checkout_url TEXT NOT NULL)`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const intent = this.db
        .prepare(
          "SELECT state,version FROM paddle_checkout_intents WHERE intent_id=?",
        )
        .get(intentId);
      // A webhook can complete before the checkout-create response returns.
      if (
        !intent ||
        Number(intent.version) < version ||
        !["pending", "created", "bound"].includes(String(intent.state))
      )
        throw new BrainError(
          "CONFLICT",
          "Checkout changed while it was opening.",
          409,
        );
      this.db
        .prepare("INSERT INTO dodo_sessions VALUES(?,?,?)")
        .run(intentId, sessionId, url);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  checkoutFor(accountId: string): string | null {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE name='dodo_sessions'")
      .get();
    if (!table) return null;
    const row = this.db
      .prepare(
        `SELECT s.checkout_url FROM dodo_sessions s
      JOIN paddle_checkout_intents i ON i.intent_id=s.intent_id
      WHERE i.account_id=? AND i.state='pending' AND i.expires_at>?`,
      )
      .get(accountId, this.sessionClock().toISOString());
    return typeof row?.checkout_url === "string" ? row.checkout_url : null;
  }
}
