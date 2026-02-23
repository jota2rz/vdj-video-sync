//////////////////////////////////////////////////////////////////////////
// VdjVideoSync Plugin – implementation
//////////////////////////////////////////////////////////////////////////

#define CPPHTTPLIB_NO_EXCEPTIONS
#include "VideoSyncPlugin.h"
#include "httplib.h"

#include <cstdio>
#include <chrono>
#include <sstream>
#include <cstdlib>
#include <cctype>

// ── Input validation ───────────────────────────────────
// Rejects garbage / malicious input from set_var_dialog.

// Accepts IPv4 dotted-decimal, or a hostname (letters, digits, dots, hyphens).
static bool isValidHost(const char* s) {
    if (!s || !s[0]) return false;
    int len = 0;
    for (const char* p = s; *p; ++p, ++len) {
        char c = *p;
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '-' || c == ':') continue;
        return false;  // disallow quotes, spaces, semicolons, etc.
    }
    return len > 0 && len < 64;
}

// Accepts a numeric port string in range 1–65535.
static bool isValidPort(const char* s) {
    if (!s || !s[0]) return false;
    for (const char* p = s; *p; ++p) {
        if (!std::isdigit(static_cast<unsigned char>(*p))) return false;
    }
    long v = std::strtol(s, nullptr, 10);
    return v >= 1 && v <= 65535;
}

// ── Locale-safe float-to-string ─────────────────────────
// Ensures decimal separator is always '.' regardless of system locale.
static std::string floatToStr(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.6f", v);
    // Force dot separator (in case snprintf used comma)
    for (char* p = buf; *p; ++p) {
        if (*p == ',') *p = '.';
    }
    return buf;
}

// ── DeckState helpers ───────────────────────────────────

bool DeckState::operator==(const DeckState& o) const {
    return deck == o.deck
        && isAudible == o.isAudible
        && isPlaying == o.isPlaying
        && volume == o.volume
        && bpm == o.bpm
        && filename == o.filename
        && pitch == o.pitch;
    // elapsedMs is intentionally excluded – it changes every frame
}

std::string DeckState::toJson() const {
    std::ostringstream ss;
    auto escape = [](const std::string& s) -> std::string {
        std::string out;
        out.reserve(s.size() + 8);
        for (char c : s) {
            switch (c) {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n";  break;
                case '\r': out += "\\r";  break;
                case '\t': out += "\\t";  break;
                default:   out += c;
            }
        }
        return out;
    };

    ss << "{"
       << "\"deck\":" << deck << ","
       << "\"isAudible\":" << (isAudible ? "true" : "false") << ","
       << "\"isPlaying\":" << (isPlaying ? "true" : "false") << ","
       << "\"volume\":" << floatToStr(volume) << ","
       << "\"elapsedMs\":" << elapsedMs << ","
       << "\"bpm\":" << floatToStr(bpm) << ","
       << "\"filename\":\"" << escape(filename) << "\","
       << "\"pitch\":" << floatToStr(pitch)
       << "}";
    return ss.str();
}

// ── Constructor / Destructor ────────────────────────────

CVideoSyncPlugin::CVideoSyncPlugin()  = default;
CVideoSyncPlugin::~CVideoSyncPlugin() = default;

// ── IVdjPlugin8 base ────────────────────────────────────

HRESULT VDJ_API CVideoSyncPlugin::OnLoad() {
    // String params: displayed in VDJ UI and persisted in .ini
    DeclareParameterString(paramIP_,   PARAM_IP,   "Server IP",   "IP",   kParamSize);
    DeclareParameterString(paramPort_, PARAM_PORT, "Server Port", "Port", kParamSize);

    // Buttons open native VDJ dialogs for IP / Port (cross-platform)
    DeclareParameterButton(&setIpBtn_,   PARAM_SET_IP,   "Set IP",   "SIP");
    DeclareParameterButton(&setPortBtn_, PARAM_SET_PORT, "Set Port",  "SPT");

    // VDJ persistent vars survive across plugin reloads.
    // If the user previously changed values via set_var_dialog, those
    // vars will still hold the new values.  Read them first so they
    // take precedence over stale .ini defaults, then sync back.
    applyVarChanges();
    pushParamsToVars();

    // Start always-on settings watcher (polls VDJ vars even when disabled)
    watcherRunning_ = true;
    settingsWatcher_ = std::thread(&CVideoSyncPlugin::settingsWatchLoop, this);

    // Create the HTTP client with current parameters
    recreateClient();
    return S_OK;
}

