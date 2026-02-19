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

add_library(${PROJECT_NAME} SHARED ${SOURCES})

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
    # VirtualDJ macOS plugins are .bundle files
    set_target_properties(${PROJECT_NAME} PROPERTIES
        PREFIX ""
        OUTPUT_NAME "VdjVideoSync"
        SUFFIX ".bundle"
        # Hide symbols by default; VDJ_EXPORT opens DllGetClassObject
        CXX_VISIBILITY_PRESET hidden
    )
else()
    message(FATAL_ERROR "VirtualDJ only runs on Windows and macOS. This plugin cannot be built on ${CMAKE_SYSTEM_NAME}.")
endif()

# ── Output directory ────────────────────────────────────
set_target_properties(${PROJECT_NAME} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out"
)
