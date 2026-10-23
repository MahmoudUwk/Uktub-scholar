/**
 * Pi `write_section` argument handling: the runtime-neutral pieces live in
 * `src/agent/section-tool.ts` (shared with the browser) and the writer
 * lifecycle in `src/agent/section-writer.ts`; this module re-exports them so
 * Pi imports and tests do not change. `parsePapersParam` is the Node-free
 * core parser, re-exported here as before.
 */
export { parsePapersParam } from "../core/verify/papers-param.ts";
export {
  buildRepairPrompt,
  buildWriterPrompt,
  createChildTally,
  runWriteSection,
  stripCodeFences,
} from "../agent/section-writer.ts";
export type {
  ChildStats,
  SectionCounts,
  SectionDeps,
  SectionResult,
  UnitVerdict,
  VerifyPage,
  WriteSectionParams,
} from "../agent/section-writer.ts";
export { coerceSectionArgs, toSectionParams } from "../agent/section-tool.ts";
