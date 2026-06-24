import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { indexedDB } from "fake-indexeddb";
import { createPendingStore } from "../src/pending-store";
import { pullAndReconcile } from "../src/reminder-pull";
import { openInsaveDB, PENDING_STORE } from "../src/db";
import type { PendingCapture } from "../src/types";

function rec(over: Partial<PendingCapture>): PendingCapture {
  return {
    id: "a", canonical_url: "u", raw_payload: "{}", captured_at: 0,
    source: "import", status: "tagged", parse_ok: true, synced: true, ...over,
  };
}

describe("pullAndReconcile", () => {
  beforeEach(async () => {
    await new Promise<void>((res) => {
      const del = indexedDB.deleteDatabase("insave");
      del.onsuccess = () => res();
      del.onerror = () => res();
    });
  });

  it("overlays server reminder state but keeps local tags, and inserts new records", async () => {
    const store = await createPendingStore(() => 0, () => "u1");
    await store.put(rec({ id: "a", topic_tags: ["gym"], reminder_status: undefined }));

    const remote: PendingCapture[] = [
      rec({ id: "a", topic_tags: ["SERVER"], reminder_status: "active", next_due_at: 50 }),
      rec({ id: "b", topic_tags: ["new"], reminder_status: "active", next_due_at: 70 }),
    ];
    const fetchFn = (async () => new Response(JSON.stringify({ items: remote }), { status: 200 })) as unknown as typeof fetch;

    await pullAndReconcile(fetchFn);

    const db = await openInsaveDB();
    const a = (await db.get(PENDING_STORE, "a")) as PendingCapture;
    const b = (await db.get(PENDING_STORE, "b")) as PendingCapture;
    expect(a.topic_tags).toEqual(["gym"]); // local device content kept
    expect(a.reminder_status).toBe("active"); // server state overlaid
    expect(a.next_due_at).toBe(50);
    expect(b.id).toBe("b"); // new record inserted
    expect(b.reminder_status).toBe("active");
  });
});
