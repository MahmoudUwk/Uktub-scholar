/**
 * claim-verification-v2: how the runner (bench-claims-v2.ts) launches each candidate of the model table, every one on the GPU and every one
 * through the product's `verify_claim` path. A candidate is either a PRODUCT engine configured by its documented environment (Eos, Kai through
 * the `eos` worker's model override, both Vela sizes through the `vela` worker), or an ADAPTER worker injected under a product engine name
 * with a declared identity (Decision 3.0 and d1-omni have no product engine; their resident workers speak the same JSONL protocol). Every
 * revision is the one the earlier reports pinned, and the wording is the Decision 2.0 claim wording of `claim-noul-criteria-v1`.
 *
 * `home` is the bench cache (`~/.cache/uktub-bench`): decision2/{venv,models/{eos,kai}}, vela/{0.3B,0.8B}, d3/{venv,models/*}, d1/models/*,
 * intern/{venv,Intern-Decision-0.8B} (the model's own pinned requirements: its inference.py is the official path, reviewed 2026-10-11),
 * kev/{kev-repo,run} (the author's repository at tag kev-1.0 with its locked environment, and the snapshot with its head repointed at the local
 * base model, every tensor identical; the server is the author's own, reviewed 2026-10-11).
 */
import { join } from "node:path";

export interface EngineSpec {
  /** The product engine name the verification config carries (an adapter runs under a product name too). */
  engine: string;
  /** Environment of a product engine's worker. */
  env: Record<string, string>;
  /** An injected resident worker: the script in scripts/, its interpreter and environment, and the identity declared for the judgment cache. */
  adapter?: { script: string; python: string; env: Record<string, string>; declaredId: string };
  /** The model's own System One server, started for the run and stopped after it; rows are posted over HTTP in the given wording. */
  server?: { cwd: string; command: string[]; env: Record<string, string>; url: string; wording: "criteria" | "native"; declaredId: string };
}

const KAI_REVISION = "cd49ea3813fd8ba0928a9a23ef6c9a0f2f0cd764";
const VELA_03_REVISION = "d6f03aa9baca4f9017fa8f8e9c2764d3bed3f409";
const VELA_08_REVISION = "326b01d81f61fff7fd4ae570e54b87a49119e490";
const D3_EDGE_REVISION = "18d61df78684675463af9ae732872478845c5a79";
const D3_LITE_REVISION = "a8d25a91ef75552803f7009d25b7bd435991abd9";
const D1_REVISION = "02b55d7076f15129e59ab3f94783f32c4b088674";
const INTERN_REVISION = "85a0cc5a99d67ea8d56dfe98115689212867171d";
const KEV_REVISION = "bf75a6a8848ea6960ff2ed108d9ed44c2941174f";
const WORDING = "criteria";

/** The same candidate on the CPU: every device setting of its worker or adapter becomes `cpu`, every dtype setting `float32` (a runtime that hard-codes bfloat16 has no bfloat16 matrix hardware to use on a CPU without it), and a server is blinded to the GPU. The original is untouched. */
export function cpuVariant(spec: EngineSpec): EngineSpec {
  const cpu = (env: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, /_DEVICE$/.test(k) ? "cpu" : /_DTYPE$/.test(k) ? "float32" : v]));
  return {
    ...spec,
    env: cpu(spec.env),
    ...(spec.adapter ? { adapter: { ...spec.adapter, env: cpu(spec.adapter.env) } } : {}),
    ...(spec.server ? { server: { ...spec.server, env: { ...cpu(spec.server.env), CUDA_VISIBLE_DEVICES: "" } } } : {}),
  };
}

