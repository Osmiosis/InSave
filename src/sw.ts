/// <reference lib="webworker" />
import { createPendingStore } from "./pending-store";
import { handleCapture } from "./capture";
import type { SharePayload } from "./types";
import { createCollectionsStore } from "./collections-store";
import { drainAll } from "./drain-all";
import { capturedRedirectUrl } from "./captured-url";

declare const self: ServiceWorkerGlobalScope;

const SHELL = ["/", "/index.html", "/captured.html", "/collection.html", "/cleanup.html", "/review.html", "/capture.html", "/ios.html", "/manifest.webmanifest"];
// Bump on any SW behavior change so activate() purges the previous cache.
const CACHE = "insave-shell-v6";

// Open the IndexedDB connection once and reuse it; avoids racing parallel
// openDB calls across activate + overlapping share events.
const storePromise = createPendingStore();
const collectionsPromise = createCollectionsStore();

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Cache each shell entry independently: one failed fetch must NOT abort the
      // rest (cache.addAll is all-or-nothing and was leaving the cache poisoned).
      await Promise.allSettled(SHELL.map((u) => cache.add(u)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop any stale caches from earlier SW versions.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      const store = await storePromise;
      const collections = await collectionsPromise;
      await drainAll(store, collections).catch(() => {}); // opportunistic drain; never block activation
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

  // App-shell navigations: network-first so a fresh deploy always wins and a stale
  // cache entry can never break a page. Cache is only a fallback when offline.
  if (event.request.method === "GET" && (event.request.mode === "navigate" || SHELL.includes(url.pathname))) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(event.request);
          if (SHELL.includes(url.pathname)) {
            const cache = await caches.open(CACHE);
            cache.put(event.request, res.clone()).catch(() => {}); // refresh; ignore quota errors
          }
          return res;
        } catch {
          // Offline: serve the cached page (ignoreSearch so /captured.html?status=… matches).
          const cached = await caches.match(event.request, { ignoreSearch: true });
          if (cached) return cached;
          const shell = (await caches.match("/index.html")) ?? (await caches.match("/"));
          return shell ?? new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
        }
      })(),
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
  let id: string | undefined;
  try {
    const store = await storePromise;
    const result = await handleCapture(payload, store);
    status = result.status;
    id = result.record?.id;
    const collections = await collectionsPromise;
    // fire-and-forget sync of both rails; never blocks the redirect
    drainAll(store, collections).catch(() => {});
  } catch {
    status = "error";
  }

  return Response.redirect(capturedRedirectUrl(status, id), 303);
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
