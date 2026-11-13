// SPDX-License-Identifier: AGPL-3.0-only
#include <stdio.h>

#include "uvc_negotiate.h"

static int failures;

static void expect_eq(int got, int want, const char *name) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %d want %d\n", name, got, want);
    failures++;
  }
}

static void expect_eq_u(unsigned got, unsigned want, const char *name) {
  if (got != want) {
    fprintf(stderr, "FAIL %s: got %u want %u\n", name, got, want);
    failures++;
  }
}

static void test_libuvc_fps_truncation(void) {
  /* Exact 30 fps */
  expect_eq(uvc_negotiate_libuvc_fps(333333u), 30, "30fps trunc");
  expect_eq(uvc_negotiate_approx_fps(333333u), 30, "30fps approx");

  /* NTSC 29.97: interval 333667 → libuvc matches fps==29, not 30 */
  expect_eq_u(333667u, 333667u, "interval fixture");
  expect_eq(uvc_negotiate_libuvc_fps(333667u), 29, "29.97 libuvc fps");
  expect_eq(uvc_negotiate_approx_fps(333667u), 30, "29.97 approx");

  /* 24 fps */
  expect_eq(uvc_negotiate_libuvc_fps(416666u), 24, "24fps trunc");
  expect_eq(uvc_negotiate_approx_fps(416666u), 24, "24fps approx");

  /* Unusual 7.5 fps */
  expect_eq(uvc_negotiate_libuvc_fps(1333333u), 7, "7.5 libuvc");
  expect_eq(uvc_negotiate_approx_fps(1333333u), 8, "7.5 approx");

  expect_eq(uvc_negotiate_libuvc_fps(0), 0, "zero interval");
}

static void test_prefers_responsive_nearby_over_exact_low_fps(void) {
  UvcNegMode modes[] = {
      {UVC_NEG_FORMAT_YUYV, 320, 240, 2000000u}, /* 5 fps exact size — bad for tracking */
      {UVC_NEG_FORMAT_YUYV, 352, 288, 333333u},  /* ~30 fps nearby */
      {UVC_NEG_FORMAT_YUYV, 640, 480, 666666u},  /* 15 fps */
  };
  UvcNegMode out;
  expect_eq(uvc_negotiate_pick(modes, 3, &out), 1, "pick ok");
  expect_eq(out.width, 352, "w");
  expect_eq(out.height, 288, "h");
}

static void test_prefers_320x240_near_30(void) {
  UvcNegMode modes[] = {
      {UVC_NEG_FORMAT_YUYV, 640, 480, 333333u},
      {UVC_NEG_FORMAT_YUYV, 320, 240, 666666u}, /* 15 fps */
      {UVC_NEG_FORMAT_YUYV, 320, 240, 333333u}, /* 30 fps */
      {UVC_NEG_FORMAT_YUYV, 160, 120, 333333u},
  };
  UvcNegMode out;
  expect_eq(uvc_negotiate_pick(modes, 4, &out), 1, "pick ok");
  expect_eq(out.width, 320, "w");
  expect_eq(out.height, 240, "h");
  expect_eq(uvc_negotiate_approx_fps(out.interval_100ns), 30, "fps");
}

static void test_accepts_2997_and_24(void) {
  UvcNegMode ntsc[] = {
      {UVC_NEG_FORMAT_YUYV, 320, 240, 333667u}, /* 29.97 */
      {UVC_NEG_FORMAT_YUYV, 640, 480, 333333u},
  };
  UvcNegMode film[] = {
      {UVC_NEG_FORMAT_YUYV, 320, 240, 416666u}, /* 24 */
      {UVC_NEG_FORMAT_YUYV, 160, 120, 333333u},
  };
  UvcNegMode out;
  expect_eq(uvc_negotiate_pick(ntsc, 2, &out), 1, "ntsc pick");
  expect_eq(out.width, 320, "ntsc w");
  expect_eq(uvc_negotiate_libuvc_fps(out.interval_100ns), 29, "ntsc libuvc");

  expect_eq(uvc_negotiate_pick(film, 2, &out), 1, "24 pick");
  expect_eq(out.width, 320, "24 w");
  expect_eq(uvc_negotiate_libuvc_fps(out.interval_100ns), 24, "24 libuvc");
}

/* Pro 9000-like fixture subset (YUYV intervals as 100ns). */
static void test_pro9000_like_modes(void) {
  UvcNegMode modes[] = {
      {UVC_NEG_FORMAT_YUYV, 640, 480, 333333u},
      {UVC_NEG_FORMAT_YUYV, 160, 120, 333333u},
      {UVC_NEG_FORMAT_YUYV, 176, 144, 333333u},
      {UVC_NEG_FORMAT_YUYV, 320, 240, 333333u},
      {UVC_NEG_FORMAT_YUYV, 352, 288, 333333u},
      {UVC_NEG_FORMAT_YUYV, 1280, 720, 2000000u}, /* over soft cap */
  };
  UvcNegMode out;
  expect_eq(uvc_negotiate_pick(modes, 6, &out), 1, "pick ok");
  expect_eq(out.width, 320, "w");
  expect_eq(out.height, 240, "h");
}

