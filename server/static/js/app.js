/**
 * VDJ Video Sync – Client-side application
 *
 * Handles:
 *  - SSE connection to /events for real-time deck updates (singleton, persists across SPA nav)
 *  - SPA navigation between Dashboard and Library pages
 *  - Dashboard: deck status cards
 *  - Library: video library browser
 *  - Settings: modal for directory configuration (gear icon)
 *  - Player: video element control synced to the master deck (separate page)
 */

// ─── Timestamp helper for console logs ──────────────────
/** Returns an HH:MM:SS.mmm timestamp string for console log prefixing. */
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

// ─── Video decode performance monitor ───────────────────

let perfMonitorInterval = null;
function startPerfMonitor() {
  if (perfMonitorInterval) return;
  perfMonitorInterval = setInterval(() => {
    document.querySelectorAll('video').forEach((v, i) => {
      if (v.paused || v.readyState < 2) return;
      const id = v.id || v.className || `video-${i}`;
      const quality = v.getVideoPlaybackQuality?.();
      if (quality) {
        const dropped = quality.droppedVideoFrames;
        const total = quality.totalVideoFrames;
        const pct = total > 0 ? ((dropped / total) * 100).toFixed(1) : '0.0';
        if (dropped > 0) {
          console.log(ts(), `[perf] ${id}: ${dropped}/${total} frames dropped (${pct}%) ${v.videoWidth}x${v.videoHeight} rate=${v.playbackRate.toFixed(2)}`);
        }
      }
      if (v.readyState < 4 && !v.paused) {
        console.log(ts(), `[perf] ${id}: buffering (readyState=${v.readyState}) ${v.videoWidth}x${v.videoHeight}`);
      }
    });
  }, 3000);
}
function stopPerfMonitor() {
  if (perfMonitorInterval) { clearInterval(perfMonitorInterval); perfMonitorInterval = null; }
}
startPerfMonitor();
window.vdjPerf = {
  start: startPerfMonitor,
  stop: stopPerfMonitor,
  snapshot: () => {
    document.querySelectorAll('video').forEach((v, i) => {
      const id = v.id || v.className || `video-${i}`;
      const quality = v.getVideoPlaybackQuality?.();
      const buffered = v.buffered.length > 0
        ? `${v.buffered.start(0).toFixed(1)}-${v.buffered.end(0).toFixed(1)}s`
        : 'none';
      console.log(ts(), `[perf] ${id}: ${v.videoWidth}x${v.videoHeight} readyState=${v.readyState} rate=${v.playbackRate.toFixed(2)} buffered=${buffered} dropped=${quality?.droppedVideoFrames ?? '?'}/${quality?.totalVideoFrames ?? '?'} paused=${v.paused}`);
    });
  },
};

// ─── SSE Connection Status Indicator ────────────────────

function updateSSEStatus(connected) {
  const el = document.getElementById("sse-status");
  const text = document.getElementById("sse-status-text");
  const spinner = document.getElementById("sse-spinner");
  if (!el || !text || !spinner) return;
  if (connected) {
    el.className = "ml-2 flex items-center gap-1 text-xs font-medium text-green-400";
    spinner.classList.add("hidden");
    text.textContent = "CONNECTED";
  } else {
    el.className = "ml-2 flex items-center gap-1 text-xs font-medium text-yellow-400";
    spinner.classList.remove("hidden");
    text.textContent = "RECONNECTING...";
  }
}

// ─── Configurable transition settings (synced via SSE + BroadcastChannel) ──
let transitionDurationMs = 3000;
let transitionsEnabled = true;

// BroadcastChannel for reliable cross-tab config sync within the same browser.
// SharedWorker port broadcast may not reach tabs in different browsing context
// groups (e.g. target="_blank" with implicit noopener).
const configBC = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("vdj-config") : null;

// ─── SSE Connection (Singleton) ─────────────────────────

class DeckSSE {
  constructor() {
    /** @type {SharedWorker|null} */
    this.worker = null;
    /** @type {EventSource|null} - fallback when SharedWorker unavailable */
    this.source = null;
    /** @type {Record<number, object>} */
    this.decks = {};
    /** @type {((data: object) => void)[]} */
    this.listeners = [];
    /** @type {((data: object) => void)[]} */
    this.transitionPoolListeners = [];
    /** @type {((data: object) => void)[]} */
    this.transitionPlayListeners = [];
    /** @type {((data: object) => void)[]} */
    this.visibilityListeners = [];
    /** @type {((data: object) => void)[]} */
    this.libraryListeners = [];
    /** @type {((data: object) => void)[]} */
    this.configListeners = [];
    /** Last transition-pool event data (for replay on late subscribers) */
    this.lastTransitionPool = null;
    /** Cached deck visibility states (for replay on late subscribers) @type {Record<number, object>} */
    this.deckVisibility = {};
    /** Whether SSE is currently connected */
    this.connected = false;
    this.connect();
  }

  /** Dispatch a received SSE event by name + raw JSON data string */
  _dispatch(name, rawData) {
    try {
      const data = JSON.parse(rawData);
      switch (name) {
        case "deck-update":
          this.decks[data.deck] = data;
          this.listeners.forEach((fn) => fn(data));
          break;
        case "transition-pool":
          this.lastTransitionPool = data;
          this.transitionPoolListeners.forEach((fn) => fn(data));
          break;
        case "transition-play":
          this.transitionPlayListeners.forEach((fn) => fn(data));
          break;
        case "deck-visibility":
          this.deckVisibility[data.deck] = data;
          this.visibilityListeners.forEach((fn) => fn(data));
          break;
        case "analysis-status": {
          const overlay = document.getElementById("analysis-overlay");
          if (!overlay) return;
          if (data.status === "running") {
            overlay.classList.remove("hidden");
          } else {
            overlay.classList.add("hidden");
          }
          break;
        }
        case "library-updated":
          this.libraryListeners.forEach((fn) => fn(data));
          break;
        case "config-updated":
          this.configListeners.forEach((fn) => fn(data));
          break;
      }
    } catch (err) {
      console.error(ts(), `[sse] ${name} parse error:`, err);
    }
  }

  connect() {
    // Use SharedWorker so all tabs share a single SSE connection,
    // avoiding the HTTP/1.1 per-origin 6-connection limit.
    if (typeof SharedWorker !== "undefined") {
      // Version string forces the browser to replace a stale SharedWorker
      // when the worker script changes.  Bump on every worker code change.
      this.worker = new SharedWorker("/static/js/sse-worker.js?v=2");
      this.worker.port.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "open") {
          console.log(ts(), "[sse] connected (shared)");
          this.connected = true;
          updateSSEStatus(true);
        } else if (msg.type === "error") {
          console.warn(ts(), "[sse] connection lost, reconnecting...");
          this.connected = false;
          updateSSEStatus(false);
        } else if (msg.type === "event") {
          this._dispatch(msg.name, msg.data);
        }
      };
      this.worker.port.start();

      // Tell worker to drop our port on unload (so it can close SSE
      // when all tabs are gone, and so navigation/F5 doesn't hang).
      window.addEventListener("beforeunload", () => {
        this.worker.port.postMessage("close");
      });
      return;
    }

    // Fallback: direct EventSource (Safari < 16 or other edge cases)
    this.source = new EventSource("/events");
    this.source.onopen = () => {
      console.log(ts(), "[sse] connected");
      this.connected = true;
      updateSSEStatus(true);
    };

    // Close SSE before page unload so the browser doesn't wait for
    // the long-lived connection to finish (which causes F5 to hang).
    window.addEventListener("beforeunload", () => {
      if (this.source) this.source.close();
    });

    const events = [
      "deck-update", "transition-pool", "transition-play",
      "deck-visibility", "analysis-status", "library-updated",
      "config-updated",
    ];
    for (const name of events) {
      this.source.addEventListener(name, (e) => this._dispatch(name, e.data));
    }
    this.source.onerror = () => {
      console.warn(ts(), "[sse] connection lost, reconnecting...");
      this.connected = false;
      updateSSEStatus(false);
    };
  }

  /** @param {(data: object) => void} fn */
  onUpdate(fn) {
    this.listeners.push(fn);
  }

  /** Remove a previously registered listener */
  offUpdate(fn) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  /** @param {(data: object) => void} fn */
  onTransitionPool(fn) {
    this.transitionPoolListeners.push(fn);
  }

  /** Remove a previously registered transition-pool listener */
  offTransitionPool(fn) {
    this.transitionPoolListeners = this.transitionPoolListeners.filter((f) => f !== fn);
  }

  /** @param {(data: object) => void} fn */
  onTransitionPlay(fn) {
    this.transitionPlayListeners.push(fn);
  }

  /** Remove a previously registered transition-play listener */
  offTransitionPlay(fn) {
    this.transitionPlayListeners = this.transitionPlayListeners.filter((f) => f !== fn);
  }

  /** @param {(data: object) => void} fn */
  onVisibility(fn) {
    this.visibilityListeners.push(fn);
  }

  /** Remove a previously registered visibility listener */
  offVisibility(fn) {
    this.visibilityListeners = this.visibilityListeners.filter((f) => f !== fn);
  }

  /** @param {(data: object) => void} fn */
  onLibraryUpdated(fn) {
    this.libraryListeners.push(fn);
  }

  /** Remove a previously registered library-updated listener */
  offLibraryUpdated(fn) {
    this.libraryListeners = this.libraryListeners.filter((f) => f !== fn);
  }

  /** @param {(data: object) => void} fn */
  onConfig(fn) {
    this.configListeners.push(fn);
  }

  /** Remove a previously registered config-updated listener */
  offConfig(fn) {
    this.configListeners = this.configListeners.filter((f) => f !== fn);
  }
}

