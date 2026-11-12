// SPDX-License-Identifier: AGPL-3.0-only
#include "yuyv_nv21.h"

#include <stdint.h>

size_t yuyv_nv21_size(int width, int height) {
  if (width < 2 || height < 2 || (width & 1) || (height & 1)) return 0;
  if (width > 16384 || height > 16384) return 0;
  size_t pixels = (size_t)width * (size_t)height;
  if (pixels / (size_t)width != (size_t)height) return 0;
  if (pixels > (SIZE_MAX / 3) * 2) return 0;
  return pixels + pixels / 2;
}

size_t yuyv_packed_size(int width, int height) {
  if (width < 2 || height < 2 || (width & 1) || (height & 1)) return 0;
  if (width > 16384 || height > 16384) return 0;
  size_t row = (size_t)width * 2u;
  if (row / 2u != (size_t)width) return 0;
  if (row > SIZE_MAX / (size_t)height) return 0;
  return row * (size_t)height;
}

int yuyv_to_nv21(const uint8_t *yuyv, int width, int height, int yuyv_stride, uint8_t *nv21,
                 size_t nv21_cap) {
  size_t need;
  size_t pixels;
  int stride;
  int row;
  int x;
  uint8_t *y_plane;
  uint8_t *vu;

  if (!yuyv || !nv21) return YUYV_NV21_ERR_NULL;
  need = yuyv_nv21_size(width, height);
  if (need == 0) return YUYV_NV21_ERR_DIMS;
  if (nv21_cap < need) return YUYV_NV21_ERR_SIZE;

  stride = yuyv_stride == 0 ? width * 2 : yuyv_stride;
  if (stride < width * 2 || (stride & 1)) return YUYV_NV21_ERR_STRIDE;
  if ((size_t)stride > SIZE_MAX / (size_t)height) return YUYV_NV21_ERR_OVERFLOW;

  pixels = (size_t)width * (size_t)height;
  y_plane = nv21;
  vu = nv21 + pixels;

  for (row = 0; row < height; row += 2) {
    const uint8_t *a = yuyv + (size_t)row * (size_t)stride;
    const uint8_t *b = a + (size_t)stride;
    for (x = 0; x < width; x += 2) {
      const uint8_t *p0 = a + (size_t)x * 2u;
      const uint8_t *p1 = b + (size_t)x * 2u;
      /* YUYV: Y0 U0 Y1 V0 */
      y_plane[(size_t)row * (size_t)width + (size_t)x] = p0[0];
      y_plane[(size_t)row * (size_t)width + (size_t)x + 1u] = p0[2];
      y_plane[(size_t)(row + 1) * (size_t)width + (size_t)x] = p1[0];
      y_plane[(size_t)(row + 1) * (size_t)width + (size_t)x + 1u] = p1[2];
      /* NV21 chroma: V, U */
      *vu++ = p0[3];
      *vu++ = p0[1];
    }
  }
  return YUYV_NV21_OK;
}