export function engineSpecs(home: string): Record<string, EngineSpec> {
  const d2 = join(home, "decision2");
  const d3 = join(home, "d3");
  const eosPython = join(d2, "venv/bin/python");
  const vela = (dir: string, revision: string, weights: string): EngineSpec => ({
    engine: "vela",
    env: { UKTUB_VELA_PYTHON: eosPython, UKTUB_VELA_DIR: join(home, "vela", dir), UKTUB_VELA_REVISION: revision.slice(0, 12), UKTUB_VELA_BACKEND: "torch", UKTUB_VELA_DEVICE: "cuda", UKTUB_VELA_WEIGHTS_FILE: weights },
  });
  const d3Spec = (id: string, revision: string): EngineSpec => ({
    engine: "llama-cpp",
    env: {},
    adapter: {
      script: "d3_decide.py",
      python: join(d3, "venv/bin/python"),
      env: { UKTUB_D3_MODEL: join(d3, "models", id), UKTUB_D3_REVISION: revision, UKTUB_D3_DEVICE: "cuda:0", UKTUB_D3_DTYPE: "bfloat16", UKTUB_D3_PROMPT: WORDING },
      declaredId: `${id}@${revision.slice(0, 12)}:${WORDING}`,
    },
  });
  const kev = (wording: "criteria" | "native"): EngineSpec => ({
    engine: "llama-cpp",
    env: {},
    server: {
      cwd: join(home, "kev/kev-repo"),
      command: ["uv", "run", "--extra", "serve", "python", "-m", "kev.serve", "--run", join(home, "kev/run"), "--port", "8008"],
      env: { CUDA_VISIBLE_DEVICES: "0", HF_HUB_OFFLINE: "1" },
      url: "http://127.0.0.1:8008",
      wording,
      declaredId: `kev-0.8b${wording === "native" ? "-native" : ""}@${KEV_REVISION.slice(0, 12)}:${wording}`,
    },
  });
  return {
    eos: { engine: "eos", env: { UKTUB_EOS_PYTHON: eosPython, UKTUB_EOS_MODEL: join(d2, "models/eos") } },
    kai: { engine: "eos", env: { UKTUB_EOS_PYTHON: eosPython, UKTUB_EOS_MODEL: join(d2, "models/kai"), UKTUB_EOS_REVISION: KAI_REVISION } },
    "vela-0.8b": vela("0.8B", VELA_08_REVISION, "model-00001-of-00001.safetensors"),
    "vela-0.3b": vela("0.3B", VELA_03_REVISION, "model.safetensors"),
    "d3-lite": d3Spec("d3-lite", D3_LITE_REVISION),
    "d3-edge": d3Spec("d3-edge", D3_EDGE_REVISION),
    "d1-omni": {
      engine: "llama-cpp",
      env: {},
      adapter: {
        script: "d1_decide.py",
        python: join(d3, "venv/bin/python"),
        env: { UKTUB_D1_MODEL: join(home, "d1/models/d1-omni-600M"), UKTUB_D1_REVISION: D1_REVISION, UKTUB_D1_DEVICE: "cuda:0", UKTUB_D1_PROMPT: WORDING },
        declaredId: `d1-omni@${D1_REVISION.slice(0, 12)}:${WORDING}`,
      },
    },
    "intern-0.8b": {
      engine: "llama-cpp",
      env: {},
      adapter: {
        script: "intern_decide.py",
        python: join(home, "intern/venv/bin/python"),
        env: { UKTUB_INTERN_MODEL: join(home, "intern/Intern-Decision-0.8B"), UKTUB_INTERN_REVISION: INTERN_REVISION, UKTUB_INTERN_DEVICE: "cuda:0", UKTUB_INTERN_PROMPT: WORDING },
        declaredId: `intern-0.8b@${INTERN_REVISION.slice(0, 12)}:${WORDING}`,
      },
    },
    "kev-0.8b": kev("criteria"),
    "kev-0.8b-native": kev("native"),
    // Eos on CPU is the product's 8-bit ONNX export (pinned by the product's own lock file); the table's CPU gate figure for Eos comes from this spec.
    "eos-onnx": { engine: "eos-onnx", env: {} },
    // The portable 8-bit ONNX artifact of Eos (the file a browser or any ONNX runtime would load) run on the GPU through the product's eos-onnx engine, in the
    // environment that has onnxruntime-gpu; the CUDA libraries are the ones that environment's torch already ships.
    "eos-q8": {
      engine: "eos-onnx",
      env: {
        UKTUB_EOS_ONNX_PYTHON: eosPython,
        LD_LIBRARY_PATH: ["cudnn", "cublas", "cuda_runtime", "cufft", "curand", "cusolver", "cusparse", "cuda_nvrtc", "nvjitlink"].map((l) => join(d2, `venv/lib/python3.12/site-packages/nvidia/${l}/lib`)).join(":"),
        UKTUB_DECISION2_DEVICE: "cuda",
      },
    },
  };
}
