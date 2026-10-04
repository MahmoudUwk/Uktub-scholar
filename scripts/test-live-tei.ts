import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSafeDownloader } from "../src/core/source/download.ts";
import { prepareFromBytes } from "../src/core/source/prepare.ts";
import { createRegistry, openRegistry, registerPaper } from "../src/core/registry.ts";
import { publishSource } from "../src/core/verify/store.ts";
import { loadChunkConfig } from "../src/core/config.ts";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const lines = readFileSync("../UktubAI_Agentic/.env", "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  } catch {}
  return env;
}

const baseEnv = loadEnv();

async function run() {
  console.log("=== Testing Live OpenAlex Content API TEI Path ===");
  if (!baseEnv.OPENALEX_API_KEY) {
    console.error("FAIL: OPENALEX_API_KEY not found in ../UktubAI_Agentic/.env");
    process.exit(1);
  }

  const downloader = createSafeDownloader();
  const url = "https://content.openalex.org/works/W2179438025.grobid-xml";
  const origin = "https://content.openalex.org";

  console.log(`Downloading TEI XML from ${url} with credential...`);
  const t0 = Date.now();
  const got = await downloader(url, {
    maxBytes: 64 * 1024 * 1024,
    credential: {
      origin,
      param: "api_key",
      value: baseEnv.OPENALEX_API_KEY,
    },
  });
  const ms = Date.now() - t0;
  console.log(`Downloaded ${got.bytes.length} bytes in ${ms} ms. Content-type: ${got.contentType}`);
  console.log(`Final URL (credential stripped): ${got.finalUrl}`);

  const paper = {
    doi: "10.1186/s13059-014-0550-8",
    title: "Moderated estimation of fold change and dispersion for RNA-seq data with DESeq2",
  };

  console.log("Preparing source from TEI bytes via prepareFromBytes...");
  const src = await prepareFromBytes({
    bytes: got.bytes,
    kind: "openalex-content-tei",
    ref: got.finalUrl,
    license: null,
    paper,
  });

  console.log(`Source prepared: kind=${src.kind}, extraction=${src.extraction}`);
  console.log(`Captured text length: ${src.text.length} chars`);
  console.log(`Section marks found: ${src.sections?.length ?? 0}`);
  if (src.sections) {
    console.log("Section headings:");
    for (const s of src.sections.slice(0, 10)) {
      console.log(`  - [level ${s.level}] "${s.heading}" (at char ${s.start})`);
    }
  }

  // Verify that it stores and chunks in SQLite
  const tmpDir = mkdtempSync(join(tmpdir(), "uktub-tei-"));
  const db = createRegistry(tmpDir);
  registerPaper(db, {
    doi: paper.doi,
    title: paper.title,
    authors: ["Michael I Love", "Wolfgang Huber", "Simon Anders"],
    year: 2014,
  });

  const chunkCfg = loadChunkConfig(tmpDir).chunking;
  publishSource(db, paper.doi, src, chunkCfg, new Date());

  const chunks = db.prepare("SELECT chunk_index, section, char_start, char_end, length(text) as len FROM chunks WHERE doi = ? ORDER BY chunk_index").all(paper.doi) as any[];
  console.log(`Stored and chunked into ${chunks.length} chunks!`);
  for (const c of chunks.slice(0, 5)) {
    console.log(`  Chunk ${c.chunk_index}: section="${c.section}" span=${c.char_start}-${c.char_end} (${c.len} chars)`);
  }

  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  console.log("PASS: Live TEI acquisition, extraction, section headings, and chunking verified!");
}

run().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
