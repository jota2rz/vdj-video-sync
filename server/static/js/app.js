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
let transitionVideosEnabled = true;
let loopVideoEnabled = false;
let loopVideoPath = ""; // path of the chosen loop video
let overlayEnabled = true; // master overlay on/off toggle
let aspectRatio = "16/9"; // configurable aspect ratio (e.g. "16/9", "4/3")

/**
 * Show or hide all overlay layers (player + embedded) based on `overlayEnabled`.
 * Called when the toggle changes or config is synced.
 */
function updateOverlayVisibility() {
  const layer = document.getElementById("overlay-layer");
  const layerBehind = document.getElementById("overlay-layer-behind");
  const css = document.getElementById("overlay-player-css");
  if (layer) layer.style.display = overlayEnabled ? "" : "none";
  if (layerBehind) layerBehind.style.display = overlayEnabled ? "" : "none";
  if (css) css.disabled = !overlayEnabled;
}

// ─── Aspect Ratio + Overlay Scaling ─────────────────────

/** Reference width for overlay scaling (design target = 1080p) */
const OVERLAY_REF_WIDTH = 1920;

/**
 * Apply the current `aspectRatio` to every element with `data-aspect-ratio`
 * and to the overlay preview stage.  Also recalculates overlay scale factors.
 *
 * Preview containers (overlay, library, transitions) are wrapped in
 * `flex-1 min-h-0` parents whose height is determined by flex, not by
 * their content.  When a tall aspect ratio would make the preview exceed
 * that height, we constrain max-width so the element "contains" within
 * the available space while maintaining the correct ratio.
 */
function applyAspectRatio(ratio) {
  if (ratio) aspectRatio = ratio;
  const [aw, ah] = aspectRatio.split("/").map(Number);

  // All containers that opted-in via data attribute
  document.querySelectorAll("[data-aspect-ratio]").forEach((el) => {
    el.style.aspectRatio = aspectRatio;
    // Reset any previous max-width containment so the next measurement
    // reflects the unconstrained size.
    if (el.id !== "player-container") el.style.maxWidth = "";
  });

  // Reset dashboard master video wrapper max-width (scaleDashboardVideos
  // will recalculate it after reflow)
  const masterWrap = document.getElementById("embedded-player-wrap");
  if (masterWrap) masterWrap.style.maxWidth = "";

  // Player container — letterbox within the viewport
  const player = document.getElementById("player-container");
  if (player) {
    player.style.aspectRatio = aspectRatio;
    // Constrain width so the aspect-ratio box fits within the viewport
    if (aw && ah) {
      player.style.maxWidth = `calc(100vh * ${aw} / ${ah})`;
    }
  }

  // After reflow, check if any preview container overflows its parent and
  // apply max-width containment to fit within the available height.
  // Also rescale dashboard videos if the dashboard is active.
  requestAnimationFrame(() => {
    constrainAspectContainers(aw, ah);
    if (_scaleDashboardHook) _scaleDashboardHook();
    requestAnimationFrame(() => scaleOverlayContainers());
  });
}

/**
 * Constrain `data-aspect-ratio` preview containers so they fit within
 * their parent's height.  If the element's natural height (based on its
 * width and the current ratio) exceeds the parent's clientHeight, we set
 * a max-width so the element is shorter.  `mx-auto` on the element
 * centres it horizontally when narrower than full width.
 */
function constrainAspectContainers(aw, ah) {
  if (!aw || !ah) {
    const parts = aspectRatio.split("/").map(Number);
    aw = parts[0]; ah = parts[1];
  }
  if (!aw || !ah) return;
  document.querySelectorAll("[data-aspect-ratio]").forEach((el) => {
    if (el.id === "player-container") return;
    const parent = el.parentElement;
    if (!parent) return;
    const pH = parent.clientHeight;
    const pW = parent.clientWidth;
    if (pH > 0 && pW > 0 && el.offsetHeight > pH) {
      el.style.maxWidth = `${Math.floor(pH * aw / ah)}px`;
    }
  });
}

/**
 * Scale overlay containers so that pixel-based CSS (font sizes, fixed
 * dimensions, positions) render consistently across different preview
 * sizes and resolutions.  The overlay is authored against OVERLAY_REF_WIDTH.
 *
 * Uses the parent element's clientWidth as the reference so that the
 * element's own transform/width overrides never feed back into the
 * measurement (which was causing flicker and wrong scale on resize).
 */
function scaleOverlayContainers() {
  const targets = [
    document.getElementById("overlay-preview-container"),
    document.getElementById("overlay-layer"),
    document.getElementById("overlay-layer-behind"),
  ];
  for (const el of targets) {
    if (!el || !el.parentElement) continue;
    const w = el.parentElement.clientWidth;
    if (!w) continue;
    const scale = w / OVERLAY_REF_WIDTH;
    el.style.transform = `scale(${scale})`;
    el.style.transformOrigin = "top left";
    el.style.width = `${OVERLAY_REF_WIDTH}px`;
    el.style.height = `${Math.round(OVERLAY_REF_WIDTH * (el.parentElement.clientHeight / w))}px`;
  }
}

/** Debounced version of scaleOverlayContainers for resize events */
let _scaleResizeTimer = 0;
function scaleOverlayContainersDebounced() {
  clearTimeout(_scaleResizeTimer);
  _scaleResizeTimer = setTimeout(() => scaleOverlayContainers(), 100);
}

/**
 * Debounced recalculation of aspect-ratio containment + overlay scaling
 * on window resize.  Runs globally (safe on pages without previews — the
 * querySelectorAll simply finds nothing).
 */
