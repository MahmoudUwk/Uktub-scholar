/**
 * A tiny ustar writer for tests: builds .tar.gz bytes with arbitrary entry names and types, including the
 * hostile ones (`..` members, absolute paths, symlinks) a real archiver refuses to create.
 */
import { gzipSync } from "node:zlib";

export interface TarEntry {
  name: string;
  /** file content (default empty) */
  data?: string | Uint8Array;
  type?: "file" | "dir" | "symlink";
  linkname?: string;
  mode?: number;
}

const octal = (n: number, width: number): string => n.toString(8).padStart(width - 1, "0") + "\0";

function header(e: TarEntry, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number, max: number): void => void h.set(Buffer.from(s, "utf8").subarray(0, max), at);
  put(e.name, 0, 100);
  put(octal(e.mode ?? (e.type === "dir" ? 0o755 : 0o644), 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("        ", 148, 8); // checksum placeholder: eight spaces
  put(e.type === "dir" ? "5" : e.type === "symlink" ? "2" : "0", 156, 1);
  put(e.linkname ?? "", 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = h.reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function makeTarGz(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? Buffer.from(e.data) : (e.data ?? new Uint8Array());
    const size = e.type === "dir" || e.type === "symlink" ? 0 : data.length;
    chunks.push(header(e, size));
    if (size > 0) {
      chunks.push(data);
      chunks.push(new Uint8Array((512 - (size % 512)) % 512));
    }
  }
  chunks.push(new Uint8Array(1024)); // end-of-archive marker
  return gzipSync(Buffer.concat(chunks));
}
