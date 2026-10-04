import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paperRegistryTool } from "../src/core/tools/registry.ts";
import { createRegistry, openRegistry } from "../src/core/registry.ts";
import { WriteQueue } from "../src/core/queue.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { getSource, resolvePointer } from "../src/core/verify/store.ts";
import { acquireSource } from "../src/core/source/prepare.ts";
import { createSafeDownloader } from "../src/core/source/download.ts";
import { providerConfigOf } from "../src/core/tools/context.ts";

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

function makeContext(root: string, extraEnv: Record<string, string> = {}): ToolContext {
  return {
    root,
    fetch: fetch as unknown as ToolContext["fetch"],
    env: { ...baseEnv, ...extraEnv },
    now: () => new Date(),
    queue: new WriteQueue(),
  };
}

async function run() {
  console.log("=== Item 3: Registration and sources, real ===");
  const testDir = mkdtempSync(join(tmpdir(), "uktub-item3-"));
  console.log(`Created disposable project directory: ${testDir}`);

  try {
    // 1. Initialize registry
    const db = createRegistry(testDir);
    db.close();

    const ctx = makeContext(testDir);

    // 2. Register real DOIs and arXiv ids
    console.log("\n--- Step 2: Register real DOIs and arXiv IDs ---");
    const regRes = await paperRegistryTool(ctx, {
      action: "register",
      identifiers: [
        "10.1038/s41586-020-2649-2", // AlphaFold2 nature paper
        "arxiv:2411.09996",           // arXiv ID
        "https://doi.org/10.1038/s41586-020-2649-2", // Duplicate alias
      ],
    });
    console.log("Registration text output:\n" + regRes.content[0].text);
    const regStruct = regRes.structuredContent as any;
    console.log("Outcomes:", regStruct.outcomes.map((o: any) => ({ input: o.input, status: o.status, doi: o.doi, citekey: o.citekey, citable: o.citable })));

    // 3. Refuse bad ones
    console.log("\n--- Step 3: Refuse bad identifiers ---");
    const badRes = await paperRegistryTool(ctx, {
      action: "register",
      identifiers: [
        "not-a-doi-at-all",
        "10.9999/does-not-exist-at-all-12345",
      ],
    });
    console.log("Bad identifiers outcomes:", (badRes.structuredContent as any).outcomes);

    // 4. Path escape check
    console.log("\n--- Step 4: Path escape check ---");
    const escapeRes = await paperRegistryTool(ctx, {
      action: "attach_source",
      attachments: [
        { handle: "10.1038/s41586-020-2649-2", path: "../../etc/passwd" },
        { handle: "10.1038/s41586-020-2649-2", path: "/etc/passwd" },
      ],
    });
    console.log("Path escape result:\n" + escapeRes.content[0].text);

    // 5. Attach the 14 real PDFs
    console.log("\n--- Step 5: Attach all 14 real PDFs ---");
    const pdfDir = join(testDir, "papers");
    mkdirSync(pdfDir, { recursive: true });

    // The 14 PDFs from ../test_papers
    const pdfFiles = [
      { sub: "RF", name: "2411.09996v1.pdf" },
      { sub: "RF", name: "2504.14100v1.pdf" },
      { sub: "RF", name: "2506.06718v2.pdf" },
      { sub: "RF", name: "2509.03077v1.pdf" },
      { sub: "RF", name: "2511.15162v1.pdf" },
      { sub: "RF", name: "2606.06373v1.pdf" },
      { sub: "RF", name: "2609.04707v1.pdf" },
      { sub: "RF", name: "Papaers_overview.pdf" },
      { sub: "RF", name: "Tiny_Federated_Wireless_Foundation_Models_for_Resource-Constrained_Devices.pdf" },
      { sub: "smarthome", name: "https_www.mdpi.com_2071-1050_14_21_14556_pdf_version_1667899365.pdf" },
      { sub: "smarthome", name: "https_www.mdpi.com_2079-9292_12_19_4041_pdf_version_1695710542.pdf" },
      { sub: "smarthome", name: "https_www.mdpi.com_2079-9292_12_21_4453_pdf_version_1698575946.pdf" },
      { sub: "smarthome", name: "https_www.mdpi.com_2624-6511_5_3_53_pdf_version_1662702520.pdf" },
      { sub: "smarthome", name: "http_thesai.org_Downloads_Volume12No2_Paper_90-Smart_Home_Energy_Management_System.pdf" },
    ];

    // Read claims.json to get matching paper metadata / titles
    const claimsData = JSON.parse(readFileSync("benchmarks/datasets/claim-verification-v1/claims.json", "utf8"));
    const claims = claimsData.claims;

    // For each PDF, copy into project and register paper
    const registeredDois: { doi: string; path: string; title: string }[] = [];
    const openDb = openRegistry(testDir);

    for (let i = 0; i < pdfFiles.length; i++) {
      const p = pdfFiles[i];
      const srcPath = join("../test_papers", p.sub, p.name);
      const destRel = `papers/${p.name}`;
      const destPath = join(testDir, destRel);
      copyFileSync(srcPath, destPath);

      // Determine paper handle/title
      const baseName = p.name.replace(/\.pdf$/, "");
      // find a claim referencing this paper
      const claim = claims.find((c: any) => baseName.startsWith(c.paper) || c.paper.startsWith(baseName.slice(0, 30)));
      const doi = `10.5555/test.paper.${i + 1}`;
      
      // Let's extract PDF text briefly to find its title for identity attestation
      const bytes = readFileSync(destPath);
      const { extractPdf } = await import("../src/core/source/extract.ts");
      const ext = await extractPdf(bytes);
      // Title from first line or text
      const firstLines = ext.text.trim().split("\n").filter((l: string) => l.trim().length > 5);
      const title = firstLines[0] || baseName;

      const { registerPaper } = await import("../src/core/registry.ts");
      registerPaper(openDb, {
        doi,
        title,
        authors: ["Test Author"],
        year: 2024,
      });

      registeredDois.push({ doi, path: destRel, title });
    }
    openDb.close();

    console.log(`Registered ${registeredDois.length} papers in registry. Now attaching sources...`);

    // Attach them in batches (ATTACH_BATCH_MAX is 10)
    for (let i = 0; i < registeredDois.length; i += 10) {
      const batch = registeredDois.slice(i, i + 10).map((r) => ({ handle: r.doi, path: r.path }));
      const attachRes = await paperRegistryTool(ctx, {
        action: "attach_source",
        attachments: batch,
      });
      console.log(`Attached batch ${i / 10 + 1}:\n` + attachRes.content[0].text);
    }

    // Verify all 14 have sources in db
    const verifyDb = openRegistry(testDir);
    let readyCount = 0;
    for (const r of registeredDois) {
      const s = getSource(verifyDb, r.doi);
      if (s !== null) readyCount++;
    }
    console.log(`Total sources successfully attached in database: ${readyCount} / ${registeredDois.length}`);

    // 6. Attach a wrong PDF: must be refused identity_mismatch, old source kept
    console.log("\n--- Step 6: Attach wrong PDF (identity mismatch) ---");
    const targetPaper = registeredDois[0];
    const wrongPdfPath = registeredDois[1].path;
    const oldSourceBefore = getSource(verifyDb, targetPaper.doi);

    const wrongAttachRes = await paperRegistryTool(ctx, {
      action: "attach_source",
      attachments: [{ handle: targetPaper.doi, path: wrongPdfPath }],
    });
    console.log("Wrong attach result:\n" + wrongAttachRes.content[0].text);

    const oldSourceAfter = getSource(verifyDb, targetPaper.doi);
    const sourceKept = oldSourceBefore?.revision === oldSourceAfter?.revision;
    console.log(`Original source kept? ${sourceKept} (revision: ${oldSourceAfter?.revision})`);
    verifyDb.close();

    // 7. OA acquisition without a key (expect no_open_copy)
    console.log("\n--- Step 7: OA acquisition without key ---");
    // Register a paper with landing page only (e.g. PeerJ 10.7717/peerj.4375 or similar)
    const ctxNoKey = makeContext(testDir, { OPENALEX_API_KEY: "" });
    const noKeyDoi = "10.7717/peerj.4375";
    const regNoKey = await paperRegistryTool(ctxNoKey, {
      action: "register",
      identifiers: [noKeyDoi],
    });
    console.log("Registered PeerJ paper:", regNoKey.content[0].text);

    const dbAcq = openRegistry(testDir);
    const { resolveHandle } = await import("../src/core/registry.ts");
    const downloader = createSafeDownloader();
    const paperRec = resolveHandle(dbAcq, noKeyDoi)!;
    const acqResNoKey = await acquireSource(
      { fetch: fetch as unknown as ToolContext["fetch"], download: downloader, cfg: providerConfigOf(ctxNoKey) },
      { doi: paperRec.doi, title: paperRec.title },
    );
    console.log("Acquire without key result:", acqResNoKey);
    dbAcq.close();

    // 8. Content API TEI path with key
    console.log("\n--- Step 8: Content API TEI path with key ---");
    const teiDoi = "10.1186/s13059-014-0550-8"; // DESeq2 paper on OpenAlex Content API (grobid-xml)
    const regTei = await paperRegistryTool(ctx, {
      action: "register",
      identifiers: [teiDoi],
    });
    console.log("Registered TEI paper:", regTei.content[0].text);

    const dbTei = openRegistry(testDir);
    const paperTei = resolveHandle(dbTei, teiDoi)!;
    console.log("Attempting live TEI acquisition with OPENALEX_API_KEY (spending ~$0.01)...");
    const tAcq0 = Date.now();
    const acqTeiRes = await acquireSource(
      { fetch: fetch as unknown as ToolContext["fetch"], download: downloader, cfg: providerConfigOf(ctx) },
      { doi: paperTei.doi, title: paperTei.title },
    );
    const acqMs = Date.now() - tAcq0;
    console.log(`Acquisition finished in ${acqMs}ms. ok=${acqTeiRes.ok}`);

    if (acqTeiRes.ok) {
      const src = acqTeiRes.source;
      console.log(`Source kind: ${src.kind}, ref: ${src.ref}`);
      console.log(`Extracted text length: ${src.text.length} chars`);
      console.log(`Extraction identity: ${src.extraction}`);
      console.log(`Sections count: ${src.sections?.length ?? 0}`);
      if (src.sections && src.sections.length > 0) {
        console.log("First 5 section headings from TEI <head> tags:");
        for (const s of src.sections.slice(0, 5)) {
          console.log(`  - [level ${s.level}] "${s.heading}" (at char ${s.start})`);
        }
      }

      // Publish source to registry and verify chunking
      const { publishSource } = await import("../src/core/verify/store.ts");
      const { loadChunkConfig } = await import("../src/core/config.ts");
      const chunkCfg = loadChunkConfig(testDir).chunking;
      publishSource(dbTei, teiDoi, src, chunkCfg, new Date());

      const chunks = (dbTei.prepare("SELECT chunk_index, section, char_start, char_end, text FROM chunks WHERE doi = ?").all(teiDoi) as any[]);
      console.log(`Generated ${chunks.length} chunks for TEI source.`);
      console.log("First 3 chunks:");
      for (const c of chunks.slice(0, 3)) {
        console.log(`  Chunk ${c.chunk_index}: section="${c.section}" span=${c.char_start}-${c.char_end} (${c.text.length} chars)`);
      }
    } else {
      console.error("TEI acquisition failed:", acqTeiRes);
    }
    dbTei.close();

    console.log("\n=== Item 3 complete! ===");
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    console.log(`Cleaned up temporary project directory: ${testDir}`);
  }
}

run().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
