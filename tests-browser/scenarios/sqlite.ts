/**
 * Differential scenario: node:sqlite surface the core uses.
 *
 * Runs UNCHANGED against the real `node:sqlite` (Node) and against
 * `src/browser/shims/sqlite.ts` (Chromium worker) via the esbuild alias.
 * Returns JSON-safe normalized results; the spec compares Node vs browser
 * with exact equality except bm25 floats (relative tolerance 1e-12).
 */
import { DatabaseSync } from "node:sqlite";
import { norm, step, type Norm } from "./norm.ts";

export function runSqliteScenario(dbPath: string, schemaSql: string): Record<string, Norm> {
  const out: Record<string, Norm> = {};
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  out["location"] = norm(db.location());
  out["isOpen"] = norm(db.isOpen);
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys = ON;");
  db.exec(schemaSql);

  // Row shape, key order, scalar round trips.
  db.exec("CREATE TABLE t(a INTEGER PRIMARY KEY, i INTEGER, r REAL, x TEXT, b BLOB, n TEXT) STRICT;");
  const blob = new Uint8Array([0, 1, 250, 255]);
  out["runRet"] = norm(db.prepare("INSERT INTO t(a,i,r,x,b,n) VALUES(?,?,?,?,?,?)").run(1, -5, 3.25, "héllo", blob, null));
  const row = (db.prepare("SELECT a,i,r,x,b,n FROM t WHERE a=?").get(1) ?? {}) as Record<string, unknown>;
  out["row"] = norm(row);
  out["keyOrder"] = norm(Object.keys(row));
  out["blobTag"] = norm(Object.getPrototypeOf(row["b"])?.constructor?.name);

  // Integers: doubles bind unchecked (node:sqlite never rejects them); the
  // read path range-checks INTEGER-declared columns. 2**53 binds fine on
  // both sides, so the scenario asserts the stored value, not a throw.
  out["bindUnsafeNumber"] = step(() => {
    db.prepare("INSERT INTO t(a,i) VALUES(?,?)").run(2, 2 ** 53 + 2);
    return db.prepare("SELECT i, typeof(i) AS ty FROM t WHERE a=2").get();
  });
  out["bindMaxSafe"] = step(() => db.prepare("INSERT INTO t(a,i) VALUES(?,?)").run(20, 9007199254740991));
  out["bindBigints"] = step(() => {
    db.prepare("INSERT INTO t(a,i) VALUES(?,?)").run(21, 9007199254740992n);
    db.prepare("INSERT INTO t(a,i) VALUES(?,?)").run(22, 9223372036854775807n);
    return db.prepare("SELECT i FROM t WHERE a=20").get();
  });
  db.exec("INSERT INTO t(a,i) VALUES(23, 9223372036854775807)");
  out["readHugeInt"] = step(() => db.prepare("SELECT i FROM t WHERE a=23").get());
  out["readBigint21"] = step(() => db.prepare("SELECT i FROM t WHERE a=21").get());

  // Named parameters, every prefix, with and without the prefix on the key.
  out["namedColon"] = step(() => db.prepare("SELECT :v AS v").get({ v: 7 }));
  out["namedColonPrefix"] = step(() => db.prepare("SELECT :v AS v").get({ ":v": 8 }));
  out["namedAt"] = step(() => db.prepare("SELECT @v AS v").get({ v: 9 }));
  out["namedAtPrefix"] = step(() => db.prepare("SELECT @v AS v").get({ "@v": 10 }));
  out["namedDollar"] = step(() => db.prepare("SELECT $v AS v").get({ v: 11 }));
  out["namedDollarPrefix"] = step(() => db.prepare("SELECT $v AS v").get({ "$v": 12 }));
  out["namedMissing"] = step(() => db.prepare("SELECT :v AS v").get({}));
  out["namedExtra"] = step(() => db.prepare("SELECT :v AS v").get({ v: 1, b: 2 }));
  out["namedOnPositional"] = step(() => db.prepare("SELECT ? AS v").get({ v: 1 }));
  out["positionalOnNamed"] = step(() => db.prepare("SELECT :v AS v").get(7));
  out["tooFew"] = step(() => db.prepare("SELECT ? AS a, ? AS b").get(1));
  out["tooMany"] = step(() => db.prepare("SELECT ? AS a").get(1, 2));
  out["arrayArg"] = step(() => db.prepare("SELECT ? AS a").get([1, 2] as unknown as number));
  out["badBindBool"] = step(() => db.prepare("SELECT ? AS a").get(true as unknown as number));
  out["badBindUndefined"] = step(() => db.prepare("SELECT ? AS a").get(undefined as unknown as number));

  // Statement reuse + misuse shapes.
  const reusable = db.prepare("INSERT INTO t(a) VALUES(?)");
  out["reuse"] = step(() => { reusable.run(30); reusable.run(31); return db.prepare("SELECT COUNT(*) AS n FROM t WHERE a IN (30,31)").get(); });
  out["getOnInsert"] = step(() => db.prepare("INSERT INTO t(a) VALUES(32)").get());
  out["allOnInsert"] = step(() => db.prepare("INSERT INTO t(a) VALUES(33)").all());
  out["returning"] = step(() => db.prepare("INSERT INTO t(a) VALUES(34) RETURNING a").get());
  out["runReturning"] = step(() => db.prepare("INSERT INTO t(a) VALUES(35) RETURNING a").run());
  out["prepareMulti"] = step(() => db.prepare("SELECT 1 AS one; SELECT 2 AS two").get());

  // Constraint-error shapes.
  out["uniqueErr"] = step(() => db.prepare("INSERT INTO t(a) VALUES(?)").run(1));
  out["notNullErr"] = step(() => db.prepare("INSERT INTO papers(doi, citekey, title, authors_json, ingested_at) VALUES(?,?,?,?,?)").run("d-null", "k-null", null, "[]", "2026-01-01"));
  out["fkErr"] = step(() => db.prepare("INSERT INTO paper_sources(doi, status, prepared_at) VALUES(?,?,?)").run("no-such-doi", "ready", "2026-01-01"));
  out["checkErr"] = step(() => db.prepare("INSERT INTO paper_sources(doi, status, prepared_at) VALUES(?,?,?)").run("d2", "bogus", "2026-01-01"));
  out["strictErr"] = step(() => db.prepare("INSERT INTO t(i) VALUES(?)").run("not-an-int"));
  out["syntaxErr"] = step(() => db.prepare("SELCT 1"));
  out["stepErr"] = step(() => db.prepare("SELECT * FROM no_such_table").all());

  // PRAGMAs.
  out["userVersion"] = norm(db.prepare("PRAGMA user_version").get());
  db.exec("PRAGMA user_version = 42");
  out["userVersion42"] = norm(db.prepare("PRAGMA user_version").get());
  db.exec("PRAGMA user_version = 5");
  out["journalMode"] = norm(db.prepare("PRAGMA journal_mode").get());
  out["foreignKeys"] = norm(db.prepare("PRAGMA foreign_keys").get());
  out["tableInfo"] = norm(db.prepare("PRAGMA table_info(papers)").all().map((c) => (c as { name: string }).name));

  // Registry-like flow: upsert, generation, FTS5 + bm25, triggers.
  out["upsert"] = step(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO papers(doi,citekey,title,authors_json,year,venue,ingested_at) VALUES(?,?,?,?,?,?,?)")
        .run("10.1/abc", "doe2026", "On Cats", '["Doe"]', 2026, "J", "2026-01-01T00:00:00Z");
      db.prepare("INSERT INTO paper_sources(doi,status,kind,digest,revision,text,prepared_at) VALUES(?,?,?,?,?,?,?)")
        .run("10.1/abc", "ready", "arxiv-pdf", "d", "r1", "the cat sat on the mat with another cat", "2026-01-01T00:00:00Z");
      db.prepare("INSERT INTO chunks(doi,chunk_index,chunk_id,revision,char_start,char_end,est_tokens,content_hash,text) VALUES(?,?,?,?,?,?,?,?,?)")
        .run("10.1/abc", 0, "c1", "r1", 0, 20, 10, "h1", "the cat sat on the mat");
      db.prepare("INSERT INTO chunks(doi,chunk_index,chunk_id,revision,char_start,char_end,est_tokens,content_hash,text) VALUES(?,?,?,?,?,?,?,?,?)")
        .run("10.1/abc", 1, "c2", "r1", 21, 40, 10, "h2", "a dog barked loudly at night");
      db.prepare("UPDATE registry_state SET generation = generation + 1 WHERE id = 1").run();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return {
      gen: db.prepare("SELECT generation FROM registry_state WHERE id = 1").get(),
      rank: db.prepare("SELECT c.chunk_id AS chunk_id, bm25(chunk_fts) AS r FROM chunk_fts JOIN chunks c ON c.rowid = chunk_fts.rowid WHERE chunk_fts MATCH ? ORDER BY r").all("cat"),
      like: db.prepare("SELECT chunk_id FROM chunks WHERE text LIKE ? ORDER BY chunk_id").all("%dog%"),
    };
  });

  // Rollback leaves no partial rows.
  out["rollback"] = step(() => {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO t(a) VALUES(?)").run(300);
    db.exec("ROLLBACK");
    return db.prepare("SELECT COUNT(*) AS n FROM t WHERE a=300").get();
  });

  // Special values.
  out["nanInf"] = step(() => {
    db.prepare("INSERT INTO t(a,r) VALUES(?,?)").run(400, Number.NaN);
    db.prepare("INSERT INTO t(a,r) VALUES(?,?)").run(401, Number.POSITIVE_INFINITY);
    return db.prepare("SELECT a, r FROM t WHERE a IN (400,401) ORDER BY a").all();
  });
  out["emptyBlob"] = step(() => {
    db.prepare("INSERT INTO t(a,b) VALUES(?,?)").run(402, new Uint8Array(0));
    return db.prepare("SELECT b FROM t WHERE a=402").get();
  });
  out["emptyVsNull"] = step(() => {
    db.prepare("INSERT INTO t(a,x,n) VALUES(?,?,?)").run(403, "", null);
    return db.prepare("SELECT x, n FROM t WHERE a=403").get();
  });

  // exec shapes: multi-statement, partial failure, return value.
  out["execRet"] = norm(db.exec("CREATE TABLE e1(x); CREATE TABLE e2(y);"));
  out["execPartial"] = step(() => db.exec("INSERT INTO t(a) VALUES(500); THIS IS NOT SQL;"));
  out["execPartialRow"] = norm(db.prepare("SELECT COUNT(*) AS n FROM t WHERE a=500").get());

  // Second open of the same file in the same worker.
  out["secondOpen"] = step(() => {
    const db2 = new DatabaseSync(dbPath);
    try {
      return { count: (db2.prepare("SELECT COUNT(*) AS n FROM t").get() as unknown as { n: number }).n, loc: db2.location(), open: db2.isOpen };
    } finally {
      db2.close();
    }
  });

  // Close semantics.
  db.close();
  out["isOpenAfterClose"] = norm(db.isOpen);
  out["closeTwice"] = step(() => db.close());
  out["useAfterClose"] = step(() => db.prepare("SELECT 1"));
  out["locationAfterClose"] = step(() => db.location());
  return out;
}
