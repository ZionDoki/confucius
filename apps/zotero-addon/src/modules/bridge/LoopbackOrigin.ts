/** Use the listener of this Zotero profile, including non-default development ports. */
export function zoteroLoopbackOrigin(): string {
  const port = (Zotero as unknown as { Server?: { port?: number } }).Server
    ?.port;
  if (!Number.isInteger(port) || port! < 1 || port! > 65535)
    throw new Error(
      "Zotero HTTP server is not listening; Confucius tools are unavailable",
    );
  return `http://127.0.0.1:${port}`;
}
