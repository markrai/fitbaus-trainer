cmake_minimum_required(VERSION 3.22.1)
project(fitbaus_arcade_hand C)

# UVC webcam path wraps an already-authorized USB Host file descriptor; libusb
# must never enumerate /dev/bus/usb. Dependencies are URL-pinned with SHA-256 so
# a clean checkout builds without a local git cache or shallow commit clone.

include(FetchContent)

# libusb 1.0.30 via libusb-cmake v1.0.30-0 (commit bd098071279b954acd491a4da34fd999b66a5afb).
# LGPL-2.1-or-later: statically linked into fitbaus_arcade_hand; see NOTICE.txt.
set(LIBUSB_BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LIBUSB_INSTALL_TARGETS OFF CACHE BOOL "" FORCE)
set(LIBUSB_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(LIBUSB_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LIBUSB_ENABLE_UDEV OFF CACHE BOOL "" FORCE)
FetchContent_Declare(libusb
  URL https://github.com/libusb/libusb-cmake/archive/refs/tags/v1.0.30-0.tar.gz
  URL_HASH SHA256=c8143ceba42b7b93d484ccd09db7be261bb9b15f61dae5fdc605a01a6913bada
)
FetchContent_MakeAvailable(libusb)
if(NOT TARGET LibUSB::LibUSB)
  add_library(LibUSB::LibUSB ALIAS usb-1.0)
endif()

# libuvc f1434af4b7040988de716b8b95f85d4d58c0219f — BSD-style license.
set(CMAKE_BUILD_TARGET Static CACHE STRING "" FORCE)
set(BUILD_EXAMPLE OFF CACHE BOOL "" FORCE)
set(BUILD_TEST OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_FUZZERS OFF CACHE BOOL "" FORCE)
set(LIBUVC_INSTALL OFF CACHE BOOL "" FORCE)
set(DISABLE_JPEG ON CACHE BOOL "" FORCE)
set(LIBUVC_PACKETS_PER_TRANSFER_MAX 8 CACHE STRING "" FORCE)
FetchContent_Declare(libuvc
  URL https://github.com/libuvc/libuvc/archive/f1434af4b7040988de716b8b95f85d4d58c0219f.tar.gz
  URL_HASH SHA256=9346e43730c88b5b5e72cbdd1bdf056f3bfb2f350aae1a333b6b4ba63fa54343
)
FetchContent_MakeAvailable(libuvc)

add_library(fitbaus_arcade_hand SHARED
  hand_pipeline.c
  arcade_jni.c
  yuyv_nv21.c
  uvc_negotiate.c
  uvc_jni.c
)
target_compile_options(fitbaus_arcade_hand PRIVATE -O2 -Wall -Wextra -Werror -fvisibility=hidden)
target_link_options(fitbaus_arcade_hand PRIVATE -Wl,--exclude-libs,ALL)
target_link_libraries(fitbaus_arcade_hand PRIVATE
  LibUVC::UVCStatic
  LibUSB::LibUSB
  dl
  log
  m
)
