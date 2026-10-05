/**
 * How to run THIS copy of the package: the absolute bin of the installed or checked-out files. A bare `uktub-scholar` is on no PATH for a
 * source checkout or a project-local install, so every message, generated config and registered server names this instead.
 */
import { fileURLToPath } from "node:url";

/** Absolute path of bin/uktub-scholar.js (the same relative depth from src/core and from dist/core). */
export const BIN_PATH = fileURLToPath(new URL("../../bin/uktub-scholar.js", import.meta.url));

/** A shell-ready command line for a CLI subcommand of this copy, e.g. `node "/abs/bin/uktub-scholar.js" init`. */
export const cliCommand = (subcommand: string): string => `node "${BIN_PATH}" ${subcommand}`;