static void test_rank_orders_retries(void) {
  UvcNegMode modes[] = {
      {UVC_NEG_FORMAT_YUYV, 320, 240, 2000000u}, /* 5 fps */
      {UVC_NEG_FORMAT_YUYV, 320, 240, 333333u},  /* 30 fps */
      {UVC_NEG_FORMAT_YUYV, 640, 480, 333333u},
  };
  int order[8];
  int n = uvc_negotiate_rank(modes, 3, order, 8);
  expect_eq(n, 3, "ranked 3");
  expect_eq(modes[order[0]].width, 320, "best w");
  expect_eq(uvc_negotiate_approx_fps(modes[order[0]].interval_100ns), 30, "best fps");
  /* Low-fps exact size should not be first. */
  expect_eq(uvc_negotiate_approx_fps(modes[order[0]].interval_100ns) != 5, 1, "not 5fps first");
}

static void test_rejects_empty_and_odd(void) {
  UvcNegMode odd[] = {{UVC_NEG_FORMAT_YUYV, 321, 240, 333333u}};
  UvcNegMode out;
  expect_eq(uvc_negotiate_pick(odd, 1, &out), 0, "odd rejected");
  expect_eq(uvc_negotiate_pick(NULL, 0, &out), 0, "empty rejected");
}

static void test_rejects_zero_and_unusable_intervals(void) {
  UvcNegMode zero[] = {{UVC_NEG_FORMAT_YUYV, 320, 240, 0u}};
  /* interval > 10_000_000 → truncated libuvc fps == 0 */
  UvcNegMode oversized[] = {{UVC_NEG_FORMAT_YUYV, 320, 240, 10000001u}};
  UvcNegMode mixed[] = {
      {UVC_NEG_FORMAT_YUYV, 320, 240, 0u},
      {UVC_NEG_FORMAT_YUYV, 320, 240, 333333u},
      {UVC_NEG_FORMAT_YUYV, 640, 480, 10000001u},
  };
  UvcNegMode out;

  expect_eq(uvc_negotiate_interval_usable(0u), 0, "zero unusable");
  expect_eq(uvc_negotiate_interval_usable(10000001u), 0, "oversized unusable");
  expect_eq(uvc_negotiate_interval_usable(333333u), 1, "30fps usable");

  expect_eq(uvc_negotiate_pick(zero, 1, &out), 0, "zero interval rejected");
  expect_eq(uvc_negotiate_pick(oversized, 1, &out), 0, "oversized rejected");
  expect_eq(uvc_negotiate_pick(mixed, 3, &out), 1, "mixed pick");
  expect_eq(out.width, 320, "mixed w");
  expect_eq_u(out.interval_100ns, 333333u, "mixed interval");
}

static void test_derive_continuous_intervals(void) {
  /* Default below advertised min must not win — fall back to min on the lattice. */
  expect_eq_u(uvc_negotiate_derive_interval(333333u, 666666u, 2000000u, 1u), 666666u,
              "default below min");
  /* Prefer in-range default when it obeys min/max/step and yields libuvc fps > 0. */
  expect_eq_u(uvc_negotiate_derive_interval(666666u, 333333u, 2000000u, 1u), 666666u, "default ok");
  expect_eq(uvc_negotiate_libuvc_fps(666666u), 15, "default libuvc fps");
  /* Fall back to min when default is zero/malformed. */
  expect_eq_u(uvc_negotiate_derive_interval(0u, 666666u, 2000000u, 1u), 666666u, "min");
  /* Prefer ~30 fps inside continuous range when default/min unusable. */
  expect_eq_u(uvc_negotiate_derive_interval(0u, 0u, 2000000u, 1u), 333333u, "pref30");
  expect_eq(uvc_negotiate_libuvc_fps(333333u), 30, "pref30 libuvc fps");
  /* Default not on step is rejected. */
  expect_eq_u(uvc_negotiate_derive_interval(350000u, 300000u, 600000u, 100000u), 300000u,
              "default off step");
  /* Reject fully malformed continuous descriptors. */
  expect_eq_u(uvc_negotiate_derive_interval(0u, 0u, 0u, 0u), 0u, "all zero");
  expect_eq_u(uvc_negotiate_derive_interval(10000001u, 10000001u, 10000001u, 0u), 0u, "all oversized");
  /* Prefer-30 must land on step; otherwise refuse rather than invent fps=0. */
  expect_eq_u(uvc_negotiate_derive_interval(0u, 0u, 500000u, 100000u), 0u, "bad step");
  expect_eq_u(uvc_negotiate_derive_interval(0u, 333333u, 666666u, 0u), 333333u, "min when step0");
  /* NTSC-ish continuous default must keep truncated libuvc fps matchable. */
  expect_eq_u(uvc_negotiate_derive_interval(333667u, 333667u, 666667u, 0u), 333667u, "ntsc default");
  expect_eq(uvc_negotiate_libuvc_fps(333667u), 29, "ntsc libuvc fps");
}

int main(void) {
  test_libuvc_fps_truncation();
  test_prefers_responsive_nearby_over_exact_low_fps();
  test_prefers_320x240_near_30();
  test_accepts_2997_and_24();
  test_pro9000_like_modes();
  test_rank_orders_retries();
  test_rejects_empty_and_odd();
  test_rejects_zero_and_unusable_intervals();
  test_derive_continuous_intervals();
  if (failures) {
    fprintf(stderr, "%d failure(s)\n", failures);
    return 1;
  }
  puts("uvc_negotiate_test ok");
  return 0;
}