/** Global SSE instance – shared across SPA pages, never recreated */
let globalSSE = null;

function getSSE() {
  if (!globalSSE) {
    globalSSE = new DeckSSE();
  }
  return globalSSE;
}

// ─── SPA Navigation ─────────────────────────────────────

/** Cleanup function for the current page (if any) */
let currentPageCleanup = null;

/**
 * Navigate to a new SPA page without a full reload.
 * Fetches the page with X-SPA header → server returns only the <main> partial.
 * Swaps #spa-content and re-initialises page-specific JS.
 */
async function spaNavigate(url, pushState = true) {
  try {
    // Free video connections before fetching the new page.
    // Browsers limit concurrent HTTP/1.1 connections per origin (6 in Chrome).
    // Dashboard deck-card videos + embedded player videos + SSE + transition
    // preload can exhaust this limit, causing the SPA fetch to queue.
    if (currentPageCleanup) {
      currentPageCleanup();
      currentPageCleanup = null;
    }

    const resp = await fetch(url, { headers: { "X-SPA": "1" } });
    if (!resp.ok) return;
    const html = await resp.text();

    // Parse the response and extract the new #spa-content
    const doc = new DOMParser().parseFromString(html, "text/html");
    const newContent = doc.getElementById("spa-content");
    if (!newContent) {
      // Fallback: full page load
      window.location.href = url;
      return;
    }

    // Swap content
    const oldContent = document.getElementById("spa-content");
    if (oldContent) {
      oldContent.replaceWith(newContent);
    }

    // Update active nav link styling
    updateNavActive(url);

    // Update browser history
    if (pushState) {
      history.pushState({ spaUrl: url }, "", url);
    }

    // Update page title
    const titleEl = doc.querySelector("title");
    if (titleEl) document.title = titleEl.textContent;

    // Init the new page
    initCurrentPage();
  } catch (err) {
    console.error(ts(), "[spa] navigation error:", err);
    window.location.href = url;
  }
}

/** Update nav link active states based on the current URL */
function updateNavActive(url) {
  const path = new URL(url, window.location.origin).pathname;
  document.querySelectorAll("[data-spa-link]").forEach((link) => {
    const linkPath = new URL(link.href, window.location.origin).pathname;
    const isActive = linkPath === path;
    link.classList.toggle("bg-gray-800", isActive);
    link.classList.toggle("text-white", isActive);
    link.classList.toggle("text-gray-300", !isActive);
    link.classList.toggle("hover:bg-gray-700", !isActive);
    link.classList.toggle("hover:text-white", !isActive);
  });
}

/** Attach click handlers to all SPA navigation links */
function bindSpaLinks() {
  document.querySelectorAll("[data-spa-link]").forEach((link) => {
    // Skip if already bound
    if (link.dataset.spaBound) return;
    link.dataset.spaBound = "1";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      spaNavigate(link.href);
    });
  });
}

// Handle browser back/forward
window.addEventListener("popstate", (e) => {
  if (e.state && e.state.spaUrl) {
    spaNavigate(e.state.spaUrl, false);
  }
});

// ─── Constants ──────────────────────────────────────────

/** Maximum supported decks */
const MAX_DECKS = 4;

/** Human-readable labels for video match levels (0-5) */
const MATCH_LABELS = {
  0: "Exact",
  1: "Stem",
  2: "Fuzzy",
  3: "BPM + Fuzzy",
  4: "BPM",
  5: "Random",
};

// ─── Dashboard Logic ────────────────────────────────────

