/**
 * Managed Decision 2.0 Eos on ONNX Runtime (engine `eos-onnx`): the pinned 8-bit export plus a small isolated Python environment
 * (onnxruntime, numpy, tokenizers: about 150 MB, against a 6.7 GB torch + CUDA environment). Installed only on request
 * (`uktub-scholar eos install --yes`); the engine uses an installed copy, or the user's own via `UKTUB_EOS_ONNX_DIR` /
 * `UKTUB_EOS_ONNX_PYTHON`.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { managedCacheDir } from "../embed/config.ts";
import { RuntimeError } from "../embed/runtime.ts";

export interface EosOnnxFile {
  path: string;
  url: string;
  size: number;
  sha256: string;
}
export interface EosOnnxLock {
  schema: 1;
  model: { id: string; revision: string; license: string; variant: string; files: EosOnnxFile[]; weights: string };
  python: { min: string; cpu: string[]; gpu: string[] };
}

const bad = (why: string): never => {
  throw new RuntimeError("invalid_lock", `eos-onnx.lock.json is not valid: ${why}`);
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const text = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" && (o[k] as string).length > 0 ? (o[k] as string) : bad(`${k} must be a non-empty string`));
const strings = (o: Record<string, unknown>, k: string): string[] => (Array.isArray(o[k]) && (o[k] as unknown[]).length > 0 && (o[k] as unknown[]).every((v) => typeof v === "string") ? (o[k] as string[]) : bad(`${k} must be a non-empty list of strings`));

export function validateEosOnnxLock(x: unknown): EosOnnxLock {
  if (!isObj(x) || x.schema !== 1) return bad("schema must be 1");
  const m = isObj(x.model) ? x.model : bad("model missing");
  const revision = text(m, "revision");
  if (!/^[0-9a-f]{40}$/.test(revision)) bad("revision must be a 40-hex commit, never a moving branch");
  const files = (Array.isArray(m.files) ? m.files : bad("model.files missing")).map((raw: unknown): EosOnnxFile => {
    const f = isObj(raw) ? raw : bad("a file entry is not an object");
    const path = text(f, "path");
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) bad(`unsafe file path "${path}"`);
    const url = text(f, "url");
    if (!url.startsWith("https://") || !url.includes(`/${revision}/`)) bad(`${path}: url must be https and pinned to the revision`);
    if (!Number.isSafeInteger(f.size) || (f.size as number) <= 0) bad(`${path}: size must be a positive integer`);
    if (!/^[0-9a-f]{64}$/.test(text(f, "sha256"))) bad(`${path}: sha256 must be 64 lower-case hex characters`);
    return { path, url, size: f.size as number, sha256: f.sha256 as string };
  });
  const weights = text(m, "weights");
  if (!files.some((f) => f.path === weights)) bad("weights must name one of the files");
  const py = isObj(x.python) ? x.python : bad("python missing");
  for (const list of [strings(py, "cpu"), strings(py, "gpu")]) for (const spec of list) if (!/^[A-Za-z0-9_.-]+==\d[\w.]*$/.test(spec)) bad(`"${spec}" must be an exact == pin`);
  return { schema: 1, model: { id: text(m, "id"), revision, license: text(m, "license"), variant: text(m, "variant"), files, weights }, python: { min: text(py, "min"), cpu: strings(py, "cpu"), gpu: strings(py, "gpu") } };
}

export function readEosOnnxLock(): EosOnnxLock {
  return validateEosOnnxLock(JSON.parse(readFileSync(new URL("./eos-onnx.lock.json", import.meta.url), "utf8")));
}

/** Where a managed install lives under the shared cache. */
export function eosOnnxPaths(lock: EosOnnxLock, cacheDir: string): { modelDir: string; venvDir: string; python: string; receipt: string } {
  const modelDir = join(cacheDir, "models", `eos-onnx-${lock.model.revision.slice(0, 12)}`);
  const venvDir = join(cacheDir, "py", `eos-onnx-${lock.model.revision.slice(0, 12)}`);
  const python = process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
  return { modelDir, venvDir, python, receipt: join(modelDir, ".verified") };
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The installed copy (receipt matches the pinned weights digest, files present), or null. Cheap: no hashing. */
export function installedEosOnnx(lock: EosOnnxLock, cacheDir: string): { modelDir: string; python: string } | null {
  const p = eosOnnxPaths(lock, cacheDir);
  const weights = lock.model.files.find((f) => f.path === lock.model.weights);
  try {
    const r = JSON.parse(readFileSync(p.receipt, "utf8")) as { weights?: string; revision?: string };
    if (r.weights !== weights?.sha256 || r.revision !== lock.model.revision) return null;
  } catch {
    return null;
  }
  return lock.model.files.every((f) => isFile(join(p.modelDir, f.path))) && isFile(p.python) ? { modelDir: p.modelDir, python: p.python } : null;
}

/** The env the engine runs with: the user's own settings win; an installed managed copy fills the gaps. */
export function withManagedEosOnnx(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const lock = readEosOnnxLock();
  const have = installedEosOnnx(lock, managedCacheDir(env));
  return {
    ...env,
    ...(env.UKTUB_EOS_ONNX_DIR === undefined && have !== null ? { UKTUB_EOS_ONNX_DIR: have.modelDir } : {}),
    ...(env.UKTUB_EOS_ONNX_PYTHON === undefined && have !== null ? { UKTUB_EOS_ONNX_PYTHON: have.python } : {}),
  };
}
