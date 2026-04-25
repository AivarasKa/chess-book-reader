/** Compute a content-based fingerprint of a file (SHA-256 of size + first 1MB). */
export async function fingerprintFile(file: File): Promise<string> {
  const head = file.slice(0, 1024 * 1024);
  const buf = await head.arrayBuffer();
  const sizeBytes = new TextEncoder().encode(`size:${file.size}|name:${file.name}|`);
  const combined = new Uint8Array(sizeBytes.length + buf.byteLength);
  combined.set(sizeBytes, 0);
  combined.set(new Uint8Array(buf), sizeBytes.length);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