HRESULT VDJ_API CVideoSyncPlugin::OnParameter(int id) {
    if (id == PARAM_SET_IP && setIpBtn_ == 1) {
        // Pre-fill the dialog with the current value
        pushParamsToVars();
        // set_var_dialog may be modal (blocks until closed) or async.
        // Either way, applyVarChanges() right after will pick up the
        // new value if it's already available.
        SendCommand("set_var_dialog $vdjVideoSyncAddr 'Enter Server IP'");
        applyVarChanges();
        setIpBtn_ = 0;
    }
    if (id == PARAM_SET_PORT && setPortBtn_ == 1) {
        pushParamsToVars();
        SendCommand("set_var_dialog $vdjVideoSyncPort 'Enter Server Port'");
        applyVarChanges();
        setPortBtn_ = 0;
    }
    return S_OK;
}

HRESULT VDJ_API CVideoSyncPlugin::OnGetParameterString(int id, char* outParam, int outParamSize) {
    // Pick up any dialog results (runs on VDJ's UI thread, even when disabled)
    applyVarChanges();

    // Show current IP/Port as button labels
    switch (id) {
        case PARAM_SET_IP:
            strncpy(outParam, paramIP_, outParamSize);
            outParam[outParamSize - 1] = '\0';
            return S_OK;
        case PARAM_SET_PORT:
            strncpy(outParam, paramPort_, outParamSize);
            outParam[outParamSize - 1] = '\0';
            return S_OK;
        default:
            return E_NOTIMPL;
    }
}

void CVideoSyncPlugin::recreateClient() {
    std::lock_guard<std::mutex> lock(httpMutex_);
    delete httpClient_;
    std::string endpoint = std::string("http://") + paramIP_ + ":" + paramPort_;
    httpClient_ = new httplib::Client(endpoint);
    httpClient_->set_connection_timeout(2);
    httpClient_->set_read_timeout(2);
}

// ── VDJ Variable Sync ───────────────────────────────────
// VDJ persistent vars (@$) mirror the param buffers so that
// set_var_dialog can show / edit the current values.

void CVideoSyncPlugin::pushParamsToVars() {
    char cmd[256];
    std::snprintf(cmd, sizeof(cmd), "set $vdjVideoSyncAddr '%s'", paramIP_);
    SendCommand(cmd);
    std::snprintf(cmd, sizeof(cmd), "set $vdjVideoSyncPort '%s'", paramPort_);
    SendCommand(cmd);
}

void CVideoSyncPlugin::applyVarChanges() {
    // Read VDJ persistent vars and update param buffers if the user
    // changed them via set_var_dialog (which is non-blocking).
    char buf[64] = {};
    bool changed = false;

    if (GetStringInfo("get_var $vdjVideoSyncAddr", buf, sizeof(buf)) == S_OK && buf[0]) {
        if (isValidHost(buf) && strcmp(paramIP_, buf) != 0) {
            strncpy(paramIP_, buf, kParamSize);
            paramIP_[kParamSize - 1] = '\0';
            changed = true;
        }
    }

    memset(buf, 0, sizeof(buf));
    if (GetStringInfo("get_var $vdjVideoSyncPort", buf, sizeof(buf)) == S_OK && buf[0]) {
        if (isValidPort(buf) && strcmp(paramPort_, buf) != 0) {
            strncpy(paramPort_, buf, kParamSize);
            paramPort_[kParamSize - 1] = '\0';
            changed = true;
        }
    }

    if (changed) recreateClient();
}

