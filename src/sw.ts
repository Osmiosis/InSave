/// <reference lib="webworker" />
import { createPendingStore } from "./pending-store";
import { handleCapture } from "./capture";
import { drainSync } from "./sync";
import type { SharePayload } from "./types";

declare const self: ServiceWorkerGlobalScope;

const SHELL = ["/", "/index.html", "/captured.html", "/tag.html", "/review.html", "/manifest.webmanifest"];
const CACHE = "insave-shell-v1";

// Open the IndexedDB connection once and reuse it; avoids racing parallel
// openDB calls across activate + overlapping share events.
const storePromise = createPendingStore();

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const store = await storePromise;
      await drainSync(store); // opportunistic drain on activation
    })(),
  );
});

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Share target: intercept the POST, do synchronous capture, redirect to toast page.
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(handleShare(event.request));
    return;
  }

  // Cache-first for the app shell so /captured loads offline.
  if (event.request.method === "GET" && SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit ?? fetch(event.request)),
    );
  }
});

async function handleShare(request: Request): Promise<Response> {
  let payload: SharePayload = {};
  try {
    const form = await request.formData();
    payload = {
      url: (form.get("url") as string) || undefined,
      text: (form.get("text") as string) || undefined,
      title: (form.get("title") as string) || undefined,
    };
  } catch {
    /* fall through with empty payload -> unparsed */
  }

  let status: string;
  try {
    const store = await storePromise;
    const result = await handleCapture(payload, store);
    status = result.status;
    // fire-and-forget sync; never blocks the redirect
    drainSync(store).catch(() => {});
  } catch {
    status = "error";
  }

  return Response.redirect(`/captured.html?status=${status}`, 303);
}

self.addEventListener("push", (event: PushEvent) => {
  let data: { title: string; body: string; count: number; user_id?: string; ids?: string[] } = {
    title: "InSave", body: "Saved reels worth revisiting", count: 0,
  };
  try {
    if (event.data) data = { ...data, ...(event.data.json() as typeof data) };
  } catch {
    /* malformed payload — fall back to the default copy */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: "insave-digest", // collapse repeat digests into one
      data,
      // `actions` is valid at runtime (Notifications API) but missing from the lib type.
      actions: [
        { action: "done", title: "Done" },
        { action: "snooze", title: "Snooze" },
      ],
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { user_id?: string; ids?: string[] };

  if ((event.action === "done" || event.action === "snooze") && data.user_id && data.ids?.length) {
    event.waitUntil(
      fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: data.user_id, ids: data.ids, action: event.action }),
      })
        .then(() => undefined)
        .catch(() => undefined),
    );
    return;
  }

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((c) => "focus" in c);
      if (existing) {
        await existing.focus();
        return;
      }
      await self.clients.openWindow("/review.html");
    })(),
  );
});
