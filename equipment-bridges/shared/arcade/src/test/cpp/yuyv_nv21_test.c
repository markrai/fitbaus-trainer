// SPDX-License-Identifier: AGPL-3.0-only
#include <stdio.h>
#include <string.h>

#include "yuyv_nv21.h"

static int failures;

static void expect_eq(int got, int want, const char *name) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %d want %d\n", name, got, want);
    failures++;
  }
}

static void expect_size(size_t got, size_t want, const char *name) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %zu want %zu\n", name, got, want);
    failures++;
  }
}

/* 4x2 YUYV fixture:
 * row0: (Y=1,U=2,Y=3,V=4) (Y=5,U=6,Y=7,V=8)
 * row1: (Y=9,U=10,Y=11,V=12) (Y=13,U=14,Y=15,V=16)
 * Expected NV21 Y: 1,3,5,7, 9,11,13,15
 * Expected NV21 VU from even rows only: V4,U2, V8,U6
 */
static void test_valid_4x2(void) {
  const uint8_t yuyv[16] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
  uint8_t nv21[12];
  const uint8_t expect[12] = {1, 3, 5, 7, 9, 11, 13, 15, 4, 2, 8, 6};
  int rc = yuyv_to_nv21(yuyv, 4, 2, 0, nv21, sizeof(nv21));
  expect_eq(rc, YUYV_NV21_OK, "valid_4x2 rc");
  if (memcmp(nv21, expect, sizeof(expect)) != 0) {
    fprintf(stderr, "FAIL valid_4x2 payload mismatch\n");
    failures++;
  }
}

static void test_stride(void) {
  /* width=2 height=2 with stride 8 (padding after each packed pair) */
  uint8_t yuyv[16] = {0};
  yuyv[0] = 10;
  yuyv[1] = 20;
  yuyv[2] = 30;
  yuyv[3] = 40;
  yuyv[8] = 50;
  yuyv[9] = 60;
  yuyv[10] = 70;
  yuyv[11] = 80;
  uint8_t nv21[6];
  const uint8_t expect[6] = {10, 30, 50, 70, 40, 20};
  int rc = yuyv_to_nv21(yuyv, 2, 2, 8, nv21, sizeof(nv21));
  expect_eq(rc, YUYV_NV21_OK, "stride rc");
  if (memcmp(nv21, expect, sizeof(expect)) != 0) {
    fprintf(stderr, "FAIL stride payload mismatch\n");
    failures++;
  }
}

static void test_rejects(void) {
  uint8_t yuyv[8] = {0};
  uint8_t nv21[6] = {0};
  expect_eq(yuyv_to_nv21(NULL, 2, 2, 0, nv21, 6), YUYV_NV21_ERR_NULL, "null src");
  expect_eq(yuyv_to_nv21(yuyv, 2, 2, 0, NULL, 6), YUYV_NV21_ERR_NULL, "null dst");
  expect_eq(yuyv_to_nv21(yuyv, 3, 2, 0, nv21, 6), YUYV_NV21_ERR_DIMS, "odd width");
  expect_eq(yuyv_to_nv21(yuyv, 2, 1, 0, nv21, 6), YUYV_NV21_ERR_DIMS, "odd height");
  expect_eq(yuyv_to_nv21(yuyv, 0, 2, 0, nv21, 6), YUYV_NV21_ERR_DIMS, "zero width");
  expect_eq(yuyv_to_nv21(yuyv, 2, 2, 3, nv21, 6), YUYV_NV21_ERR_STRIDE, "short stride");
  expect_eq(yuyv_to_nv21(yuyv, 2, 2, 5, nv21, 6), YUYV_NV21_ERR_STRIDE, "odd stride");
  expect_eq(yuyv_to_nv21(yuyv, 2, 2, 0, nv21, 5), YUYV_NV21_ERR_SIZE, "small cap");
  expect_size(yuyv_nv21_size(320, 240), 115200u, "nv21 320x240");
  expect_size(yuyv_packed_size(320, 240), 153600u, "yuyv 320x240");
  expect_size(yuyv_nv21_size(-1, 240), 0u, "neg width size");
}

int main(void) {
  test_valid_4x2();
  test_stride();
  test_rejects();
  if (failures) {
    fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  puts("yuyv_nv21_test OK");
  return 0;
}
