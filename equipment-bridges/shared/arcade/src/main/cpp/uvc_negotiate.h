// SPDX-License-Identifier: AGPL-3.0-only
#ifndef FITBAUS_UVC_NEGOTIATE_H
#define FITBAUS_UVC_NEGOTIATE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Preferred uncompressed mode for the arcade NV21 consumer. */
enum {
  UVC_NEG_FORMAT_YUYV = 1,
};

typedef struct {
  int format; /* UVC_NEG_FORMAT_* */
  int width;
  int height;
  /** Raw UVC frame interval in 100ns units; must be usable (see below). */
  uint32_t interval_100ns;
} UvcNegMode;

/**
 * libuvc discrete matching uses integer truncation: (10000000 / interval) == fps.
 * Returns that truncated value, or 0 when interval is 0 / too large.
 */
int uvc_negotiate_libuvc_fps(uint32_t interval_100ns);

/** Rounded fps for scoring / logging (nearest int), or 0 if unknown. */
int uvc_negotiate_approx_fps(uint32_t interval_100ns);

/**
 * True when [interval_100ns] yields a positive libuvc fps.
 * Zero / oversized intervals are rejected so callers never pass fps=0 into
 * libuvc's continuous-frame path (which divides by fps).
 */
int uvc_negotiate_interval_usable(uint32_t interval_100ns);

/**
 * Choose a usable interval for continuous descriptors (intervals array null).
 * Candidates must yield a positive libuvc fps (10000000/interval) and obey
 * min/max/step (iv >= min, iv <= max when max!=0, (iv-min)%step==0 when step!=0).
 * Prefers default, then min, then a ~30 fps lattice point. Returns 0 when none fit.
 */
uint32_t uvc_negotiate_derive_interval(uint32_t default_iv, uint32_t min_iv, uint32_t max_iv,
                                       uint32_t step);

/**
 * Rank usable modes into [order] (best first). Returns the number of ranked
 * entries written (may be less than [count] when some are rejected).
 */
int uvc_negotiate_rank(const UvcNegMode *modes, int count, int *order, int order_cap);

/**
 * Convenience: write the single best mode to [out]. Returns 1 on success.
 */
int uvc_negotiate_pick(const UvcNegMode *modes, int count, UvcNegMode *out);

#ifdef __cplusplus
}
#endif

#endif
