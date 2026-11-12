// SPDX-License-Identifier: AGPL-3.0-only
#include <jni.h>
#include <libusb.h>
#include <libuvc/libuvc.h>
#include <stdlib.h>

typedef struct {
  JavaVM *vm; jobject sink; jmethodID on_frame; jbyteArray nv21;
  uvc_context_t *ctx; uvc_device_handle_t *device;
} Uvc;

static void frame(uvc_frame_t *in, void *opaque) {
  Uvc *u = opaque;
  if (!in || in->frame_format != UVC_FRAME_FORMAT_YUYV || in->width < 2 || in->height < 2 || (in->width & 1) || (in->height & 1)) return;
  size_t pixels = (size_t)in->width * in->height;
  if (in->data_bytes < pixels * 2) return;
  JNIEnv *env = NULL;
  if ((*u->vm)->AttachCurrentThread(u->vm, &env, NULL) != JNI_OK) return;
  jbyte *out = (*env)->GetByteArrayElements(env, u->nv21, NULL);
  if (!out) return;
  const unsigned char *src = in->data; unsigned char *y = (unsigned char *)out; unsigned char *vu = y + pixels;
  for (int row = 0; row < in->height; row += 2) {
    const unsigned char *a = src + (size_t)row * in->width * 2;
    const unsigned char *b = a + (size_t)in->width * 2;
    for (int x = 0; x < in->width; x += 2) {
      y[(size_t)row * in->width + x] = a[x * 2]; y[(size_t)row * in->width + x + 1] = a[x * 2 + 2];
      y[(size_t)(row + 1) * in->width + x] = b[x * 2]; y[(size_t)(row + 1) * in->width + x + 1] = b[x * 2 + 2];
      *vu++ = a[x * 2 + 3]; *vu++ = a[x * 2 + 1];
    }
  }
  (*env)->ReleaseByteArrayElements(env, u->nv21, out, 0);
  (*env)->CallVoidMethod(env, u->sink, u->on_frame, u->nv21, (jint)in->width, (jint)in->height);
}

JNIEXPORT jlong JNICALL Java_com_fitbaus_arcade_UvcNative_open(JNIEnv *env, jclass cls, jint fd, jobject sink) {
  (void)cls; Uvc *u = calloc(1, sizeof(*u)); uvc_stream_ctrl_t ctrl;
  if (!u || (*env)->GetJavaVM(env, &u->vm) || !(u->sink = (*env)->NewGlobalRef(env, sink))) goto bad;
  jclass c = (*env)->GetObjectClass(env, sink); u->on_frame = (*env)->GetMethodID(env, c, "onFrame", "([BII)V");
  if (!u->on_frame || uvc_init(&u->ctx, NULL) < 0 || uvc_wrap(fd, u->ctx, &u->device) < 0 ||
      uvc_get_stream_ctrl_format_size(u->device, &ctrl, UVC_FRAME_FORMAT_YUYV, 320, 240, 30) < 0) goto bad;
  u->nv21 = (*env)->NewGlobalRef(env, (*env)->NewByteArray(env, 320 * 240 * 3 / 2));
  if (!u->nv21 || uvc_start_streaming(u->device, &ctrl, frame, u, 0) < 0) goto bad;
  return (jlong)(intptr_t)u;
bad: if (u) { if (u->device) uvc_close(u->device); if (u->ctx) uvc_exit(u->ctx); if (u->sink) (*env)->DeleteGlobalRef(env,u->sink); free(u); } return 0;
}
JNIEXPORT void JNICALL Java_com_fitbaus_arcade_UvcNative_close(JNIEnv *env, jclass cls, jlong handle) {
  (void)cls; Uvc *u = (Uvc *)(intptr_t)handle; if (!u) return; uvc_stop_streaming(u->device); uvc_close(u->device); uvc_exit(u->ctx); (*env)->DeleteGlobalRef(env,u->sink); (*env)->DeleteGlobalRef(env,u->nv21); free(u);
}
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *r) { (void)vm; (void)r; libusb_set_option(NULL, LIBUSB_OPTION_NO_DEVICE_DISCOVERY); return JNI_VERSION_1_6; }
