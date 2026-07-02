// The trust rule (PRD 08 §5.2). When a request carries a valid Better Auth
// session, the account id from that session is the authoritative owner and any
// client-supplied user_id is ignored. With no session, the anonymous fast path
// is preserved: the client-supplied user_id is used, unverified, as today.

export interface SessionInfo {
  user?: { id?: string | null } | null;
}

export interface OwnerResolution {
  // Account id when signed in, else the claimed anonymous id, else null.
  ownerId: string | null;
  authed: boolean;
}

export async function resolveOwner(
  getSession: (headers: Headers) => Promise<SessionInfo | null>,
  headers: Headers,
  claimedUserId: string | null,
): Promise<OwnerResolution> {
  const session = await getSession(headers);
  const accountId = session?.user?.id;
  if (typeof accountId === "string" && accountId.length > 0) {
    return { ownerId: accountId, authed: true };
  }
  return { ownerId: claimedUserId, authed: false };
}
