// An unhandled 'error' on any socket ends the proxy process: Node throws it. On Testbox
// (2026-09-28) a CONNECT client closed while the upstream was still piping into it, the write
// raised EPIPE on a socket with no listener, and the proxy died; Docker restarted it deny-all and
// the workspace lost the network until the policy was pushed again. Every socket the proxy owns
// goes through here: a socket error closes that connection and nothing else.

/**
 * @param {import("node:net").Socket} socket
 * @param {(error: Error) => void} [onError] extra cleanup, e.g. destroying the paired socket
 */
export function guardSocket(socket, onError) {
  socket.on("error", (error) => {
    try {
      onError?.(error);
    } finally {
      socket.destroy();
    }
  });
  return socket;
}
