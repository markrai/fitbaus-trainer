// SPDX-License-Identifier: AGPL-3.0-only
#include <android/log.h>
#include <jni.h>
#include <libusb.h>
#include <libuvc/libuvc.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "uvc_negotiate.h"
#include "yuyv_nv21.h"

#define TAG "FitbausUvc"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

#define UVC_NEG_MAX_CANDIDATES 64

typedef struct {
  JavaVM *vm;
  jobject sink;
  jmethodID on_frame;
  jbyteArray nv21;
  jsize nv21_len;
  int width;
  int height;
  int fps;
  uvc_context_t *ctx;
  uvc_device_handle_t *device;
  atomic_int alive;
  atomic_int streaming;
} Uvc;

static void release_java_refs(JNIEnv *env, Uvc *u) {
  if (!env || !u) return;
  if (u->nv21) {
    (*env)->DeleteGlobalRef(env, u->nv21);
    u->nv21 = NULL;
  }
  if (u->sink) {
    (*env)->DeleteGlobalRef(env, u->sink);
    u->sink = NULL;
  }
}

static void append_candidate(UvcNegMode *modes, int *count, int format, int w, int h,
                             uint32_t interval_100ns) {
  if (!modes || !count || *count >= UVC_NEG_MAX_CANDIDATES) return;
  /* Never feed fps=0 into libuvc continuous negotiation (divides by fps). */
  if (!uvc_negotiate_interval_usable(interval_100ns)) return;
  modes[*count].format = format;
  modes[*count].width = w;
  modes[*count].height = h;
  modes[*count].interval_100ns = interval_100ns;
  (*count)++;
}

static void collect_yuyv_modes(uvc_device_handle_t *device, UvcNegMode *modes, int *count) {
  const uvc_format_desc_t *fmt;

  if (!device || !modes || !count) return;
  for (fmt = uvc_get_format_descs(device); fmt; fmt = fmt->next) {
    enum uvc_frame_format parsed;
    const uvc_frame_desc_t *frame;

    parsed = uvc_frame_format_for_guid((uint8_t *)fmt->guidFormat);
    if (parsed != UVC_FRAME_FORMAT_YUYV) continue;

    for (frame = fmt->frame_descs; frame; frame = frame->next) {
      if (frame->intervals) {
        uint32_t *iv;
        for (iv = frame->intervals; *iv != 0; iv++) {
          append_candidate(modes, count, UVC_NEG_FORMAT_YUYV, (int)frame->wWidth, (int)frame->wHeight,
                           *iv);
        }
      } else {
        uint32_t derived = uvc_negotiate_derive_interval(
            frame->dwDefaultFrameInterval, frame->dwMinFrameInterval, frame->dwMaxFrameInterval,
            frame->dwFrameIntervalStep);
        if (derived != 0) {
          append_candidate(modes, count, UVC_NEG_FORMAT_YUYV, (int)frame->wWidth, (int)frame->wHeight,
                           derived);
        }
      }
    }
  }
}

static void log_mode_list(const UvcNegMode *modes, const int *order, int n) {
  int i;
  for (i = 0; i < n && i < 12; i++) {
    const UvcNegMode *m = &modes[order[i]];
    LOGI("candidate[%d] %dx%d libuvc_fps=%d approx_fps=%d interval=%u", i, m->width, m->height,
         uvc_negotiate_libuvc_fps(m->interval_100ns), uvc_negotiate_approx_fps(m->interval_100ns),
         (unsigned)m->interval_100ns);
  }
}

static int try_probe_mode(uvc_device_handle_t *device, const UvcNegMode *mode, uvc_stream_ctrl_t *ctrl) {
  int fps = uvc_negotiate_libuvc_fps(mode->interval_100ns);
  /* fps<=0 would hit libuvc's continuous path as 10000000/fps — refuse. */
  if (fps <= 0) return 0;
  return uvc_get_stream_ctrl_format_size(device, ctrl, UVC_FRAME_FORMAT_YUYV, mode->width, mode->height,
                                         fps) == UVC_SUCCESS;
}

static int alloc_nv21(JNIEnv *env, Uvc *u, int width, int height) {
  size_t nv21_need;
  jbyteArray local_nv21;

  if (u->nv21) {
    (*env)->DeleteGlobalRef(env, u->nv21);
    u->nv21 = NULL;
    u->nv21_len = 0;
  }
  nv21_need = yuyv_nv21_size(width, height);
  if (nv21_need == 0 || nv21_need > (size_t)0x7fffffff) return -1;
  local_nv21 = (*env)->NewByteArray(env, (jsize)nv21_need);
  if (!local_nv21) return -1;
  u->nv21 = (*env)->NewGlobalRef(env, local_nv21);
  (*env)->DeleteLocalRef(env, local_nv21);
  if (!u->nv21) return -1;
  u->nv21_len = (jsize)nv21_need;
  u->width = width;
  u->height = height;
  return 0;
}

