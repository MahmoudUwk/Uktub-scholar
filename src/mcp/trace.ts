/**
 * Handshake trace. The SDK answers `initialize` with the revision it supports but keeps neither the one the host asked for nor the one it
 * answered, and which revision each coding agent speaks is exactly what decides whether a host will keep working (the 2026-07-28 revision
 * removes `initialize`). One line per handshake, to a caller-supplied writer; the stdio server sends it to stderr when UKTUB_MCP_TRACE is set.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export function handshakeTraceEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.UKTUB_MCP_TRACE;
  return value !== undefined && value !== "" && !/^(0|false|off)$/i.test(value);
}

interface Wire {
  id?: string | number;
  method?: string;
  params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } };
  result?: { protocolVersion?: unknown };
  error?: { code?: unknown; message?: unknown };
}

/** Call after `server.connect(transport)`: it wraps the transport's inbound handler and `send`, and changes nothing else. */
export function traceHandshake(transport: Transport, write: (line: string) => void): void {
  let initializeId: string | number | undefined;
  let requested = "none";
  let client = "unknown";

  const inbound = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const m = message as Wire;
    if (m.method === "initialize" && m.id !== undefined) {
      initializeId = m.id;
      requested = String(m.params?.protocolVersion ?? "none");
      client = `${String(m.params?.clientInfo?.name ?? "unknown")} ${String(m.params?.clientInfo?.version ?? "")}`.trim();
    }
    inbound?.(message, extra);
  };

  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const m = message as Wire;
    if (initializeId !== undefined && m.id === initializeId && (m.result !== undefined || m.error !== undefined)) {
      const negotiated = m.result !== undefined ? String(m.result.protocolVersion ?? "none") : `error(${String(m.error?.message ?? m.error?.code ?? "unknown")})`;
      write(`uktub-scholar: handshake client=${client} requested=${requested} negotiated=${negotiated}`);
      initializeId = undefined;
    }
    return send(message, options);
  };
}
