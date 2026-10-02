import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Uktub OA Pi extension. Registers exactly the three v0 tools (U5 wires them);
 * this U1 stub carries only the fail-closed load guard (R14) so the package
 * loads on Pi 1.0 and refuses cleanly on an API-less host.
 */
export default function uktubOaExtension(pi: ExtensionAPI): void {
  if (typeof pi.registerTool !== "function") {
    throw new Error(
      "Refused: PI_EXTENSION_API_UNAVAILABLE — uktub-oa requires Pi 1.0+ exposing pi.registerTool. Next: upgrade Pi to >= 1.0.0.",
    );
  }
}