/*
 * Lifecycle contract (no callback↔close mutex):
 * - frame_cb observes alive and must never call UvcNative.close (host posts close elsewhere).
 * - close sets alive=0, then uvc_stop_streaming (joins in-flight callbacks), then frees.
 */
static void frame_cb(uvc_frame_t *in, void *opaque) {
  Uvc *u = (Uvc *)opaque;
  JNIEnv *env = NULL;
  int attached = 0;
  jint get_env;
  jbyte *out;
  int rc;
  int stride;
  jobject sink;
  jmethodID on_frame;
  jbyteArray nv21;
  jsize nv21_len;

  if (!u || !atomic_load(&u->alive)) return;
  if (!in || !in->data || in->frame_format != UVC_FRAME_FORMAT_YUYV) return;
  if ((int)in->width != u->width || (int)in->height != u->height) return;

  stride = in->step > 0u ? (int)in->step : u->width * 2;
  if ((size_t)in->data_bytes < (size_t)stride * (size_t)u->height) return;
  if (yuyv_packed_size(u->width, u->height) == 0) return;

  sink = u->sink;
  on_frame = u->on_frame;
  nv21 = u->nv21;
  nv21_len = u->nv21_len;
  if (!sink || !on_frame || !nv21) return;

  get_env = (*u->vm)->GetEnv(u->vm, (void **)&env, JNI_VERSION_1_6);
  if (get_env == JNI_EDETACHED) {
    if ((*u->vm)->AttachCurrentThread(u->vm, &env, NULL) != JNI_OK || !env) return;
    attached = 1;
  } else if (get_env != JNI_OK || !env) {
    return;
  }

  if (!atomic_load(&u->alive)) {
    if (attached) (*u->vm)->DetachCurrentThread(u->vm);
    return;
  }

  out = (*env)->GetByteArrayElements(env, nv21, NULL);
  if (!out) {
    if (attached) (*u->vm)->DetachCurrentThread(u->vm);
    return;
  }

  rc = yuyv_to_nv21((const uint8_t *)in->data, u->width, u->height, stride, (uint8_t *)out,
                    (size_t)nv21_len);
  (*env)->ReleaseByteArrayElements(env, nv21, out, rc == YUYV_NV21_OK ? 0 : JNI_ABORT);
  if (rc == YUYV_NV21_OK && atomic_load(&u->alive)) {
    (*env)->CallVoidMethod(env, sink, on_frame, nv21, (jint)u->width, (jint)u->height);
    if ((*env)->ExceptionCheck(env)) {
      (*env)->ExceptionDescribe(env);
      (*env)->ExceptionClear(env);
    }
  }

  if (attached) (*u->vm)->DetachCurrentThread(u->vm);
}

static void ensure_not_streaming(Uvc *u) {
  if (!u) return;
  atomic_store(&u->alive, 0);
  if (atomic_exchange(&u->streaming, 0) && u->device) {
    uvc_stop_streaming(u->device);
  }
}

static void shutdown_usb(Uvc *u) {
  if (!u) return;
  ensure_not_streaming(u);
  if (u->device) {
    uvc_close(u->device);
    u->device = NULL;
  }
  if (u->ctx) {
    uvc_exit(u->ctx);
    u->ctx = NULL;
  }
}

