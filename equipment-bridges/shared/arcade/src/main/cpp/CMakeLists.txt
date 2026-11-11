cmake_minimum_required(VERSION 3.22.1)
project(fitbaus_arcade_hand C)

add_library(fitbaus_arcade_hand SHARED hand_pipeline.c arcade_jni.c)
target_compile_options(fitbaus_arcade_hand PRIVATE -O2 -Wall -Wextra -Werror -fvisibility=hidden)
target_link_libraries(fitbaus_arcade_hand dl log m)
