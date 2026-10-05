import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function uktubScholarExtension(pi: ExtensionAPI): void {
  pi.registerMcpServer("uktub-scholar", {
    command: "uktub-scholar",
    args: ["mcp"],
  });
}
