// Builds the post-capture redirect URL. The record id is appended only when
// present (every status except "error") so captured.html can offer collection
// chips that re-target the just-saved reel.
export function capturedRedirectUrl(status: string, id?: string): string {
  return `/captured.html?status=${status}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
}
