#pragma once
//////////////////////////////////////////////////////////////////////////
// VdjVideoSync Plugin
//
// A DSP plugin for VirtualDJ 8 that monitors the current deck state
// (filename, BPM, volume, pitch, play state, etc.) and sends updates
// via HTTP POST to an external video sync server.
// The server IP and port are configurable from the VDJ effect settings.
//
// Loaded as a Sound Effect — VDJ toggles the effect on/off which
// triggers OnStart() / OnStop() to begin/end data transmission.
//////////////////////////////////////////////////////////////////////////

#include "vdjDsp8.h"
#include <string>
#include <thread>
#include <atomic>
#include <mutex>

// Forward-declare to avoid pulling httplib.h into the header
namespace httplib { class Client; }

// ── Data sent to the server on each update ──────────────
struct DeckState {
    int         deck        = 0;
    bool        isAudible   = false;  // is_audible: audible at all (even if volume > 0)
    bool        isPlaying   = false;  // play: true if the deck is currently playing
    double      volume      = 0.0;    // get_volume: deck fader volume 0.0–1.0
    int         elapsedMs   = 0;      // get_time elapsed absolute: elapsed time in ms
    double      bpm         = 0.0;    // get_bpm: current deck BPM
    std::string filename;             // get_filename: song filename (no path)
    double      pitch       = 100.0;  // get_pitch_value: pitch %, centered on 100%, used for video playbackRate
    int         totalTimeMs = 0;      // get_songlength * 1000: total song length in ms
    std::string title;                // get_title: song title metadata
    std::string artist;               // get_artist: song artist metadata

    bool operator==(const DeckState& o) const;
    bool operator!=(const DeckState& o) const { return !(*this == o); }

    // Serialize to JSON (minimal, no external lib)
    std::string toJson() const;
};

// ── Parameter IDs for VDJ UI ────────────────────────────
enum {
    PARAM_IP       = 1,
    PARAM_PORT     = 2,
    PARAM_SET_IP   = 3,   // Button – opens VDJ dialog for IP
    PARAM_SET_PORT = 4,   // Button – opens VDJ dialog for Port
};

// ── Plugin class ────────────────────────────────────────
class CVideoSyncPlugin : public IVdjPluginDsp8
{
public:
    CVideoSyncPlugin();
    ~CVideoSyncPlugin() override;

    // IVdjPlugin8 base overrides
    HRESULT VDJ_API OnLoad()                                 override;
    HRESULT VDJ_API OnGetPluginInfo(TVdjPluginInfo8*)        override;
    ULONG   VDJ_API Release()                                override;
    HRESULT VDJ_API OnParameter(int id)                      override;
    HRESULT VDJ_API OnGetParameterString(int id, char* outParam, int outParamSize) override;

    // IVdjPluginDsp8 overrides
    HRESULT VDJ_API OnStart()                                override;
    HRESULT VDJ_API OnStop()                                 override;
    HRESULT VDJ_API OnProcessSamples(float* buffer, int nb)  override;

private:
    // Polling loop (runs in a background thread between OnStart/OnStop)
    void startWorker();
    void stopWorker();
    void pollLoop();
    DeckState readDeckState(int deck);
    void sendUpdate(const DeckState& state);
    void recreateClient();

    // ── VDJ variable sync (native set_var_dialog) ───────────
    void pushParamsToVars();          // push internal buffers → VDJ vars
    void applyVarChanges();           // read VDJ vars, update params if changed
    void settingsWatchLoop();         // always-on loop that polls VDJ vars

    // ── Configurable parameters (persisted via DeclareParameterString .ini) ──
    static constexpr int kParamSize = 64;
    char paramIP_[kParamSize]   = "127.0.0.1";
    char paramPort_[kParamSize] = "8090";

    // ── Settings buttons ────────────────────────────────────
    int setIpBtn_   = 0;
    int setPortBtn_ = 0;

    // ── Internals ───────────────────────────────────────
    int                      pollIntervalMs_ = 50;
    std::thread              worker_;
    std::atomic<bool>        running_{false};
    std::thread              settingsWatcher_;
    std::atomic<bool>        watcherRunning_{false};
    std::mutex               httpMutex_;
    httplib::Client*         httpClient_ = nullptr;

    static constexpr int kMaxDecks = 4;
    DeckState lastState_[kMaxDecks];
};
