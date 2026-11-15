// SPDX-License-Identifier: AGPL-3.0-only
#ifndef FITBAUS_YUYV_NV21_H
#define FITBAUS_YUYV_NV21_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Status codes for [yuyv_to_nv21]. */
enum {
  YUYV_NV21_OK = 0,
  YUYV_NV21_ERR_NULL = -1,
  YUYV_NV21_ERR_DIMS = -2,
  YUYV_NV21_ERR_STRIDE = -3,
  YUYV_NV21_ERR_SIZE = -4,
  YUYV_NV21_ERR_OVERFLOW = -5,
};

/**
 * Convert packed YUYV (Y0 U Y1 V) to NV21 (Y plane + interleaved V/U).
 *
 * @param yuyv        source bytes; at least height * yuyv_stride
 * @param width       even, >= 2
 * @param height      even, >= 2
 * @param yuyv_stride bytes per source row; 0 means width * 2; must be >= width * 2 and even
 * @param nv21        destination; at least width * height * 3 / 2 bytes
 * @param nv21_cap    capacity of nv21 in bytes
 */
int yuyv_to_nv21(const uint8_t *yuyv, int width, int height, int yuyv_stride, uint8_t *nv21,
                 size_t nv21_cap);

/** Required NV21 capacity for even positive dimensions, or 0 on overflow/invalid. */
size_t yuyv_nv21_size(int width, int height);

/** Required packed YUYV size for even positive dimensions with stride width*2, or 0. */
size_t yuyv_packed_size(int width, int height);

#ifdef __cplusplus
}
#endif

#endif
