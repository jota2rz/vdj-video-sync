cmake_minimum_required(VERSION 3.20)
project(VdjVideoSync VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Sources ──────────────────────────────────────────────
set(SOURCES
    src/main.cpp
    src/VideoSyncPlugin.cpp
)

# Windows module-definition file (exports DllGetClassObject)
if(WIN32)
    list(APPEND SOURCES src/VdjVideoSync.def)
endif()

# MODULE (not SHARED) so macOS produces a loadable .bundle via BUNDLE TRUE,
# and Windows still produces a .dll loaded by VDJ via LoadLibrary.
add_library(${PROJECT_NAME} MODULE ${SOURCES})

# ── Include paths ────────────────────────────────────────
target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../VirtualDJ8_SDK_20211003
    ${CMAKE_CURRENT_SOURCE_DIR}/vendor
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# ── Platform-specific ───────────────────────────────────
if(WIN32)
    # cpp-httplib needs ws2_32 on Windows
    target_link_libraries(${PROJECT_NAME} PRIVATE ws2_32)
    set_target_properties(${PROJECT_NAME} PROPERTIES
        PREFIX ""
        OUTPUT_NAME "VdjVideoSync"
        SUFFIX ".dll"
    )
    target_compile_definitions(${PROJECT_NAME} PRIVATE
        _CRT_SECURE_NO_WARNINGS
    )
elseif(APPLE)
    # VirtualDJ macOS plugins are CFBundle (.bundle) files.
    # Based on: https://github.com/szemek/virtualdj-plugins-examples
    set_target_properties(${PROJECT_NAME} PROPERTIES
        BUNDLE TRUE
        BUNDLE_EXTENSION "bundle"
        PREFIX ""
        OUTPUT_NAME "VdjVideoSync"
        # Hide symbols by default; VDJ_EXPORT opens DllGetClassObject
        CXX_VISIBILITY_PRESET hidden
        # Bundle metadata
        MACOSX_BUNDLE_GUI_IDENTIFIER "com.vdjvideosync.plugin"
        MACOSX_BUNDLE_BUNDLE_NAME "VdjVideoSync"
        MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
        MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/src/Info.plist.in"
    )
    # macOS minimum deployment target (consistent with VDJ SDK examples)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "10.13" CACHE STRING "" FORCE)
else()
    # Linux: only for CodeQL static analysis — not a real build target.
    # VirtualDJ only runs on Windows and macOS.
    set_target_properties(${PROJECT_NAME} PROPERTIES
        PREFIX ""
        OUTPUT_NAME "VdjVideoSync"
        SUFFIX ".so"
    )
endif()

# ── Output directory ────────────────────────────────────
set_target_properties(${PROJECT_NAME} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
)