function initDashboard() {
  const sse = getSSE();

  /** Track which extra decks (> 4) are currently playing — used for warning banner */
  const extraDecksPlaying = new Set();

  /** Per-deck video paths (display tracking only — actual playback is in the embedded player) */
  const deckPaths = {};

  /** Recalculate flex-basis on all non-exiting deck columns so they share space equally */
  function updateDeckLayout() {
    const container = document.getElementById("deck-status");
    if (!container) return;
    const cols = container.querySelectorAll('[data-deck-col]:not(.deck-exiting)');
    const count = cols.length;
    if (count === 0) return;
    const basis = `${100 / count}%`;
    cols.forEach(c => { c.style.flexBasis = basis; });
    updateVideoWidths();
  }

  /** Set per-deck video width to always be container / 4, regardless of visible deck count.
   *  Reduced by 5% to prevent right-edge clipping from padding/borders. */
  function updateVideoWidths() {
    const container = document.getElementById("deck-status");
    if (!container) return;
    const w = Math.floor(container.offsetWidth / MAX_DECKS * 0.95);
    container.querySelectorAll('.deck-video-wrap').forEach(el => {
      el.style.width = `${w}px`;
    });
  }

  // Recompute video widths on window resize
  const onResize = () => updateVideoWidths();
  window.addEventListener('resize', onResize);

  /** Ensure a deck column (card + video) exists in the DOM */
  function ensureDeckCard(deck) {
    if (deck > MAX_DECKS) return;
    const existing = document.querySelector(`[data-deck-col="${deck}"]`);
    if (existing) {
      if (existing.classList.contains("deck-exiting")) {
        existing.classList.remove("deck-exiting");
        existing.style.opacity = '1';
        updateDeckLayout();
      }
      return;
    }

    const container = document.getElementById("deck-status");
    if (!container) return;

    const col = document.createElement("div");
    col.dataset.deckCol = String(deck);
    col.className = "min-w-0 overflow-hidden";
    col.innerHTML = `
      <div id="deck-${deck}" data-deck="${deck}" class="rounded-lg bg-gray-900 border border-gray-800 p-4">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-medium text-gray-400">Deck ${deck}</span>
          <span class="deck-status inline-block h-2 w-2 rounded-full bg-gray-600"></span>
        </div>
        <p class="deck-filename text-sm font-medium truncate text-gray-500">—</p>
        <div class="mt-2 flex items-center gap-3 text-xs text-gray-500">
          <span class="deck-bpm">— BPM</span>
          <span class="deck-volume">Vol: —</span>
          <span class="deck-pitch">Pitch: —</span>
        </div>
      </div>
      <div class="deck-video-wrap relative mt-2 rounded-lg bg-black border border-gray-800 overflow-hidden" style="aspect-ratio:16/9;">
        <canvas class="deck-canvas absolute inset-0 w-full h-full"></canvas>
        <div class="deck-no-video absolute inset-0 flex items-center justify-center text-gray-600 text-sm">No video</div>
      </div>
      <p class="deck-match mt-1 text-xs text-gray-500 truncate text-center">&mdash;</p>
      <p class="deck-rate text-xs text-gray-500 truncate text-center">&mdash;</p>`;

    // Start collapsed and invisible
    col.style.flexBasis = '0%';
    col.style.opacity = '0';

    // Insert in deck-number order (deck 3 always before deck 4)
    const allCols = container.querySelectorAll('[data-deck-col]');
    let inserted = false;
    for (const c of allCols) {
      if (parseInt(c.dataset.deckCol) > deck) {
        container.insertBefore(col, c);
        inserted = true;
        break;
      }
    }
    if (!inserted) container.appendChild(col);

    // Force reflow then animate in
    col.getBoundingClientRect();
    col.style.opacity = '1';
    updateDeckLayout();
  }

  /** Fade out and remove a deck column */
  function hideDeckCard(deck) {
    const col = document.querySelector(`[data-deck-col="${deck}"]`);
    if (!col || col.classList.contains("deck-exiting")) return;

    delete deckPaths[deck];

    const card = col.querySelector('[data-deck]');
    if (card) card.classList.remove("deck-active-pulse", "deck-pulse-in");
    col.classList.add("deck-exiting");
    col.style.flexBasis = '0%';
    col.style.opacity = '0';

    updateDeckLayout();

    col.addEventListener('transitionend', function handler(e) {
      if (e.propertyName === 'opacity') {
        col.removeEventListener('transitionend', handler);
        col.remove();
      }
    });
  }

  /** Show or hide the deck-limit warning banner */
  function updateBanner() {
    const banner = document.getElementById("deck-limit-banner");
    if (!banner) return;
    if (extraDecksPlaying.size > 0) {
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  /** SSE deck-visibility handler: show/hide deck 3/4 columns */
  const onDeckVisibility = (data) => {
    if (data.visible) {
      ensureDeckCard(data.deck);
    } else {
      hideDeckCard(data.deck);
    }
  };

  sse.onVisibility(onDeckVisibility);

  // Replay cached visibility so late-joining clients see the right cards
  for (const vis of Object.values(sse.deckVisibility)) {
    onDeckVisibility(vis);
  }

  // Set initial column layout for the 2 server-rendered decks
  updateDeckLayout();

  const updateDeckCard = (data) => {
    // Decks beyond MAX_DECKS: only track playing status for the warning banner
    if (data.deck > MAX_DECKS) {
      if (data.isPlaying) {
        extraDecksPlaying.add(data.deck);
      } else {
        extraDecksPlaying.delete(data.deck);
      }
      updateBanner();
      return;
    }

    // For decks 3/4 the column is created by the deck-visibility event,
    // not here — so if the column doesn't exist yet, just skip the update.
    const col = document.querySelector(`[data-deck-col="${data.deck}"]`);
    if (!col) return;

    const card = col.querySelector('[data-deck]');
    if (card) {
      const filenameEl = card.querySelector(".deck-filename");
      const bpmEl = card.querySelector(".deck-bpm");
      const volumeEl = card.querySelector(".deck-volume");
      const pitchEl = card.querySelector(".deck-pitch");
      const statusEl = card.querySelector(".deck-status");

      if (filenameEl) filenameEl.textContent = data.filename || "—";
      if (bpmEl) bpmEl.textContent = data.bpm ? `${data.bpm.toFixed(1)} BPM` : "— BPM";
      if (volumeEl) volumeEl.textContent = `Vol: ${(data.volume * 100).toFixed(0)}%`;
      if (pitchEl) pitchEl.textContent = `Pitch: ${data.pitch.toFixed(1)}%`;
      if (statusEl) {
        statusEl.classList.toggle("bg-green-500", data.isPlaying);
        statusEl.classList.toggle("bg-yellow-500", data.isAudible && !data.isPlaying);
        statusEl.classList.toggle("bg-gray-600", !data.isAudible && !data.isPlaying);
      }
    }

    // ── Per-deck match label ──
    const matchEl = col.querySelector('.deck-match');
    if (matchEl) {
      if (data.video) {
        const lvl = data.video.matchLevel ?? -1;
        const label = data.video.matchType === "forced" ? "Forced (BPM)" : (MATCH_LABELS[lvl] || "\u2014");
        matchEl.textContent = `Video Match: ${label}`;
      } else {
        matchEl.textContent = "\u2014";
      }
    }

    // ── Per-deck playback rate ──
    const rateEl = col.querySelector('.deck-rate');
    if (rateEl) {
      if (data.video) {
        // Prefer actual video element rate (shows drift corrections),
        // fall back to SSE-computed base rate for late-join / paused decks
        const playerVideoEl = document.getElementById(`deck-video-${data.deck}`);
        let r;
        if (playerVideoEl && playerVideoEl.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
          r = playerVideoEl.playbackRate;
        } else {
          const matchLevel = data.video.matchLevel ?? 5;
          const deckBPM = data.bpm || 0;
          const videoBPM = data.video.bpm || 0;
          const pitch = data.pitch || 100;
          r = pitch / 100;
          if (matchLevel >= 2 && deckBPM > 0 && videoBPM > 0) {
            r = (pitch / 100) * (deckBPM / videoBPM);
          }
          r = Math.max(0.25, Math.min(4, r));
        }
        rateEl.textContent = `Playback: ${r.toFixed(3)}x`;
      } else {
        rateEl.textContent = "\u2014";
      }
    }

    // ── Per-deck video path tracking (actual playback handled by embedded player) ──
    const noVideoEl = col.querySelector('.deck-no-video');
    if (data.video) {
      deckPaths[data.deck] = data.video.path;
      if (noVideoEl) noVideoEl.classList.add('hidden');
    } else {
      deckPaths[data.deck] = null;
      if (noVideoEl) noVideoEl.classList.remove('hidden');
    }
  };

  sse.onUpdate(updateDeckCard);

  // Replay cached deck data so cards populate immediately
  for (const data of Object.values(sse.decks)) {
    updateDeckCard(data);
  }

  // Canvas mirroring: copy frames from embedded player videos to deck card canvases (~15fps)
  const mirrorInterval = setInterval(() => {
    for (const [deckStr, path] of Object.entries(deckPaths)) {
      if (!path) continue;
      const d = Number(deckStr);
      const col = document.querySelector(`[data-deck-col="${d}"]`);
      if (!col) continue;
      const canvas = col.querySelector('.deck-canvas');
      if (!canvas) continue;
      const srcVideo = document.getElementById(`deck-video-${d}`);
      if (!srcVideo || srcVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) continue;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(srcVideo, 0, 0, w, h);
    }
  }, 66);

  // Init embedded player preview
  const embeddedContainer = document.getElementById("embedded-player");
  const embeddedNoVideo = document.getElementById("embedded-no-video");
  let cleanupEmbeddedPlayer = null;
  let currentActiveDeck = null;

  /** Current transition state from initPlayer callback */
  let transitionState = { inProgress: false, rate: 0 };

  function updatePlayerInfo() {
    const matchEl = document.getElementById("info-match");
    const rateEl = document.getElementById("info-rate");
    const bpmEl = document.getElementById("info-bpm");
    const transRow = document.getElementById("info-trans-row");
    const transRateEl = document.getElementById("info-trans-rate");
    if (!matchEl || !rateEl || !bpmEl) return;

    if (currentActiveDeck === null) {
      matchEl.textContent = "Video Match: \u2014";
      rateEl.textContent = "Playback: \u2014";
      bpmEl.textContent = "Master BPM: \u2014";
      if (transRow) transRow.classList.add("hidden");
      return;
    }

    const data = sse.decks[currentActiveDeck];
    if (!data) return;

    // Match level
    const level = data.video?.matchLevel ?? -1;
    const matchType = data.video?.matchType || "";
    const label = matchType === "forced" ? "Forced (BPM)" : (MATCH_LABELS[level] || "\u2014");
    matchEl.textContent = `Video Match: ${label}`;

    // Prefer actual video element rate (shows drift corrections),
    // fall back to SSE-computed base rate for late-join / paused decks
    const videoEl = document.getElementById(`deck-video-${currentActiveDeck}`);
    if (data.video) {
      let rate;
      if (videoEl && videoEl.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
        rate = videoEl.playbackRate;
      } else {
        const matchLevel = data.video.matchLevel ?? 5;
        const deckBPM = data.bpm || 0;
        const videoBPM = data.video.bpm || 0;
        const pitch = data.pitch || 100;
        rate = pitch / 100;
        if (matchLevel >= 2 && deckBPM > 0 && videoBPM > 0) {
          rate = (pitch / 100) * (deckBPM / videoBPM);
        }
        rate = Math.max(0.25, Math.min(4, rate));
      }
      rateEl.textContent = `Playback: ${rate.toFixed(3)}x`;
    } else {
      rateEl.textContent = "Playback: \u2014";
    }

    // Deck BPM
    bpmEl.textContent = `Master BPM: ${data.bpm ? data.bpm.toFixed(1) : "\u2014"}`;

    // Transition playback rate (visible only during transition)
    if (transRow && transRateEl) {
      if (transitionState.inProgress) {
        transRow.classList.remove("hidden");
        transRateEl.textContent = `Transition Playback: ${transitionState.rate.toFixed(3)}x`;
      } else {
        transRow.classList.add("hidden");
      }
    }
  }

  // Update info on every SSE deck update
  const updatePlayerInfoOnSSE = () => updatePlayerInfo();
  sse.onUpdate(updatePlayerInfoOnSSE);

  if (embeddedContainer) {
    const onActiveDeck = (deck) => {
      currentActiveDeck = deck;
      updatePlayerInfo();
      document.querySelectorAll("[data-deck]").forEach((card) => {
        const isActive = deck !== null && Number(card.dataset.deck) === deck;
        if (isActive) {
          card.classList.remove("deck-pulse-out", "deck-active-pulse");
          card.classList.add("deck-pulse-in");
          card.addEventListener("animationend", () => {
            card.classList.remove("deck-pulse-in");
            card.classList.add("deck-active-pulse");
          }, { once: true });
        } else if (card.classList.contains("deck-active-pulse") || card.classList.contains("deck-pulse-in")) {
          card.classList.remove("deck-active-pulse", "deck-pulse-in");
          card.classList.add("deck-pulse-out");
          card.addEventListener("animationend", () => {
            card.classList.remove("deck-pulse-out");
          }, { once: true });
        }
      });
    };
    const onTransitionChange = (state) => {
      transitionState = state;
      updatePlayerInfo();
    };
    cleanupEmbeddedPlayer = initPlayer(embeddedContainer, embeddedNoVideo, onActiveDeck, onTransitionChange);
  }

  // Return cleanup function
  return () => {
    sse.offUpdate(updateDeckCard);
    sse.offUpdate(updatePlayerInfoOnSSE);
    sse.offVisibility(onDeckVisibility);
    clearInterval(mirrorInterval);
    window.removeEventListener('resize', onResize);
    if (cleanupEmbeddedPlayer) cleanupEmbeddedPlayer();
  };
}

// ─── Control Bar (Bottom Bar) ───────────────────────────

function initControlBar() {
  const input = document.getElementById("transition-duration");
  if (!input) return;
  // Prevent re-attaching listeners on SPA navigation
  if (input.dataset.bound) return;
  input.dataset.bound = "1";

  const sse = getSSE();

  // Transition enabled toggle
  const toggle = document.getElementById("transition-enabled");
  const toggleKnob = toggle ? toggle.querySelector("span") : null;

  function setToggleUI(enabled) {
    if (!toggle) return;
    toggle.setAttribute("aria-checked", enabled ? "true" : "false");
    if (enabled) {
      toggle.classList.replace("bg-gray-600", "bg-indigo-600") || toggle.classList.add("bg-indigo-600");
      toggle.classList.remove("bg-gray-600");
      toggleKnob.classList.replace("translate-x-0", "translate-x-4") || toggleKnob.classList.add("translate-x-4");
      toggleKnob.classList.remove("translate-x-0");
    } else {
      toggle.classList.replace("bg-indigo-600", "bg-gray-600") || toggle.classList.add("bg-gray-600");
      toggle.classList.remove("bg-indigo-600");
      toggleKnob.classList.replace("translate-x-4", "translate-x-0") || toggleKnob.classList.add("translate-x-0");
      toggleKnob.classList.remove("translate-x-4");
    }
  }

  if (toggle) {
    toggle.addEventListener("click", () => {
      transitionsEnabled = !transitionsEnabled;
      setToggleUI(transitionsEnabled);
      const val = transitionsEnabled ? "1" : "0";
      // Notify other same-browser tabs immediately via BroadcastChannel
      if (configBC) configBC.postMessage({ key: "transition_enabled", value: val });
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "transition_enabled", value: val }),
      }).catch((err) => console.error(ts(), "[controlbar] save error:", err));
    });
  }

  // Load initial values from config
  fetch("/api/config")
    .then((r) => r.json())
    .then((cfg) => {
      const val = parseInt(cfg.transition_duration, 10);
      if (val >= 1 && val <= 10) {
        input.value = val;
        transitionDurationMs = val * 1000;
      } else {
        input.value = 3;
        transitionDurationMs = 3000;
      }
      transitionsEnabled = cfg.transition_enabled !== "0";
      setToggleUI(transitionsEnabled);
    })
    .catch(() => {
      input.value = 3;
      transitionDurationMs = 3000;
    });

  // Debounced save on input change
  let saveTimer = null;
  function applyValue(val) {
    if (isNaN(val) || val < 1) val = 1;
    if (val > 10) val = 10;
    input.value = val;
    transitionDurationMs = val * 1000;

    // Notify other same-browser tabs immediately via BroadcastChannel
    if (configBC) configBC.postMessage({ key: "transition_duration", value: String(val) });

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "transition_duration", value: String(val) }),
      }).catch((err) => console.error(ts(), "[controlbar] save error:", err));
    }, 500);
  }

  input.addEventListener("input", () => applyValue(parseInt(input.value, 10)));

  // +/- buttons
  const minusBtn = document.getElementById("transition-duration-minus");
  const plusBtn = document.getElementById("transition-duration-plus");
  if (minusBtn) minusBtn.addEventListener("click", () => applyValue((parseInt(input.value, 10) || 3) - 1));
  if (plusBtn) plusBtn.addEventListener("click", () => applyValue((parseInt(input.value, 10) || 3) + 1));

  // SSE sync: update when another client changes the value
  const onConfigUpdate = (data) => {
    if (data.key === "transition_duration") {
      const val = parseInt(data.value, 10);
      if (val >= 1 && val <= 10) {
        input.value = val;
        transitionDurationMs = val * 1000;
      }
    } else if (data.key === "transition_enabled") {
      transitionsEnabled = data.value !== "0";
      setToggleUI(transitionsEnabled);
    }
  };
  sse.onConfig(onConfigUpdate);
}

