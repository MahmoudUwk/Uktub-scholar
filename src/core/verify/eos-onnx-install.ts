/**
 * `uktub-scholar eos install`: the pinned Eos ONNX export, a small venv with exactly pinned wheels, and an end-to-end self-check
 * (start the real worker, read its identity, count tokens) before the receipt is written. Process execution and the download
 * transport are injected, so the orchestration is tested offline. A failed install leaves no receipt, so nothing half-done is used;
 * already-verified files are kept, so a retry resumes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError, downloadVerified } from "../embed/runtime.ts";
import { type EosOnnxLock, eosOnnxPaths, installedEosOnnx } from "./eos-onnx.ts";

export type Run = (file: string, args: string[], opts?: { env?: Record<string, string | undefined>; input?: string }) => Promise<{ stdout: string; stderr: string; code: number }>;

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/decision2_onnx.py");

const fileSize = (p: string): number | null => {
  try {
    const s = statSync(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
};
const sha256Of = (p: string): string | null => {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
};
/** Which build the receipt records: true = GPU, false = CPU (a receipt from before builds were recorded counts as CPU). */
const receiptBuild = (receipt: string): boolean => {
  try {
    return (JSON.parse(readFileSync(receipt, "utf8")) as { gpu?: boolean }).gpu === true;
  } catch {
    return false;
  }
};
const tail = (s: string): string => s.replace(/\s+/g, " ").trim().slice(-300);

export async function installEosOnnx(o: { lock: EosOnnxLock; cacheDir: string; fetch: typeof fetch; run: Run; systemPython: string; gpu: boolean }): Promise<{ downloaded: boolean }> {
  const { lock, cacheDir } = o;
  const paths = eosOnnxPaths(lock, cacheDir);
  if (installedEosOnnx(lock, cacheDir) !== null && receiptBuild(paths.receipt) === o.gpu) return { downloaded: false };

  // 1. the interpreter must be new enough, before 700 MB are downloaded
  const probe = await o.run(o.systemPython, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]).catch((err: unknown) => {
    throw new RuntimeError("install_failed", `could not run ${o.systemPython}: ${err instanceof Error ? err.message : String(err)}; install Python ${lock.python.min}+ or set UKTUB_EOS_ONNX_PYTHON to an environment that has onnxruntime, numpy and tokenizers`);
  });
  const [maj = 0, min = 0] = probe.stdout.trim().split(".").map(Number);
  const [needMaj = 0, needMin = 0] = lock.python.min.split(".").map(Number);
  if (maj < needMaj || (maj === needMaj && min < needMin)) {
    throw new RuntimeError("install_failed", `Python ${probe.stdout.trim() || "?"} is too old; the ONNX engine needs Python ${lock.python.min}+`);
  }

  // 2. the model files: each verified against its pinned digest; verified files from an earlier attempt are kept
  mkdirSync(paths.modelDir, { recursive: true });
  let downloaded = false;
  for (const f of lock.model.files) {
    const dest = join(paths.modelDir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    if (fileSize(dest) === f.size && sha256Of(dest) === f.sha256) continue;
    await downloadVerified(o.fetch, f.url, dest, f);
    downloaded = true;
  }

  // 3. the environment: stdlib venv + exactly pinned wheels, never compiled on the user's machine
  if (fileSize(paths.python) === null) {
    const made = await o.run(o.systemPython, ["-m", "venv", paths.venvDir]);
    if (made.code !== 0) throw new RuntimeError("install_failed", `creating the Python environment failed: ${tail(made.stderr || made.stdout)}`);
  }
  const pins = o.gpu ? lock.python.gpu : lock.python.cpu;
  // onnxruntime and onnxruntime-gpu ship the same module: the other build is removed first, or the two overwrite each other
  const other = o.gpu ? "onnxruntime" : "onnxruntime-gpu";
  await o.run(paths.python, ["-m", "pip", "uninstall", "--yes", "--disable-pip-version-check", other]);
  const pip = await o.run(paths.python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--only-binary=:all:", ...pins]);
  if (pip.code !== 0) throw new RuntimeError("install_failed", `pip install failed: ${tail(pip.stderr || pip.stdout)}`);

  // 4. the self-check: the real worker must start on the pinned weights and count tokens
  const weights = lock.model.files.find((f) => f.path === lock.model.weights);
  const check = await o.run(paths.python, [WORKER], {
    env: { UKTUB_DECISION2_ONNX_DIR: paths.modelDir, UKTUB_DECISION2_REVISION: lock.model.revision, UKTUB_DECISION2_ONNX_SHA256: weights?.sha256, UKTUB_DECISION2_DEVICE: o.gpu ? "cuda" : "cpu" },
    input: `${JSON.stringify({ count: true, state: "A passage.", instructions: "A claim." })}\n${JSON.stringify({ exit: true })}\n`,
  });
  const lines = check.stdout.split("\n").filter((l) => l.trim().length > 0).map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  const ready = lines[0] ?? {};
  if (ready.ready !== true || ready.model_sha256 !== weights?.sha256 || ready.revision !== lock.model.revision) {
    throw new RuntimeError("start_failed", `the ONNX worker did not start on the pinned weights: ${tail(check.stderr || JSON.stringify(ready))}`);
  }
  if (typeof lines[1]?.tokens !== "number" || (lines[1].tokens as number) <= 0) {
    throw new RuntimeError("start_failed", `the ONNX worker could not score a row: ${tail(check.stderr || JSON.stringify(lines[1] ?? {}))}`);
  }

  // 5. commit
  writeFileSync(paths.receipt, JSON.stringify({ weights: weights?.sha256, revision: lock.model.revision, gpu: o.gpu }));
  return { downloaded };
}
