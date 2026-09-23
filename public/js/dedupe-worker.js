import { dedupeInteractiveInput } from "./dedupe.js?v=20260923.1";

let activeRequest = null;

function respond(id, text, options) {
  try {
    self.postMessage({ id, result: dedupeInteractiveInput(text, options) });
  } catch (error) {
    self.postMessage({
      id,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        kind:
          error && typeof error === "object" && typeof error.kind === "string"
            ? error.kind
            : "unknown"
      }
    });
  }
}

self.addEventListener("message", (event) => {
  const { type, id, text, options, chunk, done } = event.data ?? {};

  if (type === "start") {
    activeRequest = { id, options, chunks: [] };
    return;
  }

  if (type === "cancel") {
    if (activeRequest?.id === id) activeRequest = null;
    return;
  }

  if (type === "chunk") {
    if (activeRequest?.id !== id || typeof chunk !== "string") return;
    activeRequest.chunks.push(chunk);
    if (!done) return;
    const request = activeRequest;
    activeRequest = null;
    respond(id, request.chunks.join(""), request.options);
    return;
  }

  respond(id, text, options);
});