// ─── Settings Modal Logic ───────────────────────────────

function initSettings() {
  const btn = document.getElementById("settings-btn");
  const modal = document.getElementById("settings-modal");
  const backdrop = document.getElementById("settings-backdrop");
  const closeBtn = document.getElementById("settings-close");
  const saveBtn = document.getElementById("save-settings");
  if (!btn || !modal) return;
  // Prevent re-attaching listeners on SPA navigation
  if (btn.dataset.bound) return;
  btn.dataset.bound = "1";

  function openModal() {
    modal.classList.remove("hidden");
    // Load current config values into the modal inputs
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) => {
        modal.querySelectorAll("[data-config-key]").forEach((el) => {
          const key = el.dataset.configKey;
          if (cfg[key] !== undefined) el.value = cfg[key];
        });
      })
      .catch((err) => console.error(ts(), "[settings] load error:", err));
  }

  function closeModal() {
    modal.classList.add("hidden");
  }

  btn.addEventListener("click", openModal);
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (backdrop) backdrop.addEventListener("click", closeModal);

  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const fields = modal.querySelectorAll("[data-config-key]");
      const promises = Array.from(fields).map((el) =>
        fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: el.dataset.configKey, value: el.value }),
        })
      );
      Promise.all(promises)
        .then(() => {
          saveBtn.textContent = "Saved!";
          setTimeout(() => {
            saveBtn.textContent = "Save Settings";
            closeModal();
          }, 1000);
        })
        .catch((err) => console.error(ts(), "[settings] save error:", err));
    });
  }
}

// ─── Shutdown Modal Logic ───────────────────────────────

function initShutdown() {
  const btn = document.getElementById("shutdown-btn");
  const modal = document.getElementById("shutdown-modal");
  const backdrop = document.getElementById("shutdown-backdrop");
  const cancelBtn = document.getElementById("shutdown-cancel");
  const confirmBtn = document.getElementById("shutdown-confirm");
  if (!btn || !modal) return;
  // Prevent re-attaching listeners on SPA navigation
  if (btn.dataset.bound) return;
  btn.dataset.bound = "1";

  function openModal() { modal.classList.remove("hidden"); }
  function closeModal() { modal.classList.add("hidden"); }

  btn.addEventListener("click", openModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  if (backdrop) backdrop.addEventListener("click", closeModal);

  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Shutting down…";
      fetch("/api/shutdown", { method: "POST" })
        .then(() => {
          document.body.innerHTML = '<div class="flex items-center justify-center h-screen bg-gray-950 text-gray-400 text-lg">Server has been shut down.</div>';
        })
        .catch(() => {
          document.body.innerHTML = '<div class="flex items-center justify-center h-screen bg-gray-950 text-gray-400 text-lg">Server has been shut down.</div>';
        });
    });
  }
}

// ─── Library Logic ──────────────────────────────────────

