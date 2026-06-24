// VAPID public key is NOT secret — it ships to the client as the applicationServerKey.
// Generate with `npx web-push generate-vapid-keys`; replace the placeholder below and
// the matching VAPID_PUBLIC_KEY in wrangler.toml.
export const VAPID_PUBLIC_KEY = "BJeDm2fJtqPlVSjnFRZOKav5k5uV5IlTszRDb8VcMTdeby9Hb461I376KRIi12oY_IkrcrQurHgAT_6NmcVi_pc";

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}