static int start_ranked_modes(JNIEnv *env, Uvc *u, const UvcNegMode *modes, const int *order, int n) {
  int i;

  for (i = 0; i < n; i++) {
    const UvcNegMode *mode = &modes[order[i]];
    uvc_stream_ctrl_t ctrl;
    int approx = uvc_negotiate_approx_fps(mode->interval_100ns);
    int lib_fps = uvc_negotiate_libuvc_fps(mode->interval_100ns);

    memset(&ctrl, 0, sizeof(ctrl));
    ensure_not_streaming(u);

    if (!try_probe_mode(u->device, mode, &ctrl)) {
      LOGW("probe failed %dx%d libuvc_fps=%d", mode->width, mode->height, lib_fps);
      continue;
    }
    if (alloc_nv21(env, u, mode->width, mode->height) != 0) {
      LOGW("nv21 alloc failed %dx%d", mode->width, mode->height);
      continue;
    }

    atomic_store(&u->alive, 1);
    if (uvc_start_streaming(u->device, &ctrl, frame_cb, u, 0) < 0) {
      LOGW("start_streaming failed %dx%d@%d", mode->width, mode->height, approx);
      atomic_store(&u->alive, 0);
      atomic_store(&u->streaming, 0);
      /* uvc_start_streaming closes its stream handle on failure; ensure no live callback path. */
      continue;
    }
    atomic_store(&u->streaming, 1);
    u->fps = approx;
    LOGI("open ok %dx%d@%d YUYV (libuvc_fps=%d interval=%u try=%d/%d)", u->width, u->height, u->fps,
         lib_fps, (unsigned)mode->interval_100ns, i + 1, n);
    return 0;
  }
  return -1;
}

JNIEXPORT jlong JNICALL Java_com_fitbaus_arcade_UvcNative_open(JNIEnv *env, jclass cls, jint fd,
                                                              jobject sink) {
  Uvc *u;
  UvcNegMode modes[UVC_NEG_MAX_CANDIDATES];
  int order[UVC_NEG_MAX_CANDIDATES];
  int count = 0;
  int ranked;
  jobject local_sink_ref;
  jclass sink_class;

  (void)cls;
  if (!env || fd < 0 || !sink) return 0;

  u = calloc(1, sizeof(*u));
  if (!u) return 0;
  atomic_init(&u->alive, 0);
  atomic_init(&u->streaming, 0);

  if ((*env)->GetJavaVM(env, &u->vm) != 0) goto bad;

  local_sink_ref = (*env)->NewGlobalRef(env, sink);
  if (!local_sink_ref) goto bad;
  u->sink = local_sink_ref;

  sink_class = (*env)->GetObjectClass(env, sink);
  if (!sink_class) goto bad;
  u->on_frame = (*env)->GetMethodID(env, sink_class, "onFrame", "([BII)V");
  (*env)->DeleteLocalRef(env, sink_class);
  if (!u->on_frame) goto bad;

  if (uvc_init(&u->ctx, NULL) < 0) goto bad;
  if (uvc_wrap(fd, u->ctx, &u->device) < 0) goto bad;

  collect_yuyv_modes(u->device, modes, &count);
  ranked = uvc_negotiate_rank(modes, count, order, UVC_NEG_MAX_CANDIDATES);
  LOGI("enumerated %d YUYV candidates, %d usable", count, ranked);
  log_mode_list(modes, order, ranked);
  if (ranked <= 0) {
    LOGE("no suitable YUYV mode");
    goto bad;
  }
  if (start_ranked_modes(env, u, modes, order, ranked) != 0) {
    LOGE("all %d ranked modes failed", ranked);
    goto bad;
  }
  return (jlong)(intptr_t)u;

bad:
  LOGE("open failed");
  if (u) {
    shutdown_usb(u);
    release_java_refs(env, u);
    free(u);
  }
  return 0;
}

JNIEXPORT jint JNICALL Java_com_fitbaus_arcade_UvcNative_negotiatedWidth(JNIEnv *env, jclass cls,
                                                                        jlong handle) {
  Uvc *u = (Uvc *)(intptr_t)handle;
  (void)env;
  (void)cls;
  return u ? u->width : 0;
}

JNIEXPORT jint JNICALL Java_com_fitbaus_arcade_UvcNative_negotiatedHeight(JNIEnv *env, jclass cls,
                                                                         jlong handle) {
  Uvc *u = (Uvc *)(intptr_t)handle;
  (void)env;
  (void)cls;
  return u ? u->height : 0;
}

JNIEXPORT void JNICALL Java_com_fitbaus_arcade_UvcNative_close(JNIEnv *env, jclass cls, jlong handle) {
  Uvc *u = (Uvc *)(intptr_t)handle;
  (void)cls;
  if (!u) return;
  shutdown_usb(u);
  release_java_refs(env, u);
  free(u);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
  int opt;
  (void)vm;
  (void)reserved;
  opt = libusb_set_option(NULL, LIBUSB_OPTION_NO_DEVICE_DISCOVERY, NULL);
  if (opt != LIBUSB_SUCCESS) {
    LOGE("libusb_set_option(NO_DEVICE_DISCOVERY)=%d", opt);
  } else {
    LOGI("libusb NO_DEVICE_DISCOVERY enabled");
  }
  return JNI_VERSION_1_6;
}