function initLibrary() {
  // ── Video library tabs ──
  let activeLibraryTab = "song";

  const forceBtn = document.getElementById("force-video-btn");

  /** Show/hide the force button based on active tab */
  function updateForceButton() {
    if (!forceBtn) return;
    const deckBtns = document.getElementById("force-deck-btns");
    if (activeLibraryTab === "song") {
      forceBtn.classList.remove("hidden");
      forceBtn.disabled = !forceBtn.dataset.path;
      if (deckBtns) {
        deckBtns.classList.remove("hidden");
        deckBtns.querySelectorAll("[data-force-deck]").forEach((btn) => {
          btn.disabled = !forceBtn.dataset.path;
        });
      }
    } else {
      forceBtn.classList.add("hidden");
      if (deckBtns) deckBtns.classList.add("hidden");
    }
  }

  const tabs = document.querySelectorAll("[data-library-tab]");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activeLibraryTab = tab.dataset.libraryTab;
      // Update tab styles
      tabs.forEach((t) => {
        const isActive = t.dataset.libraryTab === activeLibraryTab;
        t.classList.toggle("bg-gray-700", isActive);
        t.classList.toggle("text-white", isActive);
        t.classList.toggle("text-gray-400", !isActive);
        t.classList.toggle("hover:text-white", !isActive);
      });
      // Reset search
      if (searchInput) searchInput.value = "";
      // Reset preview
      resetPreview();
      updateForceButton();
      // Load the selected library
      loadVideoList(activeLibraryTab);
    });
  });

  function resetPreview() {
    const video = document.getElementById("video-preview");
    const placeholder = document.getElementById("preview-placeholder");
    const name = document.getElementById("preview-name");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.classList.add("hidden");
    }
    if (placeholder) placeholder.classList.remove("hidden");
    if (name) name.classList.add("hidden");
    if (forceBtn) delete forceBtn.dataset.path;
    updateForceButton();
  }

  // Load video library (default tab: song)
  loadVideoList(activeLibraryTab);

  // Auto-refresh when server detects file changes via SSE
  const sse = getSSE();
  const onLibraryUpdated = (data) => {
    // Refresh if the updated type matches the active tab, or refresh both
    if (!data.type || data.type === activeLibraryTab) {
      loadVideoList(activeLibraryTab);
    }
  };
  sse.onLibraryUpdated(onLibraryUpdated);

  // Video search filter
  const searchInput = document.getElementById("video-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const query = searchInput.value.toLowerCase();
      const items = document.querySelectorAll("#video-list [data-video-name]");
      items.forEach((el) => {
        const name = el.dataset.videoName.toLowerCase();
        el.style.display = name.includes(query) ? "" : "none";
      });
    });
  }

  // Click-to-pause for preview
  const preview = document.getElementById("video-preview");
  if (preview) {
    preview.addEventListener("click", () => {
      if (preview.paused) {
        preview.play().catch(() => {});
      } else {
        preview.pause();
      }
    });
  }

  // Force Master Video button handler
  if (forceBtn) {
    forceBtn.addEventListener("click", () => {
      const path = forceBtn.dataset.path;
      if (!path) return;
      forceBtn.disabled = true;
      fetch("/api/force-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      })
        .then((r) => {
          if (!r.ok) return r.text().then((t) => { throw new Error(t); });
          return r.json();
        })
        .then((res) => {
          console.log(ts(), "[library] video forced:", res.video);
          // Brief visual feedback
          forceBtn.textContent = "Forced!";
          setTimeout(() => {
            forceBtn.textContent = "Force Master Video";
            forceBtn.disabled = false;
          }, 1500);
        })
        .catch((err) => {
          console.error(ts(), "[library] force video error:", err.message);
          forceBtn.disabled = false;
        });
    });
  }

  // Show force button on initial tab
  updateForceButton();

  // Force Deck X button handlers
  document.querySelectorAll("[data-force-deck]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = forceBtn?.dataset.path;
      const deck = parseInt(btn.dataset.forceDeck, 10);
      if (!path || !deck) return;
      btn.disabled = true;
      fetch("/api/force-deck-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, deck }),
      })
        .then((r) => {
          if (!r.ok) return r.text().then((t) => { throw new Error(t); });
          return r.json();
        })
        .then((res) => {
          console.log(ts(), `[library] video forced on deck ${deck}:`, res.video);
          const origText = btn.textContent;
          btn.textContent = "Forced!";
          setTimeout(() => {
            btn.textContent = origText;
            btn.disabled = false;
          }, 1500);
        })
        .catch((err) => {
          console.error(ts(), `[library] force deck ${deck} error:`, err.message);
          btn.disabled = false;
        });
    });
  });

  // Return cleanup function
  return () => {
    sse.offLibraryUpdated(onLibraryUpdated);
    // Stop preview video when leaving library page
    if (preview && !preview.paused) {
      preview.pause();
    }
  };
}

function loadVideoList(type = "song") {
  const params = new URLSearchParams();
  if (type === "transition") params.set("type", "transition");
  const url = "/api/videos" + (params.toString() ? "?" + params.toString() : "");
  fetch(url)
    .then((r) => r.json())
    .then((videos) => {
      const container = document.getElementById("video-list");
      if (!container) return;

      if (!videos || videos.length === 0) {
        container.innerHTML =
          '<p class="p-4 text-gray-500 text-sm">No videos found.</p>';
        return;
      }

      container.innerHTML = videos
        .map(
          (v) => `
          <div class="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-800 transition-colors" data-video-name="${escapeHtml(v.name)}" data-video-path="${escapeHtml(v.path)}">
            <div class="min-w-0">
              <p class="text-sm text-gray-200 truncate">${escapeHtml(stripExt(v.name))}</p>
              ${v.bpm ? `<span class="text-xs text-gray-500">${v.bpm} BPM</span>` : ""}
            </div>
          </div>`
        )
        .join("");

      // Attach click handlers for preview
      container.querySelectorAll("[data-video-path]").forEach((el) => {
        el.addEventListener("click", () => {
          // Mark selected item
          container.querySelectorAll("[data-video-path]").forEach((item) => {
            item.classList.remove("bg-gray-800");
          });
          el.classList.add("bg-gray-800");
          previewVideo(el.dataset.videoPath, el.dataset.videoName);
        });
      });
    })
    .catch((err) => console.error(ts(), "[videos] load error:", err));
}

// ─── Video Preview ──────────────────────────────────────

function previewVideo(path, name) {
  const video = document.getElementById("video-preview");
  const placeholder = document.getElementById("preview-placeholder");
  const previewName = document.getElementById("preview-name");
  const forceBtn = document.getElementById("force-video-btn");
  if (!video) return;

  video.src = path;
  video.classList.remove("hidden");
  video.play().catch(() => {});

  if (placeholder) placeholder.classList.add("hidden");
  if (previewName) {
    previewName.textContent = stripExt(name);
    previewName.classList.remove("hidden");
  }
  // Enable force buttons with selected path
  if (forceBtn) {
    forceBtn.dataset.path = path;
    if (!forceBtn.classList.contains("hidden")) {
      forceBtn.disabled = false;
    }
    // Also enable per-deck force buttons
    const deckBtns = document.getElementById("force-deck-btns");
    if (deckBtns && !deckBtns.classList.contains("hidden")) {
      deckBtns.querySelectorAll("[data-force-deck]").forEach((btn) => {
        btn.disabled = false;
      });
    }
  }
}

// ─── Shared Video Sync ──────────────────────────────────

/** Max desync (ms) before we hard-seek the video to re-align */
const HARD_SEEK_MS = 2000;
/** Drift threshold (ms) above which we start smooth catch-up */
const SOFT_DRIFT_MS = 150;
/** Offset applied to elapsed time (ms) – tune if video consistently leads/lags */
const OFFSET_MS = -100;

/**
 * Synchronise elapsed time and playback rate for a deck video.
 *
 * Match levels 0-1 (exact/stem): sync to VDJ elapsedMs, rate = pitch/100.
 * Match levels 2-5 (fuzzy/BPM/random/forced): sync to server-tracked
 * videoElapsedMs (no modulo — video plays to its natural end so the
 * ended event can fire and trigger a video-ended transition).
 */
