/// <reference lib="webworker" />
import { createPendingStore } from "./pending-store";
import { handleCapture } from "./capture";
import { drainSync } from "./sync";
import type { SharePayload } from "./types";

declare const self: ServiceWorkerGlobalScope;

const SHELL = ["/", "/index.html", "/captured.html", "/manifest.webmanifest"];
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
