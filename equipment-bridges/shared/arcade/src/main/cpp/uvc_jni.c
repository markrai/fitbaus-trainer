// SPDX-License-Identifier: AGPL-3.0-only
#include <android/log.h>
#include <jni.h>
#include <libusb.h>
#include <libuvc/libuvc.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "yuyv_nv21.h"

#define TAG "FitbausUvc"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

#define UVC_PROBE_WIDTH 320
#define UVC_PROBE_HEIGHT 240
#define UVC_PROBE_FPS 30

typedef struct {
  JavaVM *vm;
  jobject sink;
  jmethodID on_frame;
  jbyteArray nv21;
  jsize nv21_len;
  int width;
  int height;
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

/*
 * Lifecycle contract (no callback↔close mutex):
 * - frame_cb observes alive and must never call UvcNative.close (host posts close elsewhere).
 * - close sets alive=0, then uvc_stop_streaming (joins in-flight callbacks), then frees.
 * Holding a mutex across Sink.onFrame previously deadlocked when onFrame triggered close.
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

static void shutdown_usb(Uvc *u) {
  if (!u) return;
  atomic_store(&u->alive, 0);
  if (atomic_exchange(&u->streaming, 0) && u->device) {
    uvc_stop_streaming(u->device);
  }
  if (u->device) {
    uvc_close(u->device);
    u->device = NULL;
  }
  if (u->ctx) {
    uvc_exit(u->ctx);
    u->ctx = NULL;
  }
}

JNIEXPORT jlong JNICALL Java_com_fitbaus_arcade_UvcNative_open(JNIEnv *env, jclass cls, jint fd,
                                                              jobject sink) {
  Uvc *u;
  uvc_stream_ctrl_t ctrl;
  size_t nv21_need;
  jbyteArray local_nv21;
  jobject local_sink_ref;
  jclass sink_class;

  (void)cls;
  if (!env || fd < 0 || !sink) return 0;

  nv21_need = yuyv_nv21_size(UVC_PROBE_WIDTH, UVC_PROBE_HEIGHT);
  if (nv21_need == 0 || nv21_need > (size_t)0x7fffffff) return 0;

  u = calloc(1, sizeof(*u));
  if (!u) return 0;
  atomic_init(&u->alive, 0);
  atomic_init(&u->streaming, 0);
  u->width = UVC_PROBE_WIDTH;
  u->height = UVC_PROBE_HEIGHT;

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
  if (uvc_get_stream_ctrl_format_size(u->device, &ctrl, UVC_FRAME_FORMAT_YUYV, UVC_PROBE_WIDTH,
                                     UVC_PROBE_HEIGHT, UVC_PROBE_FPS) < 0) {
    goto bad;
  }

  local_nv21 = (*env)->NewByteArray(env, (jsize)nv21_need);
  if (!local_nv21) goto bad;
  u->nv21 = (*env)->NewGlobalRef(env, local_nv21);
  (*env)->DeleteLocalRef(env, local_nv21);
  if (!u->nv21) goto bad;
  u->nv21_len = (jsize)nv21_need;

  /* Publish Java objects before start so an early callback never sees null sinks. */
  atomic_store(&u->alive, 1);
  if (uvc_start_streaming(u->device, &ctrl, frame_cb, u, 0) < 0) {
    /* start_streaming failure must not leave transfers or a live callback path. */
    atomic_store(&u->alive, 0);
    atomic_store(&u->streaming, 0);
    goto bad;
  }
  atomic_store(&u->streaming, 1);
  LOGI("open ok fd=%d %dx%d", fd, u->width, u->height);
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

JNIEXPORT void JNICALL Java_com_fitbaus_arcade_UvcNative_close(JNIEnv *env, jclass cls, jlong handle) {
  Uvc *u = (Uvc *)(intptr_t)handle;
  (void)cls;
  if (!u) return;
  /* Joins any in-flight frame_cb before Java globals are released. */
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
