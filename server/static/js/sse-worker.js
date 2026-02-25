/**
 * SharedWorker that maintains a single SSE (EventSource) connection
 * shared across all browser tabs.  Each tab connects a MessagePort
 * and receives forwarded SSE events.
 *
 * This avoids the HTTP/1.1 per-origin connection limit (~6) being
 * exhausted by multiple tabs each holding their own SSE connection.
 */

/** @type {EventSource|null} */
let source = null;

/** @type {Set<MessagePort>} */
const ports = new Set();

/** Cached state so new tabs get immediate data without a server round-trip */
const cache = {
  /** @type {Record<number, string>} deck number → last JSON string */
  decks: {},
  /** @type {string|null} last transition-pool JSON */
  transitionPool: null,
  /** @type {Record<number, string>} deck number → last visibility JSON */
  visibility: {},
  /** @type {string|null} last analysis-status JSON */
  analysis: null,
  /** @type {Record<string, string>} config key → last JSON string */
  config: {},
  /** @type {string|null} last overlay-updated JSON */
  overlay: null,
};

/** Send a message to all connected ports */
function broadcast(msg) {
  for (const port of ports) {
    port.postMessage(msg);
  }
}

/** Open the SSE connection (called once on first tab) */
function connectSSE() {
  if (source) source.close();
  source = new EventSource("/events");

  source.onopen = () => {
    broadcast({ type: "open" });
  };

  source.onerror = () => {
    broadcast({ type: "error" });
  };

  // Forward named SSE events
  const eventNames = [
    "deck-update",
    "transition-pool",
    "transition-play",
    "deck-visibility",
    "analysis-status",
    "library-updated",
    "config-updated",
    "transitions-updated",
    "overlay-updated",
    "loop-video-transition",
  ];

  for (const name of eventNames) {
    source.addEventListener(name, (e) => {
      // Cache certain events for replay to new tabs
      if (name === "deck-update") {
        try {
          const d = JSON.parse(e.data);
          cache.decks[d.deck] = e.data;
        } catch (_) {}
      } else if (name === "transition-pool") {
        cache.transitionPool = e.data;
      } else if (name === "deck-visibility") {
        try {
          const d = JSON.parse(e.data);
          cache.visibility[d.deck] = e.data;
        } catch (_) {}
      } else if (name === "analysis-status") {
        cache.analysis = e.data;
      } else if (name === "config-updated") {
        try {
          const d = JSON.parse(e.data);
          cache.config[d.key] = e.data;
        } catch (_) {}
      } else if (name === "overlay-updated") {
        cache.overlay = e.data;
      }

      broadcast({ type: "event", name, data: e.data });
    });
  }
}

/** Replay cached state to a single port (on new tab connect) */
function replayTo(port) {
  if (cache.analysis) {
    port.postMessage({ type: "event", name: "analysis-status", data: cache.analysis });
  }
  for (const data of Object.values(cache.visibility)) {
    port.postMessage({ type: "event", name: "deck-visibility", data });
  }
  for (const data of Object.values(cache.decks)) {
    port.postMessage({ type: "event", name: "deck-update", data });
  }
  if (cache.transitionPool) {
    port.postMessage({ type: "event", name: "transition-pool", data: cache.transitionPool });
  }
  for (const data of Object.values(cache.config)) {
    port.postMessage({ type: "event", name: "config-updated", data });
  }
  if (cache.overlay) {
    port.postMessage({ type: "event", name: "overlay-updated", data: cache.overlay });
  }
}

// Handle new tab connections
self.onconnect = (e) => {
  const port = e.ports[0];
  ports.add(port);

  port.onmessage = (msg) => {
    if (msg.data === "close") {
      ports.delete(port);
      // If all tabs closed, shut down the SSE connection
      if (ports.size === 0 && source) {
        source.close();
        source = null;
      }
    }
  };

  // Start SSE on first tab
  if (!source) {
    connectSSE();
  } else {
    // SSE already running — notify the new tab that we're connected
    // and replay cached state
    port.postMessage({ type: "open" });
    replayTo(port);
  }

  port.start();
};