void CVideoSyncPlugin::settingsWatchLoop() {
    while (watcherRunning_.load()) {
        applyVarChanges();
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
}

HRESULT VDJ_API CVideoSyncPlugin::OnGetPluginInfo(TVdjPluginInfo8* info) {
    info->PluginName  = "VDJ Video Sync";
    info->Author      = "vdj-video-sync";
    info->Description = "Sends deck state to an external video sync server";
    info->Version     = "0.1.1";
    info->Flags       = 0x00;
    info->Bitmap      = NULL;
    return S_OK;
}

ULONG VDJ_API CVideoSyncPlugin::Release() {
    // Stop the worker thread if still running
    stopWorker();

    // Stop the settings watcher
    watcherRunning_ = false;
    if (settingsWatcher_.joinable()) settingsWatcher_.join();

    // Destroy the HTTP client
    {
        std::lock_guard<std::mutex> lock(httpMutex_);
        delete httpClient_;
        httpClient_ = nullptr;
    }

    delete this;
    return 0;
}

// ── IVdjPluginDsp8 ──────────────────────────────────────

HRESULT VDJ_API CVideoSyncPlugin::OnStart() {
    // Pick up any variable changes made while the effect was disabled
    applyVarChanges();
    startWorker();
    return S_OK;
}

HRESULT VDJ_API CVideoSyncPlugin::OnStop() {
    // Effect toggled OFF in VirtualDJ – stop sending data
    stopWorker();
    return S_OK;
}

HRESULT VDJ_API CVideoSyncPlugin::OnProcessSamples(float* /*buffer*/, int /*nb*/) {
    // We don't modify audio – pass-through
    return S_OK;
}

// ── Worker thread management ────────────────────────────

void CVideoSyncPlugin::startWorker() {
    if (running_.load()) return;
    running_ = true;
    worker_ = std::thread(&CVideoSyncPlugin::pollLoop, this);
}

void CVideoSyncPlugin::stopWorker() {
    running_ = false;
    if (worker_.joinable()) {
        worker_.join();
    }
}



// ── Polling loop ────────────────────────────────────────

void CVideoSyncPlugin::pollLoop() {
    using clock = std::chrono::steady_clock;
    while (running_.load()) {
        auto start = clock::now();

        // Check for VDJ var changes from set_var_dialog
        applyVarChanges();

        // ── Phase 1: Read ALL deck states in a tight batch ──
        // No network calls here – just VDJ API queries.
        // This ensures elapsedMs values are comparable across decks
        // (no HTTP round-trip drift between reads).
        DeckState current[kMaxDecks];
        for (int d = 0; d < kMaxDecks; ++d) {
            current[d] = readDeckState(d + 1);
        }

        // ── Phase 2: Mark mirrored / duplicate decks ──
        // VDJ master-bus effects see the mixed signal, so querying
        // "deck 3 get_filename" may return deck 1's filename when
        // deck 3 has nothing loaded.  We compare within the CURRENT
        // batch so timing differences can't escape the filter.
        bool skip[kMaxDecks] = {};
        for (int d = 1; d < kMaxDecks; ++d) {
            if (current[d].filename.empty()) { skip[d] = true; continue; }
            for (int prev = 0; prev < d; ++prev) {
                if (skip[prev] || current[prev].filename.empty()) continue;
                if (current[d].filename == current[prev].filename
                    && current[d].isPlaying == current[prev].isPlaying
                    && current[d].isAudible == current[prev].isAudible) {
                    skip[d] = true;
                    break;
                }
            }
        }

        // ── Phase 3: Send updates for non-duplicate, changed decks ──
        for (int d = 0; d < kMaxDecks; ++d) {
            if (current[d].filename.empty()) continue;
            if (skip[d]) continue;

            // Send if something changed OR if the deck is playing (elapsedMs updates)
            if (current[d] != lastState_[d] || current[d].isPlaying) {
                lastState_[d] = current[d];
                sendUpdate(current[d]);
            }
        }

        // Sleep for the remainder of the poll interval
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            clock::now() - start);
        auto sleepMs = std::chrono::milliseconds(pollIntervalMs_) - elapsed;
        if (sleepMs.count() > 0) {
            std::this_thread::sleep_for(sleepMs);
        }
    }
}

DeckState CVideoSyncPlugin::readDeckState(int deck) {
    DeckState s;
    s.deck = deck;

    // Build deck-prefixed query strings
    char query[128];
    char buf[512];
    double val = 0.0;

    // is_audible (bool)
    std::snprintf(query, sizeof(query), "deck %d is_audible", deck);
    if (GetInfo(query, &val) == S_OK) s.isAudible = (val != 0.0);

    // play (bool)
    std::snprintf(query, sizeof(query), "deck %d play", deck);
    if (GetInfo(query, &val) == S_OK) s.isPlaying = (val != 0.0);

    // get_volume (float 0.0-1.0)
    std::snprintf(query, sizeof(query), "deck %d get_volume", deck);
    if (GetInfo(query, &val) == S_OK) s.volume = val;

    // get_time elapsed absolute (int, ms)
    std::snprintf(query, sizeof(query), "deck %d get_time elapsed absolute", deck);
    if (GetInfo(query, &val) == S_OK) s.elapsedMs = static_cast<int>(val);

    // get_bpm (float)
    std::snprintf(query, sizeof(query), "deck %d get_bpm", deck);
    if (GetInfo(query, &val) == S_OK) s.bpm = val;

    // get_filename (string)
    std::snprintf(query, sizeof(query), "deck %d get_filename", deck);
    if (GetStringInfo(query, buf, sizeof(buf)) == S_OK) s.filename = buf;

    // get_pitch_value (float, centered on 100%)
    std::snprintf(query, sizeof(query), "deck %d get_pitch_value", deck);
    if (GetInfo(query, &val) == S_OK) s.pitch = val;

    return s;
}

void CVideoSyncPlugin::sendUpdate(const DeckState& state) {
    std::lock_guard<std::mutex> lock(httpMutex_);
    if (!httpClient_) return;

    std::string body = state.toJson();
    auto result = httpClient_->Post("/api/deck/update", body, "application/json");

    (void)result; // fire-and-forget
}
