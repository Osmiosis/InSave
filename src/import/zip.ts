import { unzipSync, strFromU8 } from "fflate";
import { ImportError } from "./errors";

// PK\x03\x04 (local file header) or PK\x05\x06 (empty archive end record).
function isZip(buf: Uint8Array): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05) &&
    (buf[3] === 0x04 || buf[3] === 0x06)
  );
}

export async function extractSavedPostsJson(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());

  if (isZip(buf)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(buf);
    } catch {
      throw new ImportError("We couldn't open this zip file.");
    }
    const key = Object.keys(entries).find((k) => k.toLowerCase().endsWith("saved_posts.json"));
    if (!key) throw new ImportError("We couldn't find your saved posts in this zip.");
    return strFromU8(entries[key]);
  }

  // Not a zip: assume it's the JSON file itself.
  return strFromU8(buf);
}
