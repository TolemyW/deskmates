// Terminate established private tunnels at grant expiration, including far-future deadlines.
export function expireSocket(socket, expiresAt) {
  let timer;
  const schedule = () => {
    if (socket.destroyed) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      socket.destroy();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2147483647));
    timer.unref();
  };
  socket.once("close", () => clearTimeout(timer));
  schedule();
}