function syncElapsedAndRate(deck, data, videoEl) {
  if (videoEl.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return;

  const matchLevel = data.video.matchLevel ?? 5;
  const deckBPM = data.bpm || 0;
  const videoBPM = data.video.bpm || 0;
  const pitch = data.pitch || 100;

  let baseRate = pitch / 100;
  if (matchLevel >= 2 && deckBPM > 0 && videoBPM > 0) {
    baseRate = (pitch / 100) * (deckBPM / videoBPM);
  }
  baseRate = Math.max(0.25, Math.min(4, baseRate));

  let finalRate = baseRate;

  if (matchLevel <= 1 && data.elapsedMs !== undefined) {
    // Levels 0-1: sync to VDJ elapsed time
    const targetSec = data.elapsedMs / 1000 + OFFSET_MS / 1000;
    if (targetSec > 0 && targetSec < videoEl.duration) {
      const driftMs = (videoEl.currentTime - targetSec) * 1000;
      const absDrift = Math.abs(driftMs);
      if (absDrift > HARD_SEEK_MS) {
        console.log(ts(), `[player] hard seek deck ${data.deck}: drift=${(driftMs/1000).toFixed(3)}s target=${targetSec.toFixed(3)}s actual=${videoEl.currentTime.toFixed(3)}s`);
        videoEl.currentTime = targetSec;
      } else if (absDrift > SOFT_DRIFT_MS) {
        const factor = Math.min(absDrift / HARD_SEEK_MS, 0.15);
        finalRate = driftMs > 0
          ? baseRate * (1 - factor)
          : baseRate * (1 + factor);
        finalRate = Math.max(0.25, Math.min(4, finalRate));
      }
    }
  } else if (matchLevel >= 2 && data.videoElapsedMs !== undefined) {
    // Levels 2+: sync to server-tracked video position.
    // No modulo — let the video reach its natural end so the ended
    // event fires and handleVideoEnded can switch to a new video.
    const targetSec = data.videoElapsedMs / 1000;
    if (targetSec >= 0 && targetSec < videoEl.duration) {
      const driftMs = (videoEl.currentTime - targetSec) * 1000;
      const absDrift = Math.abs(driftMs);
      if (absDrift > HARD_SEEK_MS) {
        console.log(ts(), `[player] hard seek deck ${data.deck}: drift=${(driftMs/1000).toFixed(3)}s target=${targetSec.toFixed(3)}s actual=${videoEl.currentTime.toFixed(3)}s`);
        videoEl.currentTime = targetSec;
      } else if (absDrift > SOFT_DRIFT_MS) {
        const factor = Math.min(absDrift / HARD_SEEK_MS, 0.15);
        finalRate = driftMs > 0
          ? baseRate * (1 - factor)
          : baseRate * (1 + factor);
        finalRate = Math.max(0.25, Math.min(4, finalRate));
      }
    }
  }

  if (Math.abs(videoEl.playbackRate - finalRate) > 0.001) {
    videoEl.playbackRate = finalRate;
    videoEl.defaultPlaybackRate = baseRate;
  }
}

// ─── Player Logic (standalone /player page) ─────────────

function initPlayer(containerEl, noVideoEl, onActiveDeckChange, onTransitionChange) {
  const sse = getSSE();
  const container = containerEl || document.getElementById("player-container");
  const noVideo = noVideoEl || document.getElementById("no-video");
  if (!container) return () => {};

  /** Per-deck state received from SSE  @type {Record<number, object>} */
  const deckStates = {};
  /** Per-deck <video> elements          @type {Record<number, HTMLVideoElement>} */
  const deckVideos = {};
  /** Per-deck currently-loaded video path */
  const deckPaths = {};
  /** Per-deck pending play() promise – prevents play/pause race conditions */
  const deckPlayPromises = {};
  /** Track which deck is currently on top */
  let activeDeck = null;
  /** Decks awaiting a server-driven video switch after video-ended (levels 2+) */
  const pendingEndedSwitch = new Set();

  // ── Transition system ──
  //
  // Server-driven triple-buffered design:
  //  1. The server maintains a pool of 3 transition videos at all times.
  //  2. On SSE connect, the server sends a "transition-pool" event with
  //     all 3 slots so the client can start downloading immediately.
  //  3. When a deck switch happens, the server sends "transition-play"
  //     with the slot index to play, then refills that slot and sends
  //     an updated "transition-pool".
  //  4. The client never decides which video to load — it only loads
  //     what the server tells it.  No race conditions, no overwriting.

  /** Whether a transition is currently playing */
  let transitionInProgress = false;
  /** Pending play command received from server */
  let pendingPlaySlot = null;
  /** Buffer index currently being played (-1 = none) */
  let playingBufferIdx = -1;
  /** Deferred pool data for buffers that couldn't be replaced mid-play */
  const deferredPoolData = [null, null, null];

  /** Create a transition <video> element */
  function createTransVideo() {
    const v = document.createElement("video");
    v.muted = true;
    v.setAttribute("muted", "");
    v.autoplay = false;
    v.playsInline = true;
    v.disablePictureInPicture = true;
    v.loop = true;
    v.preload = "none"; // we use fetch() + blob URLs, not browser preload
    v.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:black;";
    v.style.zIndex = "-1";
    container.appendChild(v);
    return v;
  }

  // Three transition buffers, each with its own <video>, BPM, path, and blob URL
  const transBuffers = [
    { video: createTransVideo(), bpm: 0, path: null, blobUrl: null },
    { video: createTransVideo(), bpm: 0, path: null, blobUrl: null },
    { video: createTransVideo(), bpm: 0, path: null, blobUrl: null },
  ];

  // Log errors and readyState changes on transition buffer videos.
  transBuffers.forEach((buf, idx) => {
    buf.video.addEventListener("error", () => {
      const e = buf.video.error;
      console.error(ts(), `[player] transition buffer ${idx} error: code=${e?.code} msg=${e?.message}`, buf.path);
      // Revoke blob and clear path so the next pool update can re-attempt
      if (buf.blobUrl) { URL.revokeObjectURL(buf.blobUrl); buf.blobUrl = null; }
      buf.path = null;
    });
    buf.video.addEventListener("canplaythrough", () => {
      console.log(ts(), `[player] transition buffer ${idx} ready (readyState=${buf.video.readyState})`, buf.path);
    });
  });

  /** Load a transition video into a specific buffer.
   *  Uses fetch() + blob URL instead of browser preload to bypass Chrome's
   *  media preload limit (~6 elements). The video data is downloaded via the
   *  regular HTTP stack and set as a blob URL — readyState reaches 4 almost
   *  instantly once the fetch completes. */
  function loadTransitionBuffer(idx, entry) {
    if (!entry?.video) return;
    const buf = transBuffers[idx];
    // Same video already assigned — skip
    if (buf.path === entry.video) return;
    buf.bpm = entry.bpm || 0;
    buf.path = entry.video;
    const target = entry.video;
    console.log(ts(), `[player] loading transition buffer ${idx}:`, target, "bpm:", buf.bpm);

    fetch(target)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        // If path changed while fetching, discard this result
        if (buf.path !== target) return;
        if (buf.blobUrl) URL.revokeObjectURL(buf.blobUrl);
        buf.blobUrl = URL.createObjectURL(blob);
        buf.video.preload = "auto";
        buf.video.src = buf.blobUrl;
        buf.video.load();
      })
      .catch((err) => {
        console.error(ts(), `[player] transition buffer ${idx} fetch failed:`, err.message, target);
        if (buf.path === target) buf.path = null; // allow retry
      });
  }

  /** SSE transition-pool handler: load all 3 slots.
   *  When a play command is pending or a transition is in progress, defer
   *  ALL slot updates so we don't reset readyState on fallback buffers
   *  right before playTransition needs them. */
  const onTransitionPool = (data) => {
    if (!data?.slots) return;
    const deferAll = pendingPlaySlot !== null || playingBufferIdx !== -1;
    for (let i = 0; i < 3; i++) {
      if (data.slots[i]) {
        if (deferAll) {
          // Protect all buffers while a transition is pending/playing
          deferredPoolData[i] = data.slots[i];
          console.log(ts(), `[player] deferring pool update for buffer ${i} (pending=${pendingPlaySlot}, playing=${playingBufferIdx})`);
          continue;
        }
        loadTransitionBuffer(i, data.slots[i]);
      }
    }
  };

  /** SSE transition-play handler: server says to play slot N */
  const onTransitionPlay = (data) => {
    // The server tells us which slot to play.  The actual deck switch
    // is detected client-side by updatePriority(), which calls
    // playTransition().  We just record which slot the server chose.
    if (data?.slot !== undefined) {
      pendingPlaySlot = data.slot;
      console.log(ts(), `[player] server says play slot ${data.slot}`);
    }
  };

  sse.onTransitionPool(onTransitionPool);
  sse.onTransitionPlay(onTransitionPlay);

  // Replay cached pool from SSE (immediate preload on join)
  if (sse.lastTransitionPool) {
    onTransitionPool(sse.lastTransitionPool);
  }

  /** Find a buffer that is ready to play.
   *  Only returns the server-chosen slot — no fallback to other slots,
   *  to ensure all clients play the same transition video. */
  function pickReadyBuffer() {
    const preferred = pendingPlaySlot !== null ? pendingPlaySlot : -1;
    if (preferred === -1) return -1;
    if (transBuffers[preferred].video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      return preferred;
    }
    return -1;
  }

  /** Load deferred pool data into buffers (called after a successful transition). */
  function applyDeferredPool() {
    for (let i = 0; i < 3; i++) {
      if (deferredPoolData[i]) {
        loadTransitionBuffer(i, deferredPoolData[i]);
        deferredPoolData[i] = null;
      }
    }
  }

  /** Discard deferred pool data without loading (called on skip paths to
   *  preserve ready buffers as fallbacks — next pool event loads fresh). */
  function discardDeferredPool() {
    for (let i = 0; i < 3; i++) deferredPoolData[i] = null;
  }

  /**
   * Play the transition video on top for 3 seconds, swapping decks
   * underneath.  Falls back to an instant swap when neither buffer
   * is ready.  If a buffer is loading, waits up to 2s.
   */
  function playTransition(newDeck, swapFn) {
    if (!transitionsEnabled) {
      console.log(ts(), "[player] transition skipped (disabled)");
      pendingPlaySlot = null;
      swapFn();
      return;
    }
    if (transitionInProgress) {
      console.log(ts(), "[player] transition skipped (already in progress)");
      pendingPlaySlot = null; // release so pool updates aren't deferred
      discardDeferredPool(); // don't load — preserve ready buffers as fallbacks
      swapFn();
      return;
    }

    let chosenIdx = pickReadyBuffer();

    if (chosenIdx === -1) {
      // No buffer ready yet.  If a buffer is actively loading, wait
      // up to 2 seconds for it — covers first-join race condition.
      const loading = transBuffers.some((b) => b.path && b.video.readyState > 0);
      if (loading) {
        console.log(ts(), "[player] transition deferred — waiting for buffer to load");
        transitionInProgress = true; // guard against re-entry while polling
        const startTime = Date.now();
        const poll = setInterval(() => {
          chosenIdx = pickReadyBuffer();
          if (chosenIdx !== -1 || Date.now() - startTime > 2000) {
            clearInterval(poll);
            if (chosenIdx !== -1) {
              transitionInProgress = false; // executeTransition will re-set it
              executeTransition(chosenIdx, newDeck, swapFn);
            } else {
              console.log(ts(), `[player] transition skipped after wait (buf0=${transBuffers[0].video.readyState}, buf1=${transBuffers[1].video.readyState}, buf2=${transBuffers[2].video.readyState})`);
              transitionInProgress = false;
              pendingPlaySlot = null; // release so pool updates aren't deferred
              applyDeferredPool(); // retry stalled loads (all buffers already unready)
              swapFn();
            }
          }
        }, 50);
        return;
      }

      console.log(ts(), `[player] transition skipped (buf0=${transBuffers[0].video.readyState}, buf1=${transBuffers[1].video.readyState}, buf2=${transBuffers[2].video.readyState})`);
      pendingPlaySlot = null; // release so pool updates aren't deferred
      applyDeferredPool(); // retry stalled loads (all buffers already unready)
      swapFn();
      return;
    }

    executeTransition(chosenIdx, newDeck, swapFn);
  }

  /** Internal: play the transition from a chosen buffer index. */
  function executeTransition(chosenIdx, newDeck, swapFn) {
    const buf = transBuffers[chosenIdx];
    const tv = buf.video;
    transitionInProgress = true;
    playingBufferIdx = chosenIdx;
    pendingPlaySlot = null; // consumed

    // Bring chosen transition video on top of deck videos
    tv.style.zIndex = "20";

    // ── Sync playback rate to new deck's BPM + pitch ──
    const newState = deckStates[newDeck];
    const deckBPM = newState?.bpm || 0;
    const pitch = newState?.pitch || 100;
    let rate = pitch / 100;

    if (buf.bpm > 0 && deckBPM > 0) {
      const direct = Math.abs(deckBPM - buf.bpm);
      const doubled = Math.abs(deckBPM - buf.bpm * 2);
      const halved  = Math.abs(deckBPM - buf.bpm / 2);
      let effectiveBPM = buf.bpm;
      if (doubled < direct && doubled < halved) effectiveBPM = buf.bpm * 2;
      else if (halved < direct && halved < doubled) effectiveBPM = buf.bpm / 2;
      rate = (pitch / 100) * (deckBPM / effectiveBPM);
    }

    rate = Math.max(0.25, Math.min(4, rate));
    tv.playbackRate = rate;
    if (onTransitionChange) onTransitionChange({ inProgress: true, rate });
    console.log(ts(), `[player] transition playing from buffer ${chosenIdx} (rate=${rate.toFixed(2)})`);

    // Seek to start and play
    tv.currentTime = 0;
    tv.play().then(() => {
      console.log(ts(), "[player] transition started");
    }).catch((err) => {
      console.warn(ts(), "[player] transition play() failed:", err.message);
    });

    // Swap decks underneath immediately
    swapFn();

    // After configured duration, hide transition and apply deferred pool updates
    setTimeout(() => {
      tv.style.zIndex = "-1";
      tv.pause();
      transitionInProgress = false;
      playingBufferIdx = -1;
      if (onTransitionChange) onTransitionChange({ inProgress: false, rate: 0 });

      // Apply any deferred pool data that arrived while we were playing
      applyDeferredPool();
    }, transitionDurationMs);
  }

  // ── Helpers ──

  /** Get or create a <video> element for a given deck number */
  function getVideoEl(deck) {
    if (deckVideos[deck]) return deckVideos[deck];

    const v = document.createElement("video");
    v.id = `deck-video-${deck}`;
    v.muted = true;
    v.setAttribute("muted", ""); // HTML attribute for browser autoplay policies
    v.autoplay = false;
    v.playsInline = true;
    v.disablePictureInPicture = true;
    v.loop = false; // handle end-of-video manually (transitions)
    // Stack all videos absolutely inside the container
    v.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:black;";
    v.style.zIndex = "0";
    v.style.visibility = "hidden";
    container.appendChild(v);
    deckVideos[deck] = v;

    // ── Video-ended handler (song outlasts video) ──
    v.addEventListener("ended", () => handleVideoEnded(deck));

    return v;
  }

  /**
   * Handle a deck video reaching its natural end.
   *
   * Match levels 0-1: loop the same video with a transition overlay.
   * Match levels 2+:  ask the server for a different random video;
   *                    the server broadcasts transition + deck-update via SSE.
   */
  function handleVideoEnded(deck) {
    const state = deckStates[deck];
    if (!state || !state.video) return;

    const matchLevel = state.video.matchLevel ?? 5;
    const videoEl = deckVideos[deck];
    if (!videoEl) return;

    console.log(ts(), `[player] video ended: deck ${deck}, level ${matchLevel}`);

    if (matchLevel <= 1) {
      // Levels 0-1: loop with transition (active deck) or silently (background)
      if (deck === activeDeck) {
        playTransition(deck, () => {
          videoEl.currentTime = 0;
          safePlay(deck, videoEl);
        });
      } else {
        videoEl.currentTime = 0;
        safePlay(deck, videoEl);
      }
      // Ask server to preload a fresh transition for next time
      fetch("/api/deck/video-ended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deck, matchLevel, currentVideo: deckPaths[deck] || "" }),
      }).catch(() => {});
    } else {
      // Levels 2+: server picks a new random video
      pendingEndedSwitch.add(deck);
      fetch("/api/deck/video-ended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deck, matchLevel, currentVideo: deckPaths[deck] || "" }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.action === "loop") {
            // Only one video available — loop it
            pendingEndedSwitch.delete(deck);
            if (deck === activeDeck) {
              playTransition(deck, () => {
                videoEl.currentTime = 0;
                safePlay(deck, videoEl);
              });
            } else {
              videoEl.currentTime = 0;
              safePlay(deck, videoEl);
            }
          }
          // "switch": SSE deck-update will trigger the video change
        })
        .catch((err) => {
          console.error(ts(), "[player] video-ended error:", err);
          pendingEndedSwitch.delete(deck);
          videoEl.currentTime = 0;
          safePlay(deck, videoEl);
        });
    }
  }

  /** Apply the z-index/visibility swap to show a specific deck on top */
  function applyDeckSwap(bestDeck) {
    if (bestDeck !== null) {
      for (const [deckStr, videoEl] of Object.entries(deckVideos)) {
        const deck = Number(deckStr);
        if (deck === bestDeck) {
          videoEl.style.zIndex = "10";
          videoEl.style.visibility = "visible";
        } else {
          videoEl.style.zIndex = "0";
          videoEl.style.visibility = "hidden";
        }
      }
      if (activeDeck !== bestDeck) {
        activeDeck = bestDeck;
        if (onActiveDeckChange) onActiveDeckChange(activeDeck);
      }
      if (noVideo) noVideo.classList.add("hidden");
    } else {
      for (const videoEl of Object.values(deckVideos)) {
        videoEl.style.visibility = "hidden";
      }
      if (activeDeck !== null) {
        activeDeck = null;
        if (onActiveDeckChange) onActiveDeckChange(null);
      }
      if (noVideo) noVideo.classList.remove("hidden");
    }
  }

  /**
   * Determine which deck should be the master and update z-indices.
   *
   * Rule 1: The master video is from the audible, playing deck with
   *         the highest volume (ties go to the current master to
   *         prevent oscillation).
   * Rule 2: If the master changes for any reason, play a transition.
   */
  function updatePriority() {
    let bestDeck = null;
    let bestVolume = -1;

    for (const [deckStr, state] of Object.entries(deckStates)) {
      const deck = Number(deckStr);
      if (state.isAudible && state.isPlaying && state.video && deckPaths[deck]) {
        if (state.volume > bestVolume || (state.volume === bestVolume && deck === activeDeck)) {
          bestVolume = state.volume;
          bestDeck = deck;
        }
      }
    }

    // No audible+playing deck found — fall back to any deck that has a video loaded.
    // Prefer the current activeDeck if it still has a video. This ensures late-joining
    // clients see the paused video frame instead of "Waiting for track...".
    if (bestDeck === null) {
      if (activeDeck !== null && deckStates[activeDeck]?.video && deckPaths[activeDeck]) {
        return; // keep showing the current active deck (paused)
      }
      // Pick any deck that has a video loaded
      for (const [deckStr, state] of Object.entries(deckStates)) {
        const deck = Number(deckStr);
        if (state.video && deckPaths[deck]) {
          bestDeck = deck;
          break;
        }
      }
    }

    // No qualified deck — keep showing the last active deck
    if (bestDeck === null && activeDeck !== null && deckVideos[activeDeck]) {
      return;
    }

    // No change
    if (bestDeck === activeDeck) return;

    console.log(ts(), `[player] active deck change: ${activeDeck} → ${bestDeck}`);

    // Deck-to-deck switch → play transition
    if (bestDeck !== null && activeDeck !== null) {
      console.log(ts(), `[player] deck-to-deck switch: playing transition`);
      // Update activeDeck immediately to prevent updatePriority re-entry
      // while we're waiting for the transition to complete.
      activeDeck = bestDeck;
      if (onActiveDeckChange) onActiveDeckChange(bestDeck);
      playTransition(bestDeck, () => applyDeckSwap(bestDeck));
      return;
    }

    // First deck appearing or last deck disappearing → instant swap
    console.log(ts(), `[player] instant swap (first/last deck)`);
    applyDeckSwap(bestDeck);
  }

  // ── Play/pause helper (handles promise race conditions) ──

  /**
   * Safely play a deck video.  Tracks the play() promise so that a
   * subsequent pause() call can wait for it to settle first.
   */
  function safePlay(deck, videoEl) {
    const p = videoEl.play().catch(() => {});
    deckPlayPromises[deck] = p;
    p.then(() => {
      if (deckPlayPromises[deck] === p) deckPlayPromises[deck] = null;
    });
  }

  /**
   * Safely pause a deck video.  If a play() promise is still pending,
   * wait for it to resolve before pausing to avoid the browser
   * silently ignoring the pause.
   */
  function safePause(deck, videoEl) {
    const pending = deckPlayPromises[deck];
    if (pending) {
      pending.then(() => videoEl.pause());
      deckPlayPromises[deck] = null;
    } else {
      videoEl.pause();
    }
  }

  /**
   * Synchronise play/pause state for a single deck.
   * Called from the SSE handler AND the safety interval.
   */
  function syncPlayPause(deck) {
    const state = deckStates[deck];
    const videoEl = deckVideos[deck];
    if (!state || !videoEl || !deckPaths[deck]) return;

    if (state.isPlaying) {
      // Should be playing
      if (videoEl.paused && videoEl.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
        safePlay(deck, videoEl);
      }
    } else {
      // Should be paused
      if (!videoEl.paused) {
        safePause(deck, videoEl);
      }
    }
  }

  // ── SSE handler ──

  const onDeckUpdate = (data) => {
    const deck = data.deck;

    // Ignore decks beyond the supported limit
    if (deck > MAX_DECKS) return;

    const prevState = deckStates[deck];
    deckStates[deck] = data;
    const videoEl = getVideoEl(deck);

    // ── Log song changes ──
    if (data.filename && (!prevState || prevState.filename !== data.filename)) {
      console.log(ts(), `[deck${deck}] song changed: "${data.filename}" bpm=${data.bpm}`);
    }

    // ── Log play/pause state changes ──
    if (prevState && prevState.isPlaying !== data.isPlaying) {
      console.log(ts(), `[deck${deck}] ${data.isPlaying ? "PLAYING" : "PAUSED"} (vol=${data.volume.toFixed(2)}, audible=${data.isAudible})`);
    }

    // ── Log volume/audibility changes ──
    if (prevState && (prevState.isAudible !== data.isAudible)) {
      console.log(ts(), `[deck${deck}] audible=${data.isAudible} (vol=${data.volume.toFixed(2)})`);
    }

    // ── Video source management ──
    if (data.video) {
      const newPath = data.video.path;
      if (deckPaths[deck] !== newPath) {
        // Check if this path change should play a transition
        // (video-ended switch OR server-triggered transition e.g. force-video)
        const withTransition = pendingEndedSwitch.has(deck) || pendingPlaySlot !== null;
        pendingEndedSwitch.delete(deck);

        console.log(ts(), `[deck${deck}] loading video: ${data.video.name} (level=${data.video.matchLevel}, path=${newPath}, transition=${withTransition})`);

        const loadNewVideo = () => {
          deckPaths[deck] = newPath;
          videoEl.src = newPath;
          videoEl.load();
          // Wait until the video is ready before seeking + playing
          videoEl.addEventListener(
            "loadeddata",
            () => {
              console.log(ts(), `[deck${deck}] video ready: ${data.video.name}`);
              syncElapsedAndRate(deck, data, videoEl);
              syncPlayPause(deck);
            },
            { once: true },
          );
        };

        if (withTransition && deck === activeDeck) {
          playTransition(deck, loadNewVideo);
        } else {
          loadNewVideo();
        }
      }
    } else {
      // No matched video for this deck
      if (deckPaths[deck]) {
        console.log(ts(), `[deck${deck}] video cleared (no match for "${data.filename}")`);
        deckPaths[deck] = null;
        pendingEndedSwitch.delete(deck);
        videoEl.pause();
        videoEl.removeAttribute("src");
        videoEl.load(); // reset
      }
    }

    // ── Play/pause sync (skip while video-end switch is pending) ──
    if (!pendingEndedSwitch.has(deck)) {
      syncPlayPause(deck);
    }

    // ── Elapsed time + playback rate sync (skip while video-end switch is pending) ──
    if (deckPaths[deck] && data.video && !pendingEndedSwitch.has(deck)) {
      syncElapsedAndRate(deck, data, videoEl);
    }

    // ── Recalculate which deck is visible ──
    updatePriority();
  };

  /**
   * Synchronise elapsed time and playback rate for a deck.
   *
   * Match levels 0-1 (exact filename): sync elapsedMs from VDJ,
   * playbackRate = pitch / 100 only (BPM ratio not applied).
   *
   * Match level 2 (fuzzy filename): sync elapsedMs from VDJ,
   * playbackRate adjusted by BPM ratio + pitch.
   *
   * Match levels 3-5 (BPM/random): don't sync elapsed time (video plays
   * independently), playbackRate adjusted by BPM ratio + pitch.
   *
   * Playback rate formula:
   *   rate = (pitch / 100) × (deckBPM / videoBPM)
   *
   * If videoBPM is unknown, rate = pitch / 100
   */
  sse.onUpdate(onDeckUpdate);

  // Replay cached deck data so existing decks are shown immediately
  for (const data of Object.values(sse.decks)) {
    onDeckUpdate(data);
  }

  // ── Safety interval: re-check play/pause every 100ms ──
  const safetyInterval = setInterval(() => {
    for (const deckStr of Object.keys(deckStates)) {
      const d = Number(deckStr);
      if (!pendingEndedSwitch.has(d)) {
        syncPlayPause(d);
      }
    }
  }, 100);

  // ── Return cleanup function ──
  return () => {
    sse.offUpdate(onDeckUpdate);
    sse.offTransitionPool(onTransitionPool);
    sse.offTransitionPlay(onTransitionPlay);
    clearInterval(safetyInterval);
    // Destroy created video elements
    for (const videoEl of Object.values(deckVideos)) {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.remove();
    }
    // Destroy transition videos
    for (const buf of transBuffers) {
      buf.video.pause();
      buf.video.removeAttribute("src");
      buf.video.remove();
    }
  };
}

