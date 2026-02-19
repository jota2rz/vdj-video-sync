//////////////////////////////////////////////////////////////////////////
// DLL Entry Point – DllGetClassObject
//
// VirtualDJ calls this to instantiate the plugin.
// This follows the standard COM-style pattern from the SDK examples.
//////////////////////////////////////////////////////////////////////////

#include "VideoSyncPlugin.h"
#include "vdjDsp8.h"
#include <cstring>  // memcmp (implicit on Windows via windows.h, explicit for macOS)

VDJ_EXPORT HRESULT VDJ_API DllGetClassObject(
    const GUID& rclsid,
    const GUID& riid,
    void**      ppObject)
{
    if (memcmp(&rclsid, &CLSID_VdjPlugin8, sizeof(GUID)) == 0
        && memcmp(&riid, &IID_IVdjPluginDsp8, sizeof(GUID)) == 0)
    {
        *ppObject = new CVideoSyncPlugin();
    }
    else
    {
        return CLASS_E_CLASSNOTAVAILABLE;
    }

    return NO_ERROR;
}
