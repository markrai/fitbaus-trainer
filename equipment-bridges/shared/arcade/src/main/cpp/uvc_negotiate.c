// SPDX-License-Identifier: AGPL-3.0-only
#include "uvc_negotiate.h"

#define PREF_W 320
#define PREF_H 240
#define PREF_FPS 30
#define PREF_INTERVAL_30 333333u
/* Soft cap: larger YUYV burns USB + NV21 RAM on API 22 x86. */
#define MAX_PIXELS (640 * 480)
#define SCORE_REJECT ((long long)0x7fffffffffffffffLL)

static int is_even_positive(int v) { return v >= 2 && (v % 2) == 0; }

int uvc_negotiate_libuvc_fps(uint32_t interval_100ns) {
  if (interval_100ns == 0) return 0;
  /* Must match libuvc stream.c: 10000000 / *interval == (unsigned int) fps */
  return (int)(10000000u / interval_100ns);
}

int uvc_negotiate_approx_fps(uint32_t interval_100ns) {
  if (interval_100ns == 0) return 0;
  return (int)((10000000u + interval_100ns / 2u) / interval_100ns);
}

int uvc_negotiate_interval_usable(uint32_t interval_100ns) {
  return uvc_negotiate_libuvc_fps(interval_100ns) > 0;
}

/**
 * Continuous descriptor candidate must be usable for libuvc fps matching and lie on the
 * advertised [min,max] lattice (min + n*step). max==0 means no upper bound.
 */
static int interval_fits_continuous(uint32_t iv, uint32_t min_iv, uint32_t max_iv, uint32_t step) {
  if (!uvc_negotiate_interval_usable(iv)) return 0;
  /* min=max=0 means no continuous range was advertised. */
  if (min_iv == 0 && max_iv == 0) return 0;
  if (iv < min_iv) return 0;
  if (max_iv != 0 && iv > max_iv) return 0;
  if (step != 0 && ((iv - min_iv) % step) != 0) return 0;
  return 1;
}

uint32_t uvc_negotiate_derive_interval(uint32_t default_iv, uint32_t min_iv, uint32_t max_iv,
                                       uint32_t step) {
  if (interval_fits_continuous(default_iv, min_iv, max_iv, step)) return default_iv;
  if (interval_fits_continuous(min_iv, min_iv, max_iv, step)) return min_iv;
  /* Prefer ~30 fps only when it is on the advertised continuous lattice. */
  if (interval_fits_continuous(PREF_INTERVAL_30, min_iv, max_iv, step)) return PREF_INTERVAL_30;
  return 0;
}

static long long score_mode(const UvcNegMode *m) {
  long long score;
  long long pixels;
  int dw;
  int dh;
  int fps;
  int dfps;

  if (!m) return SCORE_REJECT;
  if (m->format != UVC_NEG_FORMAT_YUYV) return SCORE_REJECT;
  if (!is_even_positive(m->width) || !is_even_positive(m->height)) return SCORE_REJECT;
  if (!uvc_negotiate_interval_usable(m->interval_100ns)) return SCORE_REJECT;

  pixels = (long long)m->width * (long long)m->height;
  if (pixels <= 0 || pixels > MAX_PIXELS) return SCORE_REJECT;

  fps = uvc_negotiate_approx_fps(m->interval_100ns);

  /*
   * Responsive tracking outweighs exact 320×240. A 320×240@5 mode must lose to a
   * nearby resolution that sustains ~24–30 fps.
   */
  if (fps > 0 && fps < 10) {
    score = 5000000LL;
  } else if (fps > 0 && fps < 15) {
    score = 800000LL;
  } else {
    score = 0;
  }

  dw = m->width - PREF_W;
  if (dw < 0) dw = -dw;
  dh = m->height - PREF_H;
  if (dh < 0) dh = -dh;
  score += (long long)dw * 80 + (long long)dh * 80;
  score += pixels / 50;

  if (fps > 0) {
    dfps = fps - PREF_FPS;
    if (dfps < 0) dfps = -dfps;
    score += (long long)dfps * 2500;
  } else {
    score += 20000;
  }
  return score;
}

int uvc_negotiate_rank(const UvcNegMode *modes, int count, int *order, int order_cap) {
  int i;
  int n = 0;
  int a;
  int b;
  int tmp;
  long long sa;
  long long sb;

  if (!modes || !order || count <= 0 || order_cap <= 0) return 0;

  for (i = 0; i < count && n < order_cap; i++) {
    if (score_mode(&modes[i]) == SCORE_REJECT) continue;
    order[n++] = i;
  }

  /* Stable insertion sort by ascending score. */
  for (i = 1; i < n; i++) {
    tmp = order[i];
    b = i;
    while (b > 0) {
      a = b - 1;
      sa = score_mode(&modes[order[a]]);
      sb = score_mode(&modes[tmp]);
      if (sa <= sb) break;
      order[b] = order[a];
      b = a;
    }
    order[b] = tmp;
  }
  return n;
}

int uvc_negotiate_pick(const UvcNegMode *modes, int count, UvcNegMode *out) {
  int order[64];
  int n;

  if (!out) return 0;
  n = uvc_negotiate_rank(modes, count, order, 64);
  if (n <= 0) return 0;
  *out = modes[order[0]];
  return 1;
}
