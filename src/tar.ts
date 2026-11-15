// Minimal ustar reader for npm tarballs (gzip). Reads regular files only.
import { gunzipSync } from "node:zlib";

export function readTgz(buf: Buffer): Map<string, Buffer> {
  const data = gunzipSync(buf);
  const files = new Map<string, Buffer>();
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= data.length) {
    const header = data.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (s: number, l: number) => header.subarray(s, s + l).toString("utf8").replace(/\0.*$/s, "");
    let name = str(0, 100);
    const prefix = str(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = data.subarray(off + 512, off + 512 + size);
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
    } else {
      if (longName) {
        name = longName;
        longName = null;
      }
      if (type === "0" || type === "\0") files.set(name, Buffer.from(body));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
