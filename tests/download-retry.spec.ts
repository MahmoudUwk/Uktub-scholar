import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DOWNLOAD_RETRY, RuntimeError, downloadVerified } from "../src/core/embed/runtime.ts";

const BODY = Buffer.from("the pinned bytes ".repeat(20));
const EXPECT = { sha256: createHash("sha256").update(BODY).digest("hex"), size: BODY.length };
let dir: string;
let slept: number[];
const saved = { ...DOWNLOAD_RETRY };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uktub-dl-"));
  slept = [];
  DOWNLOAD_RETRY.sleep = async (ms) => void slept.push(ms);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  Object.assign(DOWNLOAD_RETRY, saved);
});

/** A fetch that plays a script of answers, one per request. */
const scripted = (answers: (number | "network" | "ok" | "wrong-bytes")[]): { fetch: typeof fetch; requests: number } => {
  const state = { requests: 0 };
  const f = (async () => {
    const a = answers[Math.min(state.requests, answers.length - 1)];
    state.requests++;
    if (a === "network") throw new TypeError("fetch failed");
    if (a === "ok") return new Response(BODY as never, { status: 200, headers: { "content-length": String(BODY.length) } });
    if (a === "wrong-bytes") return new Response(Buffer.alloc(BODY.length, 7) as never, { status: 200 });
    return new Response("no", { status: a });
  }) as typeof fetch;
  return { fetch: f, get requests() { return state.requests; } } as never;
};

describe("downloadVerified retries only transient failures", () => {
  it("a 503 then a dropped connection then success: three requests, backoff between them, file verified", async () => {
    const s = scripted([503, "network", "ok"]);
    await downloadVerified(s.fetch, "https://x.test/f", join(dir, "f.bin"), EXPECT);
    assert.equal(s.requests, 3);
    assert.equal(slept.length, 2);
    assert.ok((slept[1] ?? 0) > (slept[0] ?? 0), "backoff grows");
    assert.deepEqual(readFileSync(join(dir, "f.bin")), BODY);
  });

  it("gives up after the bounded attempts with the last cause, leaving no partial file", async () => {
    const s = scripted([503]);
    await assert.rejects(downloadVerified(s.fetch, "https://x.test/f", join(dir, "f.bin"), EXPECT), (e) => e instanceof RuntimeError && e.code === "download_failed" && /503/.test(e.message));
    assert.equal(s.requests, DOWNLOAD_RETRY.delaysMs.length + 1);
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".part")), []);
    assert.equal(existsSync(join(dir, "f.bin")), false);
  });

  it("429 and 408 are transient; 404 and 403 are final (one request)", async () => {
    for (const status of [429, 408]) {
      const s = scripted([status, "ok"]);
      await downloadVerified(s.fetch, "https://x.test/f", join(dir, `${status}.bin`), EXPECT);
      assert.equal(s.requests, 2, String(status));
    }
    for (const status of [404, 403]) {
      const s = scripted([status, "ok"]);
      await assert.rejects(downloadVerified(s.fetch, "https://x.test/f", join(dir, `${status}.bin`), EXPECT), (e) => e instanceof RuntimeError && e.code === "download_failed");
      assert.equal(s.requests, 1, `${status} is not retried`);
    }
  });

  it("wrong bytes are an integrity failure, never retried", async () => {
    const s = scripted(["wrong-bytes", "ok"]);
    await assert.rejects(downloadVerified(s.fetch, "https://x.test/f", join(dir, "f.bin"), EXPECT), (e) => e instanceof RuntimeError && e.code === "checksum_mismatch");
    assert.equal(s.requests, 1);
  });
});
