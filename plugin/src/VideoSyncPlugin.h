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

    bool operator==(const DeckState& o) const;
    bool operator!=(const DeckState& o) const { return !(*this == o); }

    // Serialize to JSON (minimal, no external lib)
    std::string toJson() const;
};

// ── Parameter IDs for VDJ UI ────────────────────────────
enum {
    PARAM_IP       = 1,
    PARAM_PORT     = 2,
    PARAM_SETTINGS = 3,   // Button – opens the settings popup
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
#ifdef VDJ_WIN
    void showSettingsPopup();
#elif defined(VDJ_MAC)
    void openIniFile();
#endif

    // ── Configurable parameters (persisted as plain text in VDJ .ini) ──
    static constexpr int kParamSize = 64;
    char paramIP_[kParamSize]   = "127.0.0.1";
    char paramPort_[kParamSize] = "8090";

    // ── Settings button ─────────────────────────────────────
    int settingsBtn_ = 0;
#ifdef VDJ_WIN
    static INT_PTR CALLBACK SettingsDlgProc(HWND hDlg, UINT msg, WPARAM wParam, LPARAM lParam);
#endif

    // ── Internals ───────────────────────────────────────
    int                      pollIntervalMs_ = 50;
    std::thread              worker_;
    std::atomic<bool>        running_{false};
    std::mutex               httpMutex_;
    httplib::Client*         httpClient_ = nullptr;

    static constexpr int kMaxDecks = 4;
    DeckState lastState_[kMaxDecks];
};
