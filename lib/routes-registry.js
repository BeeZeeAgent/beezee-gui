// Legacy route/ws registry stripped down. Old REST routes and WS handlers
// removed in favor of ccsniff /v1/history/* and the static site/app client.
// Keep as a no-op shim so server.js can still call it.
export function createRegistry(wsRouter, deps) {
  // intentionally empty
}
