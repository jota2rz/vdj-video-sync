//////////////////////////////////////////////////////////////////////////
// VdjVideoSync Plugin – implementation
//////////////////////////////////////////////////////////////////////////

#define CPPHTTPLIB_NO_EXCEPTIONS
#include "VideoSyncPlugin.h"
#include "httplib.h"

#include <cstdio>
#include <chrono>
#include <sstream>

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
    // String params are persisted as plain text in the .ini file
    DeclareParameterString(paramIP_,   PARAM_IP,   "Server IP",   "IP",   kParamSize);
    DeclareParameterString(paramPort_, PARAM_PORT, "Server Port", "Port", kParamSize);

#ifdef VDJ_WIN
    // On Windows, a "Settings" button opens a popup dialog for editing
    DeclareParameterButton(&settingsBtn_, PARAM_SETTINGS, "Settings", "SET");
#elif defined(VDJ_MAC)
    // On macOS, a "Settings" button opens the .ini file in the default text editor
    DeclareParameterButton(&settingsBtn_, PARAM_SETTINGS, "Settings", "SET");
#endif

    // Create the HTTP client with current parameters
    recreateClient();
    return S_OK;
}

HRESULT VDJ_API CVideoSyncPlugin::OnParameter(int id) {
    if (id == PARAM_IP || id == PARAM_PORT) {
        recreateClient();
    }
#ifdef VDJ_WIN
    if (id == PARAM_SETTINGS && settingsBtn_ == 1) {
        showSettingsPopup();
        settingsBtn_ = 0;
    }
#elif defined(VDJ_MAC)
    if (id == PARAM_SETTINGS && settingsBtn_ == 1) {
        openIniFile();
        settingsBtn_ = 0;
    }
#endif
    return S_OK;
}

void CVideoSyncPlugin::recreateClient() {
    std::lock_guard<std::mutex> lock(httpMutex_);
    delete httpClient_;
    std::string endpoint = std::string("http://") + paramIP_ + ":" + paramPort_;
    httpClient_ = new httplib::Client(endpoint);
    httpClient_->set_connection_timeout(2);
    httpClient_->set_read_timeout(2);
}

// ── Win32 Settings Popup ────────────────────────────────
#ifdef VDJ_WIN

#include "resource.h"

// Data passed between the plugin and the modal dialog
struct SettingsData {
    char ip[64];
    char port[64];
};

INT_PTR CALLBACK CVideoSyncPlugin::SettingsDlgProc(HWND hDlg, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_INITDIALOG: {
        auto* data = reinterpret_cast<SettingsData*>(lParam);
        SetWindowLongPtrA(hDlg, GWLP_USERDATA, (LONG_PTR)data);
        SetDlgItemTextA(hDlg, IDC_EDIT_IP,   data->ip);
        SetDlgItemTextA(hDlg, IDC_EDIT_PORT, data->port);
        return TRUE;
    }
    case WM_COMMAND:
        switch (LOWORD(wParam)) {
        case IDOK: {
            auto* data = reinterpret_cast<SettingsData*>(GetWindowLongPtrA(hDlg, GWLP_USERDATA));
            GetDlgItemTextA(hDlg, IDC_EDIT_IP,   data->ip,   64);
            GetDlgItemTextA(hDlg, IDC_EDIT_PORT, data->port, 64);
            EndDialog(hDlg, IDOK);
            return TRUE;
        }
        case IDCANCEL:
            EndDialog(hDlg, IDCANCEL);
            return TRUE;
        }
        break;
    case WM_CLOSE:
        EndDialog(hDlg, IDCANCEL);
        return TRUE;
    }
    return FALSE;
}

