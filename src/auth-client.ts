// Client-side Better Auth wrapper. Thin fetch calls against /api/auth/* — no
// extra bundle. Sign-in must be browser-initiated (a same-origin POST) so the
// better-auth.state PKCE cookie lands in this browser before redirecting.

const AUTH_BASE = "/api/auth";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface Session {
  user: AuthUser;
}

export async function getSession(): Promise<Session | null> {
  try {
    const res = await fetch(`${AUTH_BASE}/get-session`, { credentials: "same-origin" });
    if (!res.ok) return null;
    const body = (await res.json()) as Session | null;
    return body && body.user ? body : null;
  } catch {
    return null;
  }
}

export async function signInGoogle(
  callbackURL: string,
  navigate: (url: string) => void = (u) => {
    window.location.href = u;
  },
): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ provider: "google", callbackURL }),
  });
  const data = (await res.json()) as { url?: string };
  if (data.url) navigate(data.url);
}

export async function signOut(): Promise<void> {
  // Better Auth's POST routes require a JSON content-type AND a parseable body
  // (no body -> 400 "Invalid JSON"; wrong/no content-type -> 415).
  await fetch(`${AUTH_BASE}/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: "{}",
  });
}
