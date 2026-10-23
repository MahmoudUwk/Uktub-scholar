/**
 * Per-project browser storage naming (Phase 4b).
 *
 * The open project STILL appears at `/proj` inside the worker, so tools,
 * the registry path, `refs/references.bib`, provenance and export/import
 * work unchanged. Only the backing storage is per project: each project
 * gets its own OPFS directory holding its own `opfs-sahpool` pool
 * (one SQLite registry + one project-files store per project, invisible
 * to every other project).
 *
 * Layout (OPFS, per origin):
 *
 *   uktub-projects/<projectId>/   <- this project's SAH pool files
 *
 * Two pools in one origin coexist exactly when their directories differ
 * (`installOpfsSAHPoolVfs` docs: "Using a different directory name for
 * each application enables different engines in the same HTTP origin to
 * co-exist, but their data are invisible to each other"). Two tabs on the
 * SAME project still contend: the project lock (`./lock.ts`) refuses the
 * second tab before any pool is touched.
 *
 * No migration: nothing has been released, so the old single-root pool
 * directory (`/uktub-sahpool`) is simply no longer used. A profile that
 * ran a pre-4b build keeps a stale `/uktub-sahpool` directory in OPFS;
 * it holds no project the new code can open and is never read.
 */

/** OPFS parent directory holding one child directory per project. */
export const PROJECTS_ROOT = "/uktub-projects";

/** Scratch pool for worker scenario ops that run without `init` (tests only). */
export const SCRATCH_POOL_DIR = "/uktub-scratch";
export const SCRATCH_VFS_NAME = "opfs-sahpool-scratch";

/**
 * Project ids that may become an OPFS directory name: 1-128 chars of
 * `[A-Za-z0-9_-]`, starting alphanumeric (no `.`, no `/`, no `..`, no
 * whitespace, no empty string). TeXlyre ids (nanoid) already satisfy this;
 * anything else is refused before it can touch storage or the lock name.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Validate `projectId` before it becomes a directory name (throws, fail closed). */
export function validateProjectId(projectId: unknown): string {
  if (typeof projectId !== "string" || projectId === "") {
    throw new TypeError("init: projectId must be a non-empty string");
  }
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      `refused: invalid projectId ${JSON.stringify(projectId)} ` +
        "(expected 1-128 chars of [A-Za-z0-9_-], starting alphanumeric)",
    );
  }
  return projectId;
}

/** OPFS directory holding this project's SAH pool (multi-level paths are created automatically). */
export function poolDirForProject(projectId: string): string {
  return `${PROJECTS_ROOT}/${validateProjectId(projectId)}`;
}

/**
 * VFS registration name for this project's pool. One name per directory:
 * two pools registered under one name collide, so the name carries the id
 * verbatim (case-sensitive, 1:1 with the directory).
 */
export function vfsNameForProject(projectId: string): string {
  return `opfs-sahpool-${validateProjectId(projectId)}`;
}