// Build a DLGTEMPLATE in memory so we don't need a .rc resource file.
// This creates a small popup dialog with IP/Port edit fields + OK/Cancel.
static LRESULT showModalDialog(HINSTANCE hInst, HWND hParent, DLGPROC proc, LPARAM lParam) {
    // Helper lambdas for building the template
    alignas(4) BYTE buf[1024];
    memset(buf, 0, sizeof(buf));
    BYTE* p = buf;

    auto writeWord = [&](WORD v)  { memcpy(p, &v, 2); p += 2; };
    auto writeDword = [&](DWORD v){ memcpy(p, &v, 4); p += 4; };
    auto writeShort = [&](short v){ memcpy(p, &v, 2); p += 2; };
    auto writeWstr = [&](const wchar_t* s) {
        size_t len = wcslen(s) + 1;
        memcpy(p, s, len * 2);
        p += len * 2;
    };
    auto alignDword = [&]() {
        while ((uintptr_t)p & 3) *p++ = 0;
    };

    // ── DLGTEMPLATE ──
    // style
    writeDword(WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_MODALFRAME | DS_SETFONT | DS_CENTER);
    writeDword(0);         // dwExtendedStyle
    writeWord(6);          // cdit (number of controls)
    writeShort(0);         // x
    writeShort(0);         // y
    writeShort(210);       // cx (dialog units)
    writeShort(70);        // cy
    writeWord(0);          // menu
    writeWord(0);          // windowClass
    writeWstr(L"VDJ Video Sync Settings");  // title
    writeWord(8);          // font size
    writeWstr(L"MS Shell Dlg");             // font face

    // ── Control 1: STATIC "Server IP:" ──
    alignDword();
    writeDword(WS_CHILD | WS_VISIBLE | SS_RIGHT);  // style
    writeDword(0);         // exStyle
    writeShort(4);         // x
    writeShort(10);        // y
    writeShort(55);        // cx
    writeShort(10);        // cy
    writeWord(IDC_STATIC_IP);
    writeWord(0xFFFF); writeWord(0x0082);  // STATIC class
    writeWstr(L"Server IP:");
    writeWord(0);          // extra

    // ── Control 2: EDIT (IP) ──
    alignDword();
    writeDword(WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL);
    writeDword(WS_EX_CLIENTEDGE);
    writeShort(62);
    writeShort(8);
    writeShort(140);
    writeShort(14);
    writeWord(IDC_EDIT_IP);
    writeWord(0xFFFF); writeWord(0x0081);  // EDIT class
    writeWstr(L"");
    writeWord(0);

    // ── Control 3: STATIC "Server Port:" ──
    alignDword();
    writeDword(WS_CHILD | WS_VISIBLE | SS_RIGHT);
    writeDword(0);
    writeShort(4);
    writeShort(28);
    writeShort(55);
    writeShort(10);
    writeWord(IDC_STATIC_PORT);
    writeWord(0xFFFF); writeWord(0x0082);
    writeWstr(L"Server Port:");
    writeWord(0);

    // ── Control 4: EDIT (Port) ──
    alignDword();
    writeDword(WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL);
    writeDword(WS_EX_CLIENTEDGE);
    writeShort(62);
    writeShort(26);
    writeShort(140);
    writeShort(14);
    writeWord(IDC_EDIT_PORT);
    writeWord(0xFFFF); writeWord(0x0081);
    writeWstr(L"");
    writeWord(0);

    // ── Control 5: BUTTON "OK" ──
    alignDword();
    writeDword(WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON);
    writeDword(0);
    writeShort(55);
    writeShort(50);
    writeShort(50);
    writeShort(14);
    writeWord(IDOK);
    writeWord(0xFFFF); writeWord(0x0080);  // BUTTON class
    writeWstr(L"OK");
    writeWord(0);

    // ── Control 6: BUTTON "Cancel" ──
    alignDword();
    writeDword(WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON);
    writeDword(0);
    writeShort(110);
    writeShort(50);
    writeShort(50);
    writeShort(14);
    writeWord(IDCANCEL);
    writeWord(0xFFFF); writeWord(0x0080);
    writeWstr(L"Cancel");
    writeWord(0);

    return DialogBoxIndirectParam(hInst, (LPCDLGTEMPLATE)buf, hParent, proc, lParam);
}

void CVideoSyncPlugin::showSettingsPopup() {
    // Get VDJ parent for centering
    HWND hParent = nullptr;
    double qRes = 0;
    if (GetInfo("get hwnd", &qRes) == S_OK)
        hParent = (HWND)(INT_PTR)qRes;

    SettingsData data;
    strncpy(data.ip,   paramIP_,   sizeof(data.ip));
    strncpy(data.port, paramPort_, sizeof(data.port));
    data.ip[sizeof(data.ip) - 1] = '\0';
    data.port[sizeof(data.port) - 1] = '\0';

    INT_PTR result = showModalDialog(
        (HINSTANCE)hInstance, hParent, SettingsDlgProc, (LPARAM)&data);

    if (result == IDOK) {
        strncpy(paramIP_,   data.ip,   kParamSize);
        strncpy(paramPort_, data.port, kParamSize);
        paramIP_[kParamSize - 1] = '\0';
        paramPort_[kParamSize - 1] = '\0';
        recreateClient();
    }
}

#endif

// ── macOS: open .ini in text editor ────────────────
#ifdef VDJ_MAC
#include <cstdlib>

void CVideoSyncPlugin::openIniFile() {
    // hInstance is a CFBundleRef on macOS.
    // Derive the .ini path: same folder as the .bundle, same name + ".ini"
    CFBundleRef bundle = (CFBundleRef)hInstance;
    CFURLRef bundleURL = CFBundleCopyBundleURL(bundle);
    if (!bundleURL) return;

    // Get the filesystem path of the .bundle directory
    char bundlePath[1024];
    if (!CFURLGetFileSystemRepresentation(bundleURL, true, (UInt8*)bundlePath, sizeof(bundlePath))) {
        CFRelease(bundleURL);
        return;
    }
    CFRelease(bundleURL);

    // bundlePath is e.g. "/path/to/Plugins64/SoundEffect/VdjVideoSync.bundle"
    // Strip the .bundle extension and append .ini
    std::string path(bundlePath);
    auto dotPos = path.rfind('.');
    if (dotPos != std::string::npos) {
        path = path.substr(0, dotPos);
    }
    path += ".ini";

    // Open in the default text editor
    std::string cmd = "open \"" + path + "\"";
    system(cmd.c_str());
}
#endif

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
    // Effect toggled ON in VirtualDJ – start sending data
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