// ─── Utilities ──────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  // Also escape quotes for safe use in HTML attributes
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Strip file extension (e.g. ".mp4") from a filename */
function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.substring(0, i) : name;
}

// ─── Page Init Router ───────────────────────────────────

/**
 * Detect which page content is rendered and call the appropriate init.
 * Returns a cleanup function stored in currentPageCleanup.
 */
function initCurrentPage() {
  // Block mobile devices — video decode performance is insufficient
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
    document.body.innerHTML = `
      <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#030712;z-index:9999;">
        <div style="text-align:center;padding:2rem;max-width:400px;">
          <svg xmlns="http://www.w3.org/2000/svg" style="width:64px;height:64px;margin:0 auto 1.5rem;color:#6b7280;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"/>
          </svg>
          <h1 style="font-size:1.5rem;font-weight:700;color:#f3f4f6;margin-bottom:0.75rem;">Mobile Not Supported</h1>
          <p style="color:#9ca3af;line-height:1.6;">Mobile devices are not supported due to video decoding performance limitations. Please use a desktop or laptop browser.</p>
        </div>
      </div>`;
    return;
  }

  // Bind SPA links in any newly loaded content
  bindSpaLinks();

  // Settings and shutdown modals are always in the DOM (in the header)
  initSettings();
  initShutdown();
  initControlBar();

  // Sync SSE connection indicator now that the DOM is ready
  const sse = getSSE();
  updateSSEStatus(sse.connected);

  // Global config sync — always keep transition settings up to date,
  // regardless of which page is active (covers standalone /player too).
  if (!sse._globalConfigBound) {
    sse._globalConfigBound = true;

    // Helper: apply a config key/value to global variables
    function applyConfig(key, value) {
      if (key === "transition_duration") {
        const val = parseInt(value, 10);
        if (val >= 1 && val <= 10) transitionDurationMs = val * 1000;
      } else if (key === "transition_enabled") {
        transitionsEnabled = value !== "0";
      }
    }

    // SSE path (covers cross-machine sync and SharedWorker relay)
    sse.onConfig((data) => applyConfig(data.key, data.value));

    // BroadcastChannel path (reliable cross-tab sync within same browser)
    if (configBC) {
      configBC.onmessage = (e) => applyConfig(e.data.key, e.data.value);
    }

    // Eagerly load config so global vars are set before page init
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) => {
        const dur = parseInt(cfg.transition_duration, 10);
        if (dur >= 1 && dur <= 10) transitionDurationMs = dur * 1000;
        transitionsEnabled = cfg.transition_enabled !== "0";
      })
      .catch(() => {});
  }

  if (document.getElementById("deck-status")) {
    currentPageCleanup = initDashboard();
  } else if (document.getElementById("video-list")) {
    currentPageCleanup = initLibrary();
  } else if (document.getElementById("player-container")) {
    currentPageCleanup = initPlayer();
  }
}

// ─── Init ───────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Replace initial history entry so popstate works for the landing page
  history.replaceState({ spaUrl: window.location.pathname }, "");

  // Bind SPA links and init the page
  initCurrentPage();
});
