cmake_minimum_required(VERSION 3.22.1)
project(fitbaus_arcade_hand C)

# Kept as source dependencies: the Android backend must wrap the file
# descriptor granted by UsbManager, never enumerate /dev/bus/usb itself.
include(FetchContent)
FetchContent_Declare(libusb
    GIT_REPOSITORY https://github.com/libusb/libusb-cmake.git
    GIT_TAG v1.0.30
    GIT_SHALLOW TRUE
    GIT_SUBMODULES "libusb"
)
FetchContent_MakeAvailable(libusb)
add_library(LibUSB::LibUSB ALIAS usb-1.0)
FetchContent_Declare(libuvc
    GIT_REPOSITORY https://github.com/libuvc/libuvc.git
    GIT_TAG f1434af
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(libuvc)

add_library(fitbaus_arcade_hand SHARED hand_pipeline.c arcade_jni.c uvc_jni.c)
target_compile_options(fitbaus_arcade_hand PRIVATE -O2 -Wall -Wextra -Werror -fvisibility=hidden)
target_link_libraries(fitbaus_arcade_hand PRIVATE uvc dl log m)