let _aspectContainTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(_aspectContainTimer);
  _aspectContainTimer = setTimeout(() => {
    // Reset maxWidth, reflow, then re-constrain
    document.querySelectorAll("[data-aspect-ratio]").forEach((el) => {
      if (el.id !== "player-container") el.style.maxWidth = "";
    });
    const mw = document.getElementById("embedded-player-wrap");
    if (mw) mw.style.maxWidth = "";
    requestAnimationFrame(() => {
      constrainAspectContainers();
      if (_scaleDashboardHook) _scaleDashboardHook();
      requestAnimationFrame(() => scaleOverlayContainers());
    });
  }, 150);
});

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
    /** @type {((data: object) => void)[]} */
    this.transitionsUpdatedListeners = [];
    /** @type {((data: object) => void)[]} */
    this.overlayUpdatedListeners = [];
    /** @type {((data: object) => void)[]} */
    this.loopVideoTransitionListeners = [];
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
        case "transitions-updated":
          this.transitionsUpdatedListeners.forEach((fn) => fn(data));
          break;
        case "overlay-updated":
          this.overlayUpdatedListeners.forEach((fn) => fn(data));
          break;
        case "loop-video-transition":
          this.loopVideoTransitionListeners.forEach((fn) => fn(data));
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
      this.worker = new SharedWorker("/static/js/sse-worker.js?v=5");
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
      "config-updated", "transitions-updated", "overlay-updated",
      "loop-video-transition",
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

  /** @param {(data: object) => void} fn */
  onTransitionsUpdated(fn) {
    this.transitionsUpdatedListeners.push(fn);
  }

  /** Remove a previously registered transitions-updated listener */
  offTransitionsUpdated(fn) {
    this.transitionsUpdatedListeners = this.transitionsUpdatedListeners.filter((f) => f !== fn);
  }

  /** @param {(data: object[]) => void} fn */
  onOverlayUpdated(fn) {
    this.overlayUpdatedListeners.push(fn);
  }

  /** Remove a previously registered overlay-updated listener */
  offOverlayUpdated(fn) {
    this.overlayUpdatedListeners = this.overlayUpdatedListeners.filter((f) => f !== fn);
  }

  /** @param {(data: object) => void} fn */
  onLoopVideoTransition(fn) {
    this.loopVideoTransitionListeners.push(fn);
  }

  /** Remove a previously registered loop-video-transition listener */
  offLoopVideoTransition(fn) {
    this.loopVideoTransitionListeners = this.loopVideoTransitionListeners.filter((f) => f !== fn);
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

/** Global hook so applyAspectRatio can trigger dashboard rescaling.
 *  Set by initDashboard(), cleared on cleanup. */
let _scaleDashboardHook = null;

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
    scaleDashboardVideos();
  }

  /**
   * Scale deck-card video widths AND the Master Video wrapper so the
   * entire dashboard fits on screen without scrollbars.
   *
   * Strategy:
   *  1. Measure how much vertical space the <main> has (its clientHeight).
   *  2. Measure the fixed-height elements (headings, info bar, banner, gaps).
   *  3. From the remaining height, allocate space for:
   *     a) Deck section: deck card height + deck video (aspect-ratio driven).
   *     b) Master section: the rest.
   *  4. Compute max video widths from the available heights using the
   *     current aspect ratio, then cap widths so heights don't overflow.
   */
  function scaleDashboardVideos() {
    const mainEl = document.getElementById("spa-content");
    const container = document.getElementById("deck-status");
    const masterWrap = document.getElementById("embedded-player-wrap");
    if (!mainEl || !container) return;

    const [aw, ah] = aspectRatio.split("/").map(Number);
    if (!aw || !ah) return;

    // ── Deck video widths ──
    // Always divide by MAX_DECKS (4) so sizes stay consistent regardless
    // of how many decks are visible, with a 5% reduction for padding.
    const deckContainerW = container.offsetWidth;
    let deckVideoW = Math.floor(deckContainerW / MAX_DECKS * 0.95);

    // Measure a sample deck card (text portion) to know its fixed height
    const sampleCard = container.querySelector("[data-deck]");
    const cardH = sampleCard ? sampleCard.offsetHeight : 80;
    // matchEl + rateEl below the video (~2 lines of text + margins)
    const deckMetaH = 36;
    // Calculate how much vertical space the deck section currently has
    // (from main top to the end of the deck section, roughly):
    // Use the main's total height minus the master section's heading + info
    const mainH = mainEl.clientHeight;
    // Fixed items: deck heading (~28px + 8px mb), master heading (~28px + 8px mb),
    // player-info (~32px), padding (16px top + 16px gap + 8px mt between sections)
    const fixedH = 28 + 8 + 28 + 8 + 40 + 16 + 8;
    const availableForVideos = mainH - fixedH - cardH - deckMetaH;

    if (availableForVideos > 0) {
      // Split available height: ~40% for deck video, ~60% for master
      const deckVideoMaxH = Math.floor(availableForVideos * 0.38);
      const masterMaxH = availableForVideos - deckVideoMaxH;

      // Constrain deck video width so its height (from aspect ratio) <= deckVideoMaxH
      const deckMaxW = Math.floor(deckVideoMaxH * aw / ah);
      deckVideoW = Math.min(deckVideoW, deckMaxW);

      // Constrain master video wrapper width
      if (masterWrap) {
        const masterMaxW = Math.floor(masterMaxH * aw / ah);
        // Cap at 60% of main width for aesthetics
        const maxPercentW = Math.floor(mainEl.clientWidth * 0.6);
        masterWrap.style.maxWidth = `${Math.min(masterMaxW, maxPercentW)}px`;
      }
    }

    container.querySelectorAll('.deck-video-wrap').forEach(el => {
      el.style.width = `${deckVideoW}px`;
    });
  }

  // Register global hook for applyAspectRatio
  _scaleDashboardHook = scaleDashboardVideos;

  // Recompute video sizes on window resize
  const onResize = () => scaleDashboardVideos();
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
          <span class="deck-time ml-auto">00:00 / 00:00</span>
        </div>
      </div>
      <div class="deck-video-wrap relative mt-2 rounded-lg bg-black border border-gray-800 overflow-hidden" data-aspect-ratio style="aspect-ratio:${aspectRatio};">
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
      banner.classList.add("flex");
    } else {
      banner.classList.add("hidden");
      banner.classList.remove("flex");
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

      if (filenameEl) {
        const name = data.title || data.filename || "—";
        filenameEl.textContent = data.artist ? `${name} - ${data.artist}` : name;
      }
      if (bpmEl) bpmEl.textContent = data.bpm ? `${data.bpm.toFixed(1)} BPM` : "— BPM";
      if (volumeEl) volumeEl.textContent = `Vol: ${(data.volume * 100).toFixed(0)}%`;
      if (pitchEl) pitchEl.textContent = `Pitch: ${data.pitch.toFixed(1)}%`;

      const timeEl = card.querySelector(".deck-time");
      if (timeEl) {
        const fmt = (ms) => { const s = Math.floor((ms || 0) / 1000); const m = Math.floor(s / 60); return `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`; };
        timeEl.textContent = `${fmt(data.elapsedMs)} / ${fmt(data.totalTimeMs)}`;
      }
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
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        const vw = srcVideo.videoWidth;
        const vh = srcVideo.videoHeight;
        if (vw && vh) {
          const scale = Math.min(w / vw, h / vh);
          const dw = vw * scale;
          const dh = vh * scale;
          ctx.drawImage(srcVideo, (w - dw) / 2, (h - dh) / 2, dw, dh);
        }
      }
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

  // Ensure scaling runs after the flex layout has settled on first paint
  requestAnimationFrame(() => scaleDashboardVideos());

  // Return cleanup function
  return () => {
    _scaleDashboardHook = null;
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

  // Overlay enabled toggle
  const ovToggle = document.getElementById("overlay-enabled");
  const ovToggleKnob = ovToggle ? ovToggle.querySelector("span") : null;

  // Transition enabled toggle
  const toggle = document.getElementById("transition-enabled");
  const toggleKnob = toggle ? toggle.querySelector("span") : null;

  // Transition videos toggle
  const tvToggle = document.getElementById("transition-videos-enabled");
  const tvToggleKnob = tvToggle ? tvToggle.querySelector("span") : null;
  const tvLabel = tvToggle ? tvToggle.closest(".flex").querySelector("label") : null;

  // Loop video toggle
  const lvToggle = document.getElementById("loop-video-enabled");
  const lvToggleKnob = lvToggle ? lvToggle.querySelector("span") : null;
  const lvLabel = lvToggle ? lvToggle.closest(".flex").querySelector("label") : null;

  function setOvToggleUI(enabled) {
    if (!ovToggle) return;
    ovToggle.setAttribute("aria-checked", enabled ? "true" : "false");
    if (enabled) {
      ovToggle.classList.replace("bg-gray-600", "bg-indigo-600") || ovToggle.classList.add("bg-indigo-600");
      ovToggle.classList.remove("bg-gray-600");
      ovToggleKnob.classList.replace("translate-x-0", "translate-x-4") || ovToggleKnob.classList.add("translate-x-4");
      ovToggleKnob.classList.remove("translate-x-0");
    } else {
      ovToggle.classList.replace("bg-indigo-600", "bg-gray-600") || ovToggle.classList.add("bg-gray-600");
      ovToggle.classList.remove("bg-indigo-600");
      ovToggleKnob.classList.replace("translate-x-4", "translate-x-0") || ovToggleKnob.classList.add("translate-x-0");
      ovToggleKnob.classList.remove("translate-x-4");
    }
    // Show/hide the actual overlay layer in the player
    updateOverlayVisibility();
  }

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
    // Update Transition Videos toggle lock state
    updateTvToggleLock();
  }

  function setTvToggleUI(enabled) {
    if (!tvToggle) return;
    tvToggle.setAttribute("aria-checked", enabled ? "true" : "false");
    if (enabled) {
      tvToggle.classList.replace("bg-gray-600", "bg-indigo-600") || tvToggle.classList.add("bg-indigo-600");
      tvToggle.classList.remove("bg-gray-600");
      tvToggleKnob.classList.replace("translate-x-0", "translate-x-4") || tvToggleKnob.classList.add("translate-x-4");
      tvToggleKnob.classList.remove("translate-x-0");
    } else {
      tvToggle.classList.replace("bg-indigo-600", "bg-gray-600") || tvToggle.classList.add("bg-gray-600");
      tvToggle.classList.remove("bg-indigo-600");
      tvToggleKnob.classList.replace("translate-x-4", "translate-x-0") || tvToggleKnob.classList.add("translate-x-0");
      tvToggleKnob.classList.remove("translate-x-4");
    }
  }

  /** Lock/unlock the Transition Videos toggle based on Transitions master toggle */
  function updateTvToggleLock() {
    if (!tvToggle) return;
    if (!transitionsEnabled) {
      tvToggle.classList.add("opacity-40", "cursor-not-allowed");
      tvToggle.classList.remove("cursor-pointer");
      if (tvLabel) tvLabel.classList.add("opacity-40");
    } else {
      tvToggle.classList.remove("opacity-40", "cursor-not-allowed");
      tvToggle.classList.add("cursor-pointer");
      if (tvLabel) tvLabel.classList.remove("opacity-40");
    }
  }

  function setLvToggleUI(enabled) {
    if (!lvToggle) return;
    lvToggle.setAttribute("aria-checked", enabled ? "true" : "false");
    if (enabled) {
      lvToggle.classList.replace("bg-gray-600", "bg-emerald-600") || lvToggle.classList.add("bg-emerald-600");
      lvToggle.classList.remove("bg-gray-600");
      lvToggleKnob.classList.replace("translate-x-0", "translate-x-4") || lvToggleKnob.classList.add("translate-x-4");
      lvToggleKnob.classList.remove("translate-x-0");
    } else {
      lvToggle.classList.replace("bg-emerald-600", "bg-gray-600") || lvToggle.classList.add("bg-gray-600");
      lvToggle.classList.remove("bg-emerald-600");
      lvToggleKnob.classList.replace("translate-x-4", "translate-x-0") || lvToggleKnob.classList.add("translate-x-0");
      lvToggleKnob.classList.remove("translate-x-4");
    }
  }

  /** Lock/unlock loop video toggle when no loop video is set */
  function updateLvToggleLock() {
    if (!lvToggle) return;
    if (!loopVideoPath) {
      lvToggle.classList.add("opacity-40", "cursor-not-allowed");
      lvToggle.classList.remove("cursor-pointer");
      if (lvLabel) lvLabel.classList.add("opacity-40");
    } else {
      lvToggle.classList.remove("opacity-40", "cursor-not-allowed");
      lvToggle.classList.add("cursor-pointer");
      if (lvLabel) lvLabel.classList.remove("opacity-40");
    }
    updateLvWarning();
  }

  /** Show/hide the loop video warning banner */
  function updateLvWarning() {
    const warning = document.getElementById("loop-video-warning");
    if (!warning) return;
    if (loopVideoEnabled && !loopVideoPath) {
      warning.classList.remove("hidden");
      warning.classList.add("flex");
    } else {
      warning.classList.add("hidden");
      warning.classList.remove("flex");
    }
  }

  if (ovToggle) {
    ovToggle.addEventListener("click", () => {
      overlayEnabled = !overlayEnabled;
      setOvToggleUI(overlayEnabled);
      const val = overlayEnabled ? "1" : "0";
      if (configBC) configBC.postMessage({ key: "overlay_enabled", value: val });
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "overlay_enabled", value: val }),
      }).catch((err) => console.error(ts(), "[controlbar] save error:", err));
    });
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

  if (tvToggle) {
    tvToggle.addEventListener("click", () => {
      // Locked when transitions are disabled
      if (!transitionsEnabled) return;
      transitionVideosEnabled = !transitionVideosEnabled;
      setTvToggleUI(transitionVideosEnabled);
      const val = transitionVideosEnabled ? "1" : "0";
      if (configBC) configBC.postMessage({ key: "transition_videos_enabled", value: val });
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "transition_videos_enabled", value: val }),
      }).catch((err) => console.error(ts(), "[controlbar] save error:", err));
    });
  }

  if (lvToggle) {
    lvToggle.addEventListener("click", () => {
      // Locked when no loop video is configured
      if (!loopVideoPath) return;
      loopVideoEnabled = !loopVideoEnabled;
      setLvToggleUI(loopVideoEnabled);
      updateLvWarning();
      const val = loopVideoEnabled ? "1" : "0";
      if (configBC) configBC.postMessage({ key: "loop_video_enabled", value: val });
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "loop_video_enabled", value: val }),
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
      overlayEnabled = cfg.overlay_enabled !== "0";
      setOvToggleUI(overlayEnabled);
      transitionsEnabled = cfg.transition_enabled !== "0";
      setToggleUI(transitionsEnabled);
      transitionVideosEnabled = cfg.transition_videos_enabled !== "0";
      setTvToggleUI(transitionVideosEnabled);
      updateTvToggleLock();
      loopVideoPath = cfg.loop_video || "";
      loopVideoEnabled = cfg.loop_video_enabled === "1" && !!loopVideoPath;
      setLvToggleUI(loopVideoEnabled);
      updateLvToggleLock();
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
    } else if (data.key === "transition_videos_enabled") {
      transitionVideosEnabled = data.value !== "0";
      setTvToggleUI(transitionVideosEnabled);
      updateTvToggleLock();
    } else if (data.key === "loop_video") {
      loopVideoPath = data.value || "";
      updateLvToggleLock();
      // If loop video was removed while enabled, disable it
      if (!loopVideoPath && loopVideoEnabled) {
        loopVideoEnabled = false;
        setLvToggleUI(false);
      }
      updateLvWarning();
    } else if (data.key === "loop_video_enabled") {
      loopVideoEnabled = data.value === "1" && !!loopVideoPath;
      setLvToggleUI(loopVideoEnabled);
      updateLvWarning();
    } else if (data.key === "overlay_enabled") {
      overlayEnabled = data.value !== "0";
      setOvToggleUI(overlayEnabled);
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
  const loopBtn = document.getElementById("set-loop-video-btn");

  /** Show/hide the force and loop buttons based on active tab */
  function updateForceButton() {
    if (!forceBtn) return;
    const deckBtns = document.getElementById("force-deck-btns");
    if (activeLibraryTab === "song") {
      forceBtn.classList.remove("hidden");
      forceBtn.disabled = !forceBtn.dataset.path;
      if (loopBtn) {
        loopBtn.classList.remove("hidden");
        loopBtn.disabled = !forceBtn.dataset.path;
        // Update button text based on whether selected video is already the loop video
        if (forceBtn.dataset.path && forceBtn.dataset.path === loopVideoPath) {
          loopBtn.textContent = "Unset Loop Video";
          loopBtn.classList.remove("bg-emerald-600", "hover:bg-emerald-500");
          loopBtn.classList.add("bg-red-600", "hover:bg-red-500");
        } else {
          loopBtn.textContent = "Set Loop Video";
          loopBtn.classList.remove("bg-red-600", "hover:bg-red-500");
          loopBtn.classList.add("bg-emerald-600", "hover:bg-emerald-500");
        }
      }
      if (deckBtns) {
        deckBtns.classList.remove("hidden");
        deckBtns.querySelectorAll("[data-force-deck]").forEach((btn) => {
          btn.disabled = !forceBtn.dataset.path;
        });
      }
    } else {
      forceBtn.classList.add("hidden");
      if (loopBtn) loopBtn.classList.add("hidden");
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
  updateLibraryWarning();

  // Auto-refresh when server detects file changes via SSE
  const sse = getSSE();
  const onLibraryUpdated = (data) => {
    // Refresh if the updated type matches the active tab, or refresh both
    if (!data.type || data.type === activeLibraryTab) {
      loadVideoList(activeLibraryTab);
    }
    updateLibraryWarning();
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

  // Set Loop Video button handler
  if (loopBtn) {
    loopBtn.addEventListener("click", () => {
      const path = forceBtn?.dataset.path;
      if (!path) return;
      loopBtn.disabled = true;

      // Toggle: if clicked video is already the loop, unset it
      const newLoopPath = path === loopVideoPath ? "" : path;
      loopVideoPath = newLoopPath;

      // Save to config
      if (configBC) configBC.postMessage({ key: "loop_video", value: newLoopPath });
      fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "loop_video", value: newLoopPath }),
      })
        .then(() => {
          console.log(ts(), "[library] loop video set:", newLoopPath || "(none)");
          loopBtn.textContent = newLoopPath ? "Loop Set!" : "Loop Unset!";
          setTimeout(() => {
            updateForceButton();
            loopBtn.disabled = false;
          }, 1000);
          // Refresh list to show/hide loop icon
          loadVideoList(activeLibraryTab);
        })
        .catch((err) => {
          console.error(ts(), "[library] set loop video error:", err.message);
          loopBtn.disabled = false;
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

function updateLibraryWarning() {
  const banner = document.getElementById("library-warning");
  const text = document.getElementById("library-warning-text");
  if (!banner || !text) return;

  Promise.all([
    fetch("/api/videos").then((r) => r.json()),
    fetch("/api/videos?type=transition").then((r) => r.json()),
  ])
    .then(([songVideos, transVideos]) => {
      const noSong = !songVideos || songVideos.length === 0;
      const noTrans = !transVideos || transVideos.length === 0;
      if (noSong && noTrans) {
        text.textContent = "No song videos or transition videos found. Add video files to the configured directories.";
        banner.classList.remove("hidden");
        banner.classList.add("flex");
      } else if (noSong) {
        text.textContent = "No song videos found. Deck playback will have no video content.";
        banner.classList.remove("hidden");
        banner.classList.add("flex");
      } else if (noTrans) {
        text.textContent = "No transition videos found. Deck switches will play without a transition overlay.";
        banner.classList.remove("hidden");
        banner.classList.add("flex");
      } else {
        banner.classList.add("hidden");
        banner.classList.remove("flex");
      }
    })
    .catch(() => {});
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

      const loopIconSvg = `<svg class="h-4 w-4 shrink-0 text-emerald-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" title="Loop Video"><path d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.451a.75.75 0 0 0 0-1.5H4.5a.75.75 0 0 0-.75.75v3.75a.75.75 0 0 0 1.5 0v-2.033a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm-11.073-3.85a.75.75 0 0 0 1.45.388 5.5 5.5 0 0 1 9.2-2.465l.312.31H12.75a.75.75 0 0 0 0 1.501H16.5a.75.75 0 0 0 .75-.75V2.757a.75.75 0 0 0-1.5 0v2.033A7 7 0 0 0 4.039 7.924l.2-.35Z"/></svg>`;

      container.innerHTML = videos
        .map(
          (v) => {
            const isLoop = type === "song" && v.path === loopVideoPath;
            return `
          <div class="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-800 transition-colors" data-video-name="${escapeHtml(v.name)}" data-video-path="${escapeHtml(v.path)}">
            <div class="min-w-0">
              <p class="text-sm text-gray-200 truncate">${escapeHtml(stripExt(v.name))}</p>
              ${v.bpm ? `<span class="text-xs text-gray-500">${v.bpm} BPM</span>` : ""}
            </div>
            ${isLoop ? loopIconSvg : ""}
          </div>`;
          }
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
    // Also enable loop button and update its state
    const loopBtn = document.getElementById("set-loop-video-btn");
    if (loopBtn && !loopBtn.classList.contains("hidden")) {
      loopBtn.disabled = false;
      if (path === loopVideoPath) {
        loopBtn.textContent = "Unset Loop Video";
        loopBtn.classList.remove("bg-emerald-600", "hover:bg-emerald-500");
        loopBtn.classList.add("bg-red-600", "hover:bg-red-500");
      } else {
        loopBtn.textContent = "Set Loop Video";
        loopBtn.classList.remove("bg-red-600", "hover:bg-red-500");
        loopBtn.classList.add("bg-emerald-600", "hover:bg-emerald-500");
      }
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

  // ── Loop video system ──
  let loopVideoEl = null; // <video> element for the loop video
  let loopVideoActive = false; // true when loop video is currently visible
  let loopVideoLoadedPath = ""; // currently loaded loop video path

  // ── Overlay system ──
  let overlayElements = []; // enabled overlay elements from server
  let overlayLayer = null;  // <div> container for overlay elements (above transitions, z-index:100)
  let overlayLayerBehind = null; // <div> container for overlay elements behind transitions (z-index:10)
  let overlayStyleEl = null; // <style> tag for overlay CSS

  // Create overlay layer behind transitions (z-index 16, above deck videos z=10/loop z=15, below transition video z=20)
  overlayLayerBehind = document.createElement("div");
  overlayLayerBehind.id = "overlay-layer-behind";
  overlayLayerBehind.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:16;";
  if (!overlayEnabled) overlayLayerBehind.style.display = "none";
  container.appendChild(overlayLayerBehind);

  // Create overlay layer above transitions (z-index 100, above transition video z-index 20)
  overlayLayer = document.createElement("div");
  overlayLayer.id = "overlay-layer";
  overlayLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:100;";
  if (!overlayEnabled) overlayLayer.style.display = "none";
  container.appendChild(overlayLayer);

  overlayStyleEl = document.createElement("style");
  overlayStyleEl.id = "overlay-player-css";
  if (!overlayEnabled) overlayStyleEl.disabled = true;
  container.appendChild(overlayStyleEl);

  /** Load enabled overlay elements from server and render them */
  function loadOverlayElements(data) {
    // data can be either an array from SSE or null (initial load via fetch)
    if (Array.isArray(data)) {
      overlayElements = data.filter((e) => e.enabled);
    } else {
      overlayElements = data || [];
    }
    renderOverlayLayer();
  }

  /** Render the overlay layers — split elements by showOverTransition flag */
  function renderOverlayLayer() {
    if (!overlayLayer || !overlayLayerBehind) return;
    overlayLayer.innerHTML = "";
    overlayLayerBehind.innerHTML = "";
    let css = "";
    for (const el of overlayElements) {
      css += el.css + "\n";
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-overlay-key", el.key);
      wrapper.innerHTML = el.html;
      if (el.showOverTransition === false) {
        overlayLayerBehind.appendChild(wrapper);
      } else {
        overlayLayer.appendChild(wrapper);
      }
    }
    if (overlayStyleEl) overlayStyleEl.textContent = css;

    // Scale overlay elements to match the player container size (double-rAF for reflow)
    requestAnimationFrame(() => requestAnimationFrame(() => scaleOverlayContainers()));
  }

  /** Deferred deck data for behind-layer overlays during transitions */
  let pendingBehindDeckData = null;

  /** Update overlay element JS with current deck data */
  function updateOverlayData(deckData) {
    if (overlayElements.length === 0) return;
    if (overlayLayer) runOverlayJS(overlayLayer, overlayElements, deckData);
    if (overlayLayerBehind) {
      if (transitionVideosEnabled && transitionInProgress) {
        pendingBehindDeckData = deckData;
      } else {
        runOverlayJS(overlayLayerBehind, overlayElements, deckData);
      }
    }
  }

  /** Flush deferred behind-layer overlay update after transition ends */
  function flushPendingBehindOverlay() {
    if (pendingBehindDeckData && overlayLayerBehind) {
      runOverlayJS(overlayLayerBehind, overlayElements, pendingBehindDeckData);
      pendingBehindDeckData = null;
    }
  }

  // Fetch initial overlay elements
  fetch("/api/overlays")
    .then((r) => r.json())
    .then((elements) => {
      overlayElements = (elements || []).filter((e) => e.enabled);
      renderOverlayLayer();
    })
    .catch((err) => console.error(ts(), "[player] overlay load error:", err));

  // Listen for overlay updates via SSE
  const onOverlayUpdated = (data) => loadOverlayElements(data);
  sse.onOverlayUpdated(onOverlayUpdated);

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
  /** Pending CSS effects from the server's transition-play event */
  let pendingInCSS = "";
  let pendingOutCSS = "";
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
        // Don't replace a buffer that a transition is actively playing —
        // this would reset readyState and freeze the video at frame 0.
        if (idx === playingBufferIdx) {
          console.log(ts(), `[player] skipping buffer ${idx} source swap (in use by transition)`);
          return;
        }
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
    // The server tells us which slot to play and which CSS effects to use.
    // The actual deck switch is detected client-side by updatePriority(),
    // which calls playTransition().  We record the slot and effects.
    if (data?.slot !== undefined) {
      pendingPlaySlot = data.slot;
      pendingInCSS = data.inCSS || "";
      pendingOutCSS = data.outCSS || "";
      console.log(ts(), `[player] server says play slot ${data.slot} (inCSS=${!!data.inCSS}, outCSS=${!!data.outCSS})`);
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
   * Play the transition video on top, swapping decks underneath.
   * Falls back to an instant swap when no buffer is ready.
   * If a buffer is loading, waits up to 2s.
   *
   * If a transition is already in progress, the request is queued
   * (latest wins — at most 1 pending).  The queued transition replays
   * automatically after the current one finishes.
   */
  let queuedTransition = null; // { newDeck, swapFn }

  function playTransition(newDeck, swapFn) {
    if (!transitionsEnabled) {
      console.log(ts(), "[player] transition skipped (disabled)");
      pendingPlaySlot = null;
      pendingInCSS = "";
      pendingOutCSS = "";
      swapFn();
      return;
    }

    // Transition videos disabled — run CSS effects only (no video overlay)
    if (!transitionVideosEnabled) {
      if (transitionInProgress) {
        queuedTransition = { newDeck, swapFn };
        console.log(ts(), `[player] effects-only transition queued (deck ${newDeck})`);
        return;
      }
      executeEffectsOnly(newDeck, swapFn);
      return;
    }

    if (transitionInProgress) {
      // Queue this request — latest wins.  Don't swap decks now because
      // the transition video may be semi-transparent ("out" phase).
      // Don't snapshot slot/CSS — pendingPlaySlot is deterministic from
      // the SSE event and will be consumed when the queue drains.
      queuedTransition = { newDeck, swapFn };
      console.log(ts(), `[player] transition queued (deck ${newDeck}) — current still in progress`);
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
              pendingPlaySlot = null;
              pendingInCSS = "";
              pendingOutCSS = "";
              applyDeferredPool();
              swapFn();
            }
          }
        }, 50);
        return;
      }

      console.log(ts(), `[player] transition skipped (buf0=${transBuffers[0].video.readyState}, buf1=${transBuffers[1].video.readyState}, buf2=${transBuffers[2].video.readyState})`);
      pendingPlaySlot = null;
      pendingInCSS = "";
      pendingOutCSS = "";
      applyDeferredPool();
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

    // Capture and consume CSS effects for this transition
    const inCSS = pendingInCSS;
    const outCSS = pendingOutCSS;
    pendingInCSS = "";
    pendingOutCSS = "";

    // ── Phase durations ──
    // 15% in effect → 70% hold (video plays unadorned) → 15% out effect.
    // The deck swap happens right after the "in" effect finishes.
    // If only one phase has an effect, it keeps its 15% share; the
    // hold period absorbs the missing phase's 15%.
    const hasIn = !!inCSS;
    const hasOut = !!outCSS;
    const inMs   = hasIn  ? transitionDurationMs * 0.15 : 0;
    const outMs  = hasOut ? transitionDurationMs * 0.15 : 0;
    const holdMs = transitionDurationMs - inMs - outMs;
    const inSec  = (inMs  / 1000).toFixed(2);
    const outSec = (outMs / 1000).toFixed(2);

    // Bring chosen transition video on top of deck videos
    tv.style.zIndex = "20";

    // ── Inject CSS effect style element ──
    let fxStyle = null;
    if (hasIn || hasOut) {
      fxStyle = document.createElement("style");
      fxStyle.id = "transition-live-fx";
      document.head.appendChild(fxStyle);
    }

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
    console.log(ts(), `[player] transition playing from buffer ${chosenIdx} (rate=${rate.toFixed(2)}, in=${inSec}s, hold=${(holdMs/1000).toFixed(2)}s, out=${outSec}s)`);

    // Seek to start and play
    tv.currentTime = 0;
    tv.play().then(() => {
      console.log(ts(), "[player] transition started");
    }).catch((err) => {
      console.warn(ts(), "[player] transition play() failed:", err.message);
    });

    // ── Deck swap tracking ──
    let swapDone = false;
    function ensureSwap() {
      if (!swapDone) { swapDone = true; swapFn(); }
    }

    /** Clean up everything after the transition ends */
    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      ensureSwap(); // guarantee deck swap happened
      tv.classList.remove("transition-active");
      if (fxStyle) fxStyle.remove();
      tv.style.zIndex = "-1";
      tv.pause();
      transitionInProgress = false;
      playingBufferIdx = -1;
      if (onTransitionChange) onTransitionChange({ inProgress: false, rate: 0 });
      flushPendingBehindOverlay();
      applyDeferredPool();
      // If another transition was queued, replay it now
      if (queuedTransition) {
        const q = queuedTransition;
        queuedTransition = null;
        console.log(ts(), `[player] draining queued transition (deck ${q.newDeck})`);
        playTransition(q.newDeck, q.swapFn);
      }
    }

    /** Start the "out" phase: swap decks (now invisible behind opaque
     *  transition video), then animate the transition video away. */
    let outStarted = false;
    function startOutPhase() {
      if (outStarted || cleaned) return;
      outStarted = true;
      // Swap the master video while fully hidden behind transition
      ensureSwap();
      // Transition video fully covers the screen — safe to update behind-layer overlays
      flushPendingBehindOverlay();
      console.log(ts(), "[player] decks swapped (hidden behind transition)");

      // Remove "in" class (if any) now that "in" is done
      tv.classList.remove("transition-active");
      if (fxStyle) fxStyle.textContent = "";

      // After the hold period, start the "out" effect (or clean up)
      setTimeout(() => {
        if (cleaned) return;
        if (hasOut) {
          // Inject "out" CSS and trigger animation
          fxStyle.textContent = outCSS.replace(/var\(--transition-duration\)/g, `${outSec}s`);
          void tv.offsetWidth; // force reflow
          tv.classList.add("transition-active");

          // Listen for the "out" animation to finish
          const onOutEnd = () => {
            tv.removeEventListener("animationend", onOutEnd);
            cleanup();
          };
          tv.addEventListener("animationend", onOutEnd);
          // Safety timeout in case animationend doesn't fire
          setTimeout(() => {
            tv.removeEventListener("animationend", onOutEnd);
            cleanup();
          }, outMs + 500);
        } else {
          cleanup();
        }
      }, holdMs);
    }

    // ── "In" phase: animate the transition video into view ──
    if (hasIn) {
      fxStyle.textContent = inCSS.replace(/var\(--transition-duration\)/g, `${inSec}s`);
      tv.classList.add("transition-active");

      // Wait for the "in" animation to finish before swapping decks
      const onInEnd = () => {
        tv.removeEventListener("animationend", onInEnd);
        console.log(ts(), "[player] 'in' effect finished");
        startOutPhase();
      };
      tv.addEventListener("animationend", onInEnd);
      // Safety timeout in case animationend doesn't fire
      setTimeout(() => {
        if (cleaned) return;
        tv.removeEventListener("animationend", onInEnd);
        startOutPhase();
      }, inMs + 500);
    } else {
      // No "in" effect — swap immediately and go to "out" phase
      startOutPhase();
    }
  }

  /**
   * Effects-only transition: no transition video overlay.
   * Applies only the "in" CSS effect to the container as the deck swaps.
   * Used when transition videos are disabled but transitions are enabled.
   */
  function executeEffectsOnly(newDeck, swapFn) {
    transitionInProgress = true;
    pendingPlaySlot = null;

    pendingInCSS = ""; // discard — no "in" phase for effects-only
    const outCSS = pendingOutCSS;
    pendingOutCSS = "";

    const hasOut = !!outCSS;
    const outMs = hasOut ? transitionDurationMs : 0;
    const outSec = (outMs / 1000).toFixed(2);

    if (onTransitionChange) onTransitionChange({ inProgress: true, rate: 0 });

    // Old deck stays on top; new deck plays behind it.
    // NOTE: activeDeck may already be updated to newDeck by updatePriority(),
    // so we find the old deck from the DOM — it's the currently-visible deck
    // that isn't the new one.
    let oldDeckVideo = null;
    for (const [dStr, vEl] of Object.entries(deckVideos)) {
      if (Number(dStr) !== newDeck && vEl.style.visibility === "visible") {
        oldDeckVideo = vEl;
        break;
      }
    }
    const newDeckVideo = deckVideos[newDeck];

    console.log(ts(), `[player] effects-only transition (deck ${newDeck}, oldDeck=${oldDeckVideo?.id || 'none'}, out=${outSec}s)`);

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (oldDeckVideo) oldDeckVideo.classList.remove("transition-active");
      const oldFx = document.getElementById("transition-live-fx");
      if (oldFx) oldFx.remove();
      // Finalize the swap now that the effect has completed
      swapFn();
      transitionInProgress = false;
      if (onTransitionChange) onTransitionChange({ inProgress: false, rate: 0 });
      flushPendingBehindOverlay();
      applyDeferredPool();
      if (queuedTransition) {
        const q = queuedTransition;
        queuedTransition = null;
        console.log(ts(), `[player] draining queued transition (deck ${q.newDeck})`);
        playTransition(q.newDeck, q.swapFn);
      }
    }

    if (hasOut && oldDeckVideo) {
      // Make new deck visible behind old deck (z=0 < old deck z=10)
      if (newDeckVideo) {
        newDeckVideo.style.zIndex = "0";
        newDeckVideo.style.visibility = "visible";
      }

      // Apply "out" CSS effect to old deck — it fades/dissolves away
      // revealing the new deck underneath
      const fxStyle = document.createElement("style");
      fxStyle.id = "transition-live-fx";
      document.head.appendChild(fxStyle);
      fxStyle.textContent = outCSS.replace(/var\(--transition-duration\)/g, `${outSec}s`);
      void oldDeckVideo.offsetWidth; // force reflow
      oldDeckVideo.classList.add("transition-active");

      const onOutEnd = () => {
        oldDeckVideo.removeEventListener("animationend", onOutEnd);
        cleanup();
      };
      oldDeckVideo.addEventListener("animationend", onOutEnd);
      // Safety timeout
      setTimeout(() => {
        oldDeckVideo.removeEventListener("animationend", onOutEnd);
        cleanup();
      }, outMs + 500);
    } else {
      // No effect — swap immediately
      cleanup();
    }
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
        updateOverlayData({});
      }
      if (noVideo) noVideo.classList.remove("hidden");
    }
  }

  // ── Loop Video ──

  /** Get or create the dedicated loop video element */
  function getLoopVideoEl() {
    if (loopVideoEl) return loopVideoEl;
    const v = document.createElement("video");
    v.id = "loop-video";
    v.muted = true;
    v.setAttribute("muted", "");
    v.autoplay = false;
    v.playsInline = true;
    v.disablePictureInPicture = true;
    v.loop = true;
    v.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:black;";
    v.style.zIndex = "15"; // above decks (z=10), below transitions (z=20)
    v.style.visibility = "hidden";
    container.appendChild(v);
    loopVideoEl = v;
    return v;
  }

  /** Show loop video with a transition.
   *  @param {string} [inCSS] - Server-provided "in" CSS effect. If omitted, shows instantly (page load). */
  function activateLoopVideo(inCSS) {
    if (loopVideoActive) return;
    if (!loopVideoPath) return;
    loopVideoActive = true;

    const lv = getLoopVideoEl();

    // Load the video if not already loaded
    if (loopVideoLoadedPath !== loopVideoPath) {
      lv.src = loopVideoPath;
      lv.load();
      loopVideoLoadedPath = loopVideoPath;
    }

    console.log(ts(), "[player] activating loop video:", loopVideoPath);

    // Play it
    lv.currentTime = 0;
    lv.play().catch(() => {});

    // Use transition effect if CSS was provided by the server
    if (transitionsEnabled && inCSS) {
      const durSec = (transitionDurationMs / 1000).toFixed(2);
      const css = inCSS.replace(/var\(--transition-duration\)/g, `${durSec}s`);
      const fxStyle = document.createElement("style");
      fxStyle.id = "loop-video-fx";
      document.head.appendChild(fxStyle);
      fxStyle.textContent = css;
      void lv.offsetWidth;
      lv.style.visibility = "visible";
      lv.classList.add("transition-active");
      const onEnd = () => {
        lv.removeEventListener("animationend", onEnd);
        lv.classList.remove("transition-active");
        fxStyle.remove();
      };
      lv.addEventListener("animationend", onEnd);
      setTimeout(() => {
        lv.removeEventListener("animationend", onEnd);
        lv.classList.remove("transition-active");
        fxStyle.remove();
      }, transitionDurationMs + 500);
    } else {
      lv.style.visibility = "visible";
    }
    if (noVideo) noVideo.classList.add("hidden");
  }

  /** Hide loop video with a transition.
   *  @param {string} [outCSS] - Server-provided "out" CSS effect. If omitted, hides instantly. */
  function deactivateLoopVideo(outCSS) {
    if (!loopVideoActive) return;
    loopVideoActive = false;
    const lv = loopVideoEl;
    if (!lv) return;

    console.log(ts(), "[player] deactivating loop video");

    if (transitionsEnabled && outCSS) {
      const durSec = (transitionDurationMs / 1000).toFixed(2);
      const css = outCSS.replace(/var\(--transition-duration\)/g, `${durSec}s`);
      const fxStyle = document.createElement("style");
      fxStyle.id = "loop-video-fx";
      document.head.appendChild(fxStyle);
      fxStyle.textContent = css;
      void lv.offsetWidth;
      lv.classList.add("transition-active");
      const onEnd = () => {
        lv.removeEventListener("animationend", onEnd);
        lv.classList.remove("transition-active");
        fxStyle.remove();
        lv.style.visibility = "hidden";
        lv.pause();
      };
      lv.addEventListener("animationend", onEnd);
      setTimeout(() => {
        lv.removeEventListener("animationend", onEnd);
        lv.classList.remove("transition-active");
        fxStyle.remove();
        lv.style.visibility = "hidden";
        lv.pause();
      }, transitionDurationMs + 500);
    } else {
      lv.style.visibility = "hidden";
      lv.pause();
    }
  }

  /** React to loop_video_enabled config changes */
  function checkLoopVideoState() {
    if (loopVideoEnabled && loopVideoPath) {
      activateLoopVideo();
    } else {
      deactivateLoopVideo();
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
    // When loop video is active, deck priority still updates internally
    // but doesn't trigger transitions — the loop video stays on top.
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

    // Deck-to-deck switch → play transition (but not when loop video covers everything)
    if (bestDeck !== null && activeDeck !== null) {
      if (loopVideoActive) {
        // Loop video is on top — just swap silently underneath
        console.log(ts(), `[player] deck-to-deck swap (silent — loop video active)`);
        applyDeckSwap(bestDeck);
        return;
      }
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

    // ── Update overlay elements with active deck data ──
    if (deck === activeDeck) {
      // If the active deck is not audible+playing, send empty data so overlays fade out
      if (data.isAudible && data.isPlaying) {
        updateOverlayData(data);
      } else {
        updateOverlayData({});
      }
    }
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

  // ── Loop video config listener (path changes only) ──
  const onLoopConfigUpdate = (data) => {
    if (data.key === "loop_video") {
      // Global vars are already updated by the global applyConfig handler.
      // Just react to the path change here (reload video if needed).
      checkLoopVideoState();
    }
  };
  sse.onConfig(onLoopConfigUpdate);

  // ── Loop video transition SSE listener (server-chosen effects) ──
  const onLoopVideoTransition = (data) => {
    if (data.action === "activate") {
      activateLoopVideo(data.inCSS);
    } else {
      deactivateLoopVideo(data.outCSS);
    }
  };
  sse.onLoopVideoTransition(onLoopVideoTransition);

  // Also listen on BroadcastChannel (same-browser cross-tab)
  let prevBcHandler = null;
  if (configBC) {
    prevBcHandler = configBC.onmessage;
    configBC.onmessage = (e) => {
      if (prevBcHandler) prevBcHandler(e);
      if (e.data.key === "loop_video") {
        checkLoopVideoState();
      }
    };
  }

  // Activate loop video if it was already enabled on page load
  if (loopVideoEnabled && loopVideoPath) {
    activateLoopVideo();
  }

  // Rescale overlay layer on window resize
  const onResizePlayer = () => scaleOverlayContainersDebounced();
  window.addEventListener("resize", onResizePlayer);

  // ── Return cleanup function ──
  return () => {
    sse.offUpdate(onDeckUpdate);
    sse.offTransitionPool(onTransitionPool);
    sse.offTransitionPlay(onTransitionPlay);
    sse.offConfig(onLoopConfigUpdate);
    sse.offLoopVideoTransition(onLoopVideoTransition);
    sse.offOverlayUpdated(onOverlayUpdated);
    window.removeEventListener("resize", onResizePlayer);
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
    // Destroy loop video
    if (loopVideoEl) {
      loopVideoEl.pause();
      loopVideoEl.removeAttribute("src");
      loopVideoEl.remove();
      loopVideoEl = null;
      loopVideoActive = false;
      loopVideoLoadedPath = "";
    }
    // Destroy overlay layer
    if (overlayLayer) {
      overlayLayer.remove();
      overlayLayer = null;
    }
    if (overlayStyleEl) {
      overlayStyleEl.remove();
      overlayStyleEl = null;
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

// ─── Overlay Page ───────────────────────────────────────

function initOverlay() {
  const listEl = document.getElementById("overlay-list");
  const previewContainer = document.getElementById("overlay-preview-container");
  const previewCss = document.getElementById("overlay-preview-css");
  const previewVideo = document.getElementById("overlay-preview-video");
  const previewPlaceholder = document.getElementById("overlay-preview-placeholder");
  const modal = document.getElementById("overlay-modal");
  const modalBackdrop = document.getElementById("overlay-modal-backdrop");
  const modalClose = document.getElementById("overlay-modal-close");
  const modalCancel = document.getElementById("overlay-modal-cancel");
  const modalSave = document.getElementById("overlay-modal-save");
  const modalRestore = document.getElementById("overlay-modal-restore");
  const modalTitle = document.getElementById("overlay-modal-title");
  const inputName = document.getElementById("overlay-name");
  const inputCss = document.getElementById("overlay-css");
  const inputHtml = document.getElementById("overlay-html");
  const inputJs = document.getElementById("overlay-js");
  const editId = document.getElementById("overlay-edit-id");
  const editKey = document.getElementById("overlay-edit-key");
  const configSection = document.getElementById("overlay-config-section");
  const configText = document.getElementById("overlay-config-text");
  const configLogo = document.getElementById("overlay-config-logo");
  const configLogoFile = document.getElementById("overlay-config-logo-file");
  const configLogoPreview = document.getElementById("overlay-config-logo-preview");
  const configLogoUrl = document.getElementById("overlay-config-logo-url");
  const configLogoStatus = document.getElementById("overlay-config-logo-status");
  const showOverTransitionBtn = document.getElementById("overlay-show-over-transition");
  let showOverTransitionValue = true;

  // Toggle handler for "Show over Transition Video"
  function setShowOverTransitionUI(on) {
    showOverTransitionValue = on;
    if (showOverTransitionBtn) {
      showOverTransitionBtn.setAttribute("aria-checked", on ? "true" : "false");
      if (on) {
        showOverTransitionBtn.classList.replace("bg-gray-600", "bg-indigo-600") || showOverTransitionBtn.classList.add("bg-indigo-600");
        showOverTransitionBtn.classList.remove("bg-gray-600");
      } else {
        showOverTransitionBtn.classList.replace("bg-indigo-600", "bg-gray-600") || showOverTransitionBtn.classList.add("bg-gray-600");
        showOverTransitionBtn.classList.remove("bg-indigo-600");
      }
      const dot = showOverTransitionBtn.querySelector("span");
      if (dot) {
        if (on) {
          dot.classList.replace("translate-x-0", "translate-x-5") || dot.classList.add("translate-x-5");
          dot.classList.remove("translate-x-0");
        } else {
          dot.classList.replace("translate-x-5", "translate-x-0") || dot.classList.add("translate-x-0");
          dot.classList.remove("translate-x-5");
        }
      }
    }
  }
  if (showOverTransitionBtn) {
    showOverTransitionBtn.addEventListener("click", () => {
      setShowOverTransitionUI(!showOverTransitionValue);
    });
  }

  let elements = [];

  // ── Load preview video ──
  async function loadPreviewVideo() {
    try {
      const res = await fetch("/api/videos");
      const videos = await res.json();
      if (videos && videos.length > 0) {
        const v = videos[Math.floor(Math.random() * videos.length)];
        previewVideo.src = v.path;
        previewVideo.currentTime = 0;
        previewPlaceholder.classList.add("hidden");
        try { await previewVideo.play(); } catch (_) {}
      }
    } catch (err) {
      console.error(ts(), "[overlay] preview video error:", err);
    }
  }

  // ── Load elements ──
  async function loadElements() {
    try {
      const res = await fetch("/api/overlays");
      elements = await res.json();
      renderList();
      renderPreview();
    } catch (err) {
      console.error(ts(), "[overlay] load error:", err);
    }
  }

  function renderList() {
    if (!listEl) return;
    if (elements.length === 0) {
      listEl.innerHTML = '<p class="text-gray-500 text-sm">No overlay elements</p>';
      return;
    }
    listEl.innerHTML = elements.map((e) => `
      <div class="flex items-center justify-between rounded-lg border px-3 py-2 group cursor-pointer transition-colors hover:border-indigo-500 border-gray-800 ${!e.enabled ? "opacity-50" : ""} bg-gray-900"
           data-overlay-id="${e.id}">
        <div class="flex items-center gap-2 min-w-0">
          <span class="inline-block w-2 h-2 rounded-full ${e.enabled ? "bg-green-400" : "bg-gray-600"}"></span>
          <span class="text-sm text-gray-200 truncate">${escapeHtml(e.name)}</span>
          ${!e.enabled ? '<span class="text-[10px] text-yellow-600 border border-yellow-800 rounded px-1">DISABLED</span>' : ""}
        </div>
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button data-toggle="${e.id}" data-currently-enabled="${e.enabled}" class="p-1 ${e.enabled ? "text-green-400 hover:text-yellow-400" : "text-yellow-500 hover:text-green-400"}" title="${e.enabled ? "Disable" : "Enable"}">
            ${e.enabled
              ? '<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>'
              : '<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>'}
          </button>
          <button data-edit="${e.id}" class="p-1 text-gray-400 hover:text-white" title="Edit">
            <svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
            </svg>
          </button>
          ${!e.isSeed ? `<button data-delete="${e.id}" class="p-1 text-gray-400 hover:text-red-400" title="Delete">
            <svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
          </button>` : ""}
        </div>
      </div>`).join("");

    // Bind click handlers
    listEl.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.toggle);
        const currentlyEnabled = btn.dataset.currentlyEnabled === "true";
        try {
          await fetch(`/api/overlays/${id}/toggle`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !currentlyEnabled }),
          });
          loadElements();
        } catch (err) {
          console.error(ts(), "[overlay] toggle error:", err);
        }
      });
    });

    listEl.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.edit);
        const el = elements.find((ef) => ef.id === id);
        if (el) openModal(el);
      });
    });

    listEl.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.delete);
        if (!confirm("Delete this overlay element?")) return;
        try {
          const res = await fetch(`/api/overlays/${id}`, { method: "DELETE" });
          if (res.status === 403) {
            alert("Built-in overlay elements cannot be deleted. You can disable them instead.");
            return;
          }
          loadElements();
        } catch (err) {
          console.error(ts(), "[overlay] delete error:", err);
        }
      });
    });
  }

  // ── Render enabled overlays in preview ──
  function renderPreview() {
    if (!previewContainer) return;
    previewContainer.innerHTML = "";
    let css = "";
    const enabled = elements.filter((e) => e.enabled);
    for (const el of enabled) {
      css += el.css + "\n";
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-overlay-key", el.key);
      wrapper.innerHTML = el.html;
      previewContainer.appendChild(wrapper);
    }
    if (previewCss) previewCss.textContent = css;

    // Run JS update functions with mock deck data
    const mockDeck = {
      deck: 1,
      bpm: 128.0,
      filename: "Demo Song - Artist Name.mp4",
      totalTimeMs: 240000,
      title: "Demo Song",
      artist: "Artist Name",
      elapsedMs: 60000,
    };
    runOverlayJS(previewContainer, enabled, mockDeck);

    // Scale overlay elements to match the preview container size (double-rAF for reflow)
    requestAnimationFrame(() => requestAnimationFrame(() => scaleOverlayContainers()));
  }

  // ── Modal ──
  function openModal(el) {
    modalTitle.textContent = "Edit Overlay Element";
    inputName.value = el.name;
    const nameDisplay = document.getElementById("overlay-name-display");
    if (nameDisplay) nameDisplay.textContent = el.name;
    inputCss.value = el.css;
    inputHtml.value = el.html;
    inputJs.value = el.js;
    editId.value = el.id;
    editKey.value = el.key;

    // Show config section for custom_text
    if (el.key === "custom_text") {
      configSection.classList.remove("hidden");
      try {
        const cfg = JSON.parse(el.config || "{}");
        configText.value = cfg.text || "";
      } catch (_) {
        configText.value = "";
      }
    } else {
      configSection.classList.add("hidden");
      configText.value = "";
    }

    // Show config section for custom_logo
    if (el.key === "custom_logo") {
      configLogo.classList.remove("hidden");
      try {
        const cfg = JSON.parse(el.config || "{}");
        const url = cfg.logo_url || "";
        configLogoUrl.value = url;
        if (url) {
          configLogoPreview.src = url + "?t=" + Date.now();
          configLogoPreview.classList.remove("hidden");
        } else {
          configLogoPreview.classList.add("hidden");
        }
      } catch (_) {
        configLogoUrl.value = "";
        configLogoPreview.classList.add("hidden");
      }
      configLogoStatus.textContent = "";
    } else {
      configLogo.classList.add("hidden");
      configLogoUrl.value = "";
      configLogoPreview.classList.add("hidden");
      configLogoStatus.textContent = "";
    }

    // Show restore button for built-in elements
    if (el.isSeed) {
      modalRestore.classList.remove("hidden");
    } else {
      modalRestore.classList.add("hidden");
    }

    // Set "Show over Transition Video" toggle
    setShowOverTransitionUI(el.showOverTransition !== false);

    modal.classList.remove("hidden");
  }

  function closeModal() {
    modal.classList.add("hidden");
  }

  async function saveElement() {
    const id = editId.value;
    const key = editKey.value;
    const name = inputName.value.trim();
    const css = inputCss.value.trim();
    const html = inputHtml.value.trim();
    const js = inputJs.value.trim();
    let config = "";
    if (key === "custom_text") {
      config = JSON.stringify({ text: configText.value });
    }
    if (key === "custom_logo") {
      config = JSON.stringify({ logo_url: configLogoUrl.value });
    }
    if (!name) {
      alert("Name is required.");
      return;
    }
    try {
      await fetch(`/api/overlays/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, css, html, js, config, showOverTransition: showOverTransitionValue }),
      });
      closeModal();
      loadElements();
    } catch (err) {
      console.error(ts(), "[overlay] save error:", err);
      alert("Failed to save overlay element.");
    }
  }

  async function restoreDefaults() {
    const id = editId.value;
    if (!confirm("Restore this element to its default settings?")) return;
    try {
      const res = await fetch(`/api/overlays/${id}/restore`, { method: "POST" });
      if (res.ok) {
        const restored = await res.json();
        // Update modal fields with restored values
        inputName.value = restored.name;
        inputCss.value = restored.css;
        inputHtml.value = restored.html;
        inputJs.value = restored.js;
        if (restored.key === "custom_text") {
          try {
            const cfg = JSON.parse(restored.config || "{}");
            configText.value = cfg.text || "";
          } catch (_) {
            configText.value = "";
          }
        }
        if (restored.key === "custom_logo") {
          try {
            const cfg = JSON.parse(restored.config || "{}");
            configLogoUrl.value = cfg.logo_url || "";
            configLogoPreview.classList.add("hidden");
            configLogoStatus.textContent = "";
          } catch (_) {
            configLogoUrl.value = "";
          }
        }
        setShowOverTransitionUI(restored.showOverTransition !== false);
        loadElements();
      }
    } catch (err) {
      console.error(ts(), "[overlay] restore error:", err);
      alert("Failed to restore defaults.");
    }
  }

  // ── Event Bindings ──
  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (modalCancel) modalCancel.addEventListener("click", closeModal);
  if (modalBackdrop) modalBackdrop.addEventListener("click", closeModal);
  if (modalSave) modalSave.addEventListener("click", saveElement);
  if (modalRestore) modalRestore.addEventListener("click", restoreDefaults);

  // Logo file upload
  if (configLogoFile) {
    configLogoFile.addEventListener("change", async () => {
      const file = configLogoFile.files[0];
      if (!file) return;
      configLogoStatus.textContent = "Uploading…";
      const form = new FormData();
      form.append("logo", file);
      try {
        const res = await fetch("/api/overlays/logo", { method: "POST", body: form });
        if (!res.ok) {
          const msg = await res.text();
          configLogoStatus.textContent = "Error: " + msg;
          return;
        }
        const data = await res.json();
        const logoUrl = data.url + "?t=" + Date.now();
        configLogoUrl.value = logoUrl;
        configLogoPreview.src = logoUrl;
        configLogoPreview.classList.remove("hidden");
        configLogoStatus.textContent = "Uploaded ✓";
      } catch (err) {
        console.error(ts(), "[overlay] logo upload error:", err);
        configLogoStatus.textContent = "Upload failed";
      }
      configLogoFile.value = "";
    });
  }

  // Shuffle preview video button
  const shuffleBtn = document.getElementById("overlay-shuffle-btn");
  if (shuffleBtn) shuffleBtn.addEventListener("click", () => loadPreviewVideo());

  // ── Init ──
  loadElements();
  loadPreviewVideo();

  // Rescale overlay preview on window resize (debounced to avoid flicker)
  const onResize = () => scaleOverlayContainersDebounced();
  window.addEventListener("resize", onResize);

  // SSE: reload elements when another client changes them
  const sse = getSSE();
  const onOverlayUpdated = () => loadElements();
  sse.onOverlayUpdated(onOverlayUpdated);

  return () => {
    sse.offOverlayUpdated(onOverlayUpdated);
    window.removeEventListener("resize", onResize);
    if (previewVideo) {
      previewVideo.pause();
      previewVideo.removeAttribute("src");
    }
  };
}

/**
 * Execute overlay JS update functions on each element's wrapper.
 * Each element's JS is expected to be a function body that receives (el, deck, config).
 * @param {HTMLElement} container - the overlay container
 * @param {object[]} elements - array of enabled OverlayElement objects
 * @param {object} deck - the current deck state data
 */
function runOverlayJS(container, elements, deck) {
  if (!container) return;
  for (const el of elements) {
    if (!el.js) continue;
    const wrapper = container.querySelector(`[data-overlay-key="${el.key}"]`);
    if (!wrapper) continue;
    try {
      let cfg = {};
      try { cfg = JSON.parse(el.config || "{}"); } catch (_) {}
      const trimmed = el.js.trim();
      if (trimmed.startsWith("(function")) {
        // IIFE-style: evaluate to get the function reference, then call it
        const evalFn = new Function("return " + trimmed);
        const innerFn = evalFn();
        if (typeof innerFn === "function") {
          innerFn(wrapper, deck, cfg);
        }
      } else {
        // Raw function body: el, deck, config are params
        const fn = new Function("el", "deck", "config", trimmed);
        fn(wrapper, deck, cfg);
      }
    } catch (err) {
      console.error(ts(), `[overlay] JS error for ${el.key}:`, err);
    }
  }
}

// ─── Transitions Page ───────────────────────────────────

function initTransitions() {
  let selectedEffect = null;
  let previewVideos = null;

  const inList = document.getElementById("transition-in-list");
  const outList = document.getElementById("transition-out-list");
  const previewBtn = document.getElementById("preview-transition-btn");
  const refreshBtn = document.getElementById("preview-refresh-btn");
  const effectNameLabel = document.getElementById("preview-effect-name");
  const previewCss = document.getElementById("transition-preview-css");
  const addBtn = document.getElementById("add-transition-btn");
  const modal = document.getElementById("transition-modal");
  const modalBackdrop = document.getElementById("transition-modal-backdrop");
  const modalTitle = document.getElementById("transition-modal-title");
  const modalClose = document.getElementById("transition-modal-close");
  const modalCancel = document.getElementById("transition-modal-cancel");
  const modalSave = document.getElementById("transition-modal-save");
  const inputName = document.getElementById("effect-name");
  const inputDir = document.getElementById("effect-direction");
  const inputCss = document.getElementById("effect-css");
  const editId = document.getElementById("effect-edit-id");

  const beforeVid = document.getElementById("preview-before");
  const transVid = document.getElementById("preview-transition");
  const afterVid = document.getElementById("preview-after");
  const placeholder = document.getElementById("preview-stage-placeholder");

  // ── Load effects ──
  async function loadEffects() {
    try {
      const res = await fetch("/api/transitions");
      const effects = await res.json();
      const inEffects = effects.filter((e) => e.direction === "in");
      const outEffects = effects.filter((e) => e.direction === "out");
      renderList(inList, inEffects, "in");
      renderList(outList, outEffects, "out");
      updateWarningBanner(inEffects, outEffects);
    } catch (err) {
      console.error(ts(), "[transitions] load error:", err);
    }
  }

  function updateWarningBanner(inEffects, outEffects) {
    const banner = document.getElementById("transition-warning");
    const text = document.getElementById("transition-warning-text");
    if (!banner || !text) return;
    const noIn = !inEffects.some((e) => e.enabled);
    const noOut = !outEffects.some((e) => e.enabled);
    if (noIn && noOut) {
      text.textContent = "All transition effects are disabled. Transitions will play without any visual effects.";
      banner.classList.remove("hidden");
      banner.classList.add("flex");
    } else if (noIn) {
      text.textContent = "All \u201CIn\u201D effects are disabled. Transitions will play without an intro effect.";
      banner.classList.remove("hidden");
      banner.classList.add("flex");
    } else if (noOut) {
      text.textContent = "All \u201COut\u201D effects are disabled. Transitions will play without an outro effect.";
      banner.classList.remove("hidden");
      banner.classList.add("flex");
    } else {
      banner.classList.add("hidden");
      banner.classList.remove("flex");
    }
  }

  function renderList(container, effects, direction) {
    if (effects.length === 0) {
      container.innerHTML = '<p class="text-gray-500 text-sm">No effects defined</p>';
      return;
    }
    container.innerHTML = effects
      .map(
        (e) => `
      <div class="flex items-center justify-between rounded-lg border px-3 py-2 group cursor-pointer transition-colors hover:border-indigo-500 ${selectedEffect && selectedEffect.id === e.id ? "border-indigo-500 bg-gray-800" : "border-gray-800"} ${!e.enabled ? "opacity-50" : ""} bg-gray-900"
           data-effect-id="${e.id}" data-effect-dir="${e.direction}">
        <div class="flex items-center gap-2 min-w-0">
          <span class="inline-block w-2 h-2 rounded-full ${direction === "in" ? "bg-indigo-400" : "bg-rose-400"}"></span>
          <span class="text-sm text-gray-200 truncate">${escapeHtml(e.name)}</span>
          <span class="text-xs text-gray-500 uppercase">${e.direction}</span>
          ${e.isSeed ? '<span class="text-[10px] text-gray-600 border border-gray-700 rounded px-1">BUILT-IN</span>' : ""}
          ${!e.enabled ? '<span class="text-[10px] text-yellow-600 border border-yellow-800 rounded px-1">DISABLED</span>' : ""}
        </div>
        <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button data-toggle="${e.id}" data-currently-enabled="${e.enabled}" class="p-1 ${e.enabled ? "text-green-400 hover:text-yellow-400" : "text-yellow-500 hover:text-green-400"}" title="${e.enabled ? "Disable" : "Enable"}">
            ${e.enabled
              ? '<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>'
              : '<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>'}
          </button>
          <button data-edit="${e.id}" class="p-1 text-gray-400 hover:text-white" title="Edit">
            <svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
            </svg>
          </button>
          ${!e.isSeed ? `<button data-delete="${e.id}" class="p-1 text-gray-400 hover:text-red-400" title="Delete">
            <svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
          </button>` : ""}
        </div>
      </div>`
      )
      .join("");

    // Bind click handlers
    container.querySelectorAll("[data-effect-id]").forEach((el) => {
      el.addEventListener("click", (e) => {
        // Skip if clicking action buttons
        if (e.target.closest("[data-edit]") || e.target.closest("[data-delete]") || e.target.closest("[data-toggle]")) return;
        const id = parseInt(el.dataset.effectId);
        const effect = effects.find((ef) => ef.id === id);
        if (effect) selectEffect(effect);
      });
    });

    container.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.toggle);
        const currentlyEnabled = btn.dataset.currentlyEnabled === "true";
        try {
          await fetch(`/api/transitions/${id}/toggle`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !currentlyEnabled }),
          });
          loadEffects();
        } catch (err) {
          console.error(ts(), "[transitions] toggle error:", err);
        }
      });
    });

    container.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.edit);
        const effect = effects.find((ef) => ef.id === id);
        if (effect) openModal(effect, effect.isSeed);
      });
    });

    container.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.delete);
        if (!confirm("Delete this transition effect?")) return;
        try {
          const res = await fetch(`/api/transitions/${id}`, { method: "DELETE" });
          if (res.status === 403) {
            alert("Built-in effects cannot be deleted. You can disable them instead.");
            return;
          }
          if (selectedEffect && selectedEffect.id === id) {
            selectedEffect = null;
            previewBtn.disabled = true;
            effectNameLabel.textContent = "";
          }
          loadEffects();
        } catch (err) {
          console.error(ts(), "[transitions] delete error:", err);
        }
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function selectEffect(effect) {
    selectedEffect = effect;
    previewBtn.disabled = false;
    effectNameLabel.textContent = `${effect.name} (${effect.direction.toUpperCase()})`;
    // Update highlight
    document.querySelectorAll("[data-effect-id]").forEach((el) => {
      const isSelected = parseInt(el.dataset.effectId) === effect.id;
      el.classList.toggle("border-indigo-500", isSelected);
      el.classList.toggle("bg-gray-800", isSelected);
    });
  }

  // ── Preview videos ──
  async function loadPreviewVideos() {
    try {
      const res = await fetch("/api/transitions/preview-videos");
      previewVideos = await res.json();
    } catch (err) {
      console.error(ts(), "[transitions] preview videos error:", err);
    }
  }

  // ── Preview playback ──
  let previewAbort = null;

  async function runPreview() {
    if (!selectedEffect || !previewVideos) return;
    if (previewAbort) previewAbort.abort();
    const ctrl = new AbortController();
    previewAbort = ctrl;

    const duration = transitionDurationMs || 3000;

    // Reset state
    placeholder.classList.add("hidden");
    beforeVid.classList.remove("hidden");
    transVid.classList.add("hidden");
    afterVid.classList.add("hidden");
    beforeVid.classList.remove("transition-active");
    transVid.classList.remove("transition-active");
    afterVid.classList.remove("transition-active");
    previewCss.textContent = "";

    // Load the selected effect's CSS with the duration variable
    const cssWithVar = `#transition-preview-stage { --transition-duration: ${duration}ms; }\n${selectedEffect.css}`;
    previewCss.textContent = cssWithVar;

    // Load before video
    if (previewVideos.before) {
      beforeVid.src = previewVideos.before;
      beforeVid.currentTime = 0;
      try { await beforeVid.play(); } catch (_) {}
    }

    if (ctrl.signal.aborted) return;

    if (selectedEffect.direction === "in") {
      // IN transition: show before video → transition video fades IN
      // Wait 1 second showing "before" video, then play the transition IN
      await delay(1000, ctrl.signal);
      if (ctrl.signal.aborted) return;

      // Show transition video and apply the IN animation
      if (previewVideos.transition) {
        transVid.src = previewVideos.transition;
        transVid.currentTime = 0;
        transVid.classList.remove("hidden");
        transVid.style.opacity = "0";
        try { await transVid.play(); } catch (_) {}
        // Trigger the animation
        await nextFrame();
        transVid.style.opacity = "";
        transVid.classList.add("transition-active");
      }

      // Wait for animation to finish
      await delay(duration, ctrl.signal);
      if (ctrl.signal.aborted) return;

      // Hold on transition video for 1 second
      await delay(1000, ctrl.signal);

    } else {
      // OUT transition: show transition video → transition video fades OUT → after video appears
      // Start with transition video
      beforeVid.classList.add("hidden");
      if (previewVideos.transition) {
        transVid.src = previewVideos.transition;
        transVid.currentTime = 0;
        transVid.classList.remove("hidden");
        try { await transVid.play(); } catch (_) {}
      }

      // Show after video underneath (behind transition)
      if (previewVideos.after) {
        afterVid.src = previewVideos.after;
        afterVid.currentTime = 0;
        afterVid.classList.remove("hidden");
        afterVid.style.zIndex = "0";
        transVid.style.zIndex = "1";
        try { await afterVid.play(); } catch (_) {}
      }

      // Wait 1 second on transition video, then apply OUT animation
      await delay(1000, ctrl.signal);
      if (ctrl.signal.aborted) return;

      transVid.classList.add("transition-active");

      // Wait for animation to finish
      await delay(duration, ctrl.signal);
      if (ctrl.signal.aborted) return;

      // Hold on after video for 1 second
      await delay(1000, ctrl.signal);
    }

    // Clean up
    if (!ctrl.signal.aborted) {
      resetPreviewStage();
    }
  }

  function resetPreviewStage() {
    beforeVid.classList.add("hidden");
    transVid.classList.add("hidden");
    afterVid.classList.add("hidden");
    beforeVid.pause();
    transVid.pause();
    afterVid.pause();
    beforeVid.removeAttribute("src");
    transVid.removeAttribute("src");
    afterVid.removeAttribute("src");
    beforeVid.classList.remove("transition-active");
    transVid.classList.remove("transition-active");
    afterVid.classList.remove("transition-active");
    transVid.style.zIndex = "";
    afterVid.style.zIndex = "";
    transVid.style.opacity = "";
    previewCss.textContent = "";
    placeholder.classList.remove("hidden");
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }
    });
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // ── Modal ──
  function openModal(effect, readOnly) {
    const isView = !!readOnly;
    modalTitle.textContent = isView ? "View Built-in Effect"
      : effect ? "Edit Transition Effect"
      : "Add Transition Effect";
    inputName.value = effect ? effect.name : "";
    inputDir.value = effect ? effect.direction : "in";
    inputCss.value = effect ? effect.css : "";
    editId.value = effect ? effect.id : "";

    // Toggle read-only state on form fields
    inputName.disabled = isView;
    inputDir.disabled = isView;
    inputCss.readOnly = isView;
    modalSave.classList.toggle("hidden", isView);

    modal.classList.remove("hidden");
  }

  function closeModal() {
    modal.classList.add("hidden");
    // Reset read-only state for next open
    inputName.disabled = false;
    inputDir.disabled = false;
    inputCss.readOnly = false;
    modalSave.classList.remove("hidden");
  }

  async function saveEffect() {
    const name = inputName.value.trim();
    const direction = inputDir.value;
    const css = inputCss.value.trim();
    if (!name || !css) {
      alert("Name and CSS are required.");
      return;
    }
    const id = editId.value;
    const body = JSON.stringify({ name, direction, css });
    try {
      if (id) {
        await fetch(`/api/transitions/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } else {
        await fetch("/api/transitions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      }
      closeModal();
      loadEffects();
    } catch (err) {
      console.error(ts(), "[transitions] save error:", err);
      alert("Failed to save effect.");
    }
  }

  // ── Event Bindings ──
  if (addBtn) addBtn.addEventListener("click", () => openModal(null));
  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (modalCancel) modalCancel.addEventListener("click", closeModal);
  if (modalBackdrop) modalBackdrop.addEventListener("click", closeModal);
  if (modalSave) modalSave.addEventListener("click", saveEffect);
  if (previewBtn) previewBtn.addEventListener("click", () => runPreview());
  if (refreshBtn) refreshBtn.addEventListener("click", () => loadPreviewVideos());

  // ── Init ──
  loadEffects();
  loadPreviewVideos();

  // SSE: reload effects when another client changes them
  const sse = getSSE();
  const onTransitionsUpdated = () => loadEffects();
  sse.onTransitionsUpdated(onTransitionsUpdated);

  return () => {
    if (previewAbort) previewAbort.abort();
    resetPreviewStage();
    sse.offTransitionsUpdated(onTransitionsUpdated);
  };
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
      } else if (key === "transition_videos_enabled") {
        transitionVideosEnabled = value !== "0";
      } else if (key === "loop_video") {
        loopVideoPath = value || "";
        if (!loopVideoPath && loopVideoEnabled) loopVideoEnabled = false;
      } else if (key === "loop_video_enabled") {
        loopVideoEnabled = value === "1" && !!loopVideoPath;
      } else if (key === "overlay_enabled") {
        overlayEnabled = value !== "0";
        updateOverlayVisibility();
      } else if (key === "aspect_ratio") {
        applyAspectRatio(value || "16/9");
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
        transitionVideosEnabled = cfg.transition_videos_enabled !== "0";
        loopVideoPath = cfg.loop_video || "";
        loopVideoEnabled = cfg.loop_video_enabled === "1" && !!loopVideoPath;
        overlayEnabled = cfg.overlay_enabled !== "0";
        updateOverlayVisibility();
        applyAspectRatio(cfg.aspect_ratio || "16/9");
      })
      .catch(() => {});
  }

  if (document.getElementById("deck-status")) {
    currentPageCleanup = initDashboard();
  } else if (document.getElementById("video-list")) {
    currentPageCleanup = initLibrary();
  } else if (document.getElementById("player-container")) {
    currentPageCleanup = initPlayer();
  } else if (document.querySelector('[data-page="transitions"]')) {
    currentPageCleanup = initTransitions();
  } else if (document.querySelector('[data-page="overlay"]')) {
    currentPageCleanup = initOverlay();
  }

  // Apply the current aspect ratio to any newly rendered data-aspect-ratio
  // elements (SPA navigation replaces page HTML with server defaults).
  // Called twice: once synchronously now, and once after a rAF to catch any
  // elements created asynchronously by page-init functions.
  applyAspectRatio();
  requestAnimationFrame(() => applyAspectRatio());
}

// ─── Init ───────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Replace initial history entry so popstate works for the landing page
  history.replaceState({ spaUrl: window.location.pathname }, "");

  // Bind SPA links and init the page
  initCurrentPage();
});
