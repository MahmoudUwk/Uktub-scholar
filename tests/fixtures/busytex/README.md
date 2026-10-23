# BusyTeX log fixtures (Phase 7)

Genuine BusyTeX 1.4.1 (`texlyre-busytex` 1.4.1, XeTeX driver
`xetex_bibtex8_dvipdfmx`, TeX Live 2026 `texlive-recommended` bundle) logs
captured 2026-10-21 through this repo's own web compile path:

- app: `web/` built from this tree **plus a temporary 10-line
  `window.__uktubLastCompile` observer seam** in
  `web/src/services/LaTeXService.ts` (records `{status, log, hasPdf}` from
  the `CompileResult`; the seam was removed before the phase landed, so the
  shipped build has no test seam in the compile path),
- served with `vite preview` (`/texlyre/`, app origin only),
- guest session, one project per capture run, files written to `/proj` via
  the app's own worker client, page reloaded (bridge re-import), then the
  real **Compile LaTeX (F9)** button clicked,
- capture scripts:
  `/home/mahmoud/.cache/uktub-bench/hermes-web-phase7-2026-10-20/capture-t1.mjs`
  (7 required variants) and `capture-t1b.mjs` (2 extra).

Each `*.log.txt` is the verbatim `CompileResult.log` (BusyTeX `logcat`:
one `$ <cmd> / EXITCODE: <n> / ... LOG: / STDOUT: / STDERR:` block per
pipeline pass, `======` separators; only the last TeX pass log is kept in
full). Each `*.meta.json` records the BusyTeX `status` (exit code) and
whether a PDF came back — including exit-0-with-failure cases the parser
must guard against.

| fixture | status | pdf | what it pins |
|---|---|---|---|
| clean | 0 | yes | bare XeLaTeX doc, no diagnostics (bibtex `I found no ...` lines are benign) |
| undef-macro | 1 | no | `! Undefined control sequence.` + `l.10` |
| missing-input | 1 | no | `! LaTeX Error: File ... not found.` + `! Emergency stop.` + `l.10` |
| undef-cite | 0 | yes | `LaTeX Warning: Citation ... undefined`, `There were undefined references.` |
| missing-bibentry | 0 | yes | bibtex `Warning--I didn't find a database entry`, empty-thebibliography warning |
| bib-syntax | 0 | yes | bibtex `Illegal end of database file---line 6 of file broken.bib` despite exit 0 |
| unknown-package | 3 | no | `! LaTeX Error: File ....sty not found.` early (short log) |
| overfull | 0 | yes | `Overfull \hbox ... in paragraph at lines 9--11` |
| pkg-warn | 0 | yes | `Package fixltx2e Warning: ...` + `(fixltx2e)` continuations |

Source `.tex`/`.bib` bytes per variant are in the capture scripts. The
`registry-bib-seed.txt` capture (empty-registry render of
`refs/references.bib`) is kept with the scripts, not here.
