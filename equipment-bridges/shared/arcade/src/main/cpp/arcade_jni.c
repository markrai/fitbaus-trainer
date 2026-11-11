// SPDX-License-Identifier: AGPL-3.0-only
#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "hand_pipeline.h"

#define PALM_STRIDE (5 + HP_PALM_KEYPOINTS * 2)
#define FACE_STRIDE (5 + HP_FACE_KEYPOINTS * 2)
#define LANDMARK_STRIDE (2 + HP_LANDMARKS * 2)
#define STATUS_BAD_ARGUMENT (-1)
#define STATUS_BAD_FRAME (-2)
#define STATUS_INFERENCE_FAILED (-3)

typedef struct {
    HandPipeline* pipeline;
    uint8_t* frame;
    size_t frame_size;
} Engine;

static char last_error[256];

static uint8_t* load_frame(JNIEnv* env, Engine* e, jbyteArray frame, jint width, jint height) {
    size_t need = (size_t)width * height * 3 / 2;
    if (width <= 1 || height <= 1 || (*env)->GetArrayLength(env, frame) < (jsize)need) return NULL;
    if (e->frame_size != need) {
        free(e->frame);
        e->frame = malloc(need);
        e->frame_size = e->frame ? need : 0;
        if (!e->frame) return NULL;
    }
    (*env)->GetByteArrayRegion(env, frame, 0, (jsize)need, (jbyte*)e->frame);
    return e->frame;
}

static void put_times(JNIEnv* env, jfloatArray times, const HpTimes* t) {
    if (!times || (*env)->GetArrayLength(env, times) < 3) return;
    jfloat v[3] = {(jfloat)t->pre_ms, (jfloat)t->infer_ms, (jfloat)t->post_ms};
    (*env)->SetFloatArrayRegion(env, times, 0, 3, v);
}

static jbyte* bytes_of(JNIEnv* env, jbyteArray array, jsize* size) {
    *size = array ? (*env)->GetArrayLength(env, array) : 0;
    return array ? (*env)->GetByteArrayElements(env, array, NULL) : NULL;
}

static void release_bytes(JNIEnv* env, jbyteArray array, jbyte* bytes) {
    if (array && bytes) (*env)->ReleaseByteArrayElements(env, array, bytes, JNI_ABORT);
}

JNIEXPORT jlong JNICALL Java_com_fitbaus_arcade_NativeHandBridge_nativeCreate(
    JNIEnv* env, jclass cls, jstring library, jbyteArray palm, jbyteArray landmark, jbyteArray face, jint threads) {
    (void)cls;
    last_error[0] = 0;
    const char* path = (*env)->GetStringUTFChars(env, library, NULL);
    jsize palm_size, lm_size, face_size;
    jbyte* palm_bytes = bytes_of(env, palm, &palm_size);
    jbyte* lm_bytes = bytes_of(env, landmark, &lm_size);
    jbyte* face_bytes = bytes_of(env, face, &face_size);
    Engine* e = calloc(1, sizeof(Engine));
    int rc = e ? hp_create(&e->pipeline, path, palm_bytes, (size_t)palm_size, lm_bytes, (size_t)lm_size, face_bytes,
                           (size_t)face_size, threads, last_error, sizeof(last_error))
               : -1;
    release_bytes(env, palm, palm_bytes);
    release_bytes(env, landmark, lm_bytes);
    release_bytes(env, face, face_bytes);
    (*env)->ReleaseStringUTFChars(env, library, path);
    if (rc != 0) {
        if (!e) strncpy(last_error, "out of memory", sizeof(last_error) - 1);
        free(e);
        return 0;
    }
    return (jlong)(intptr_t)e;
}

JNIEXPORT jstring JNICALL Java_com_fitbaus_arcade_NativeHandBridge_nativeLastError(JNIEnv* env, jclass cls) {
    (void)cls;
    return (*env)->NewStringUTF(env, last_error);
}

JNIEXPORT jint JNICALL Java_com_fitbaus_arcade_NativeHandBridge_nativeDetectPalms(
    JNIEnv* env, jclass cls, jlong handle, jbyteArray frame, jint width, jint height, jfloat min_score,
    jfloatArray out, jint max_out, jfloatArray times) {
    (void)cls;
    Engine* e = (Engine*)(intptr_t)handle;
    if (!e || max_out <= 0 || (*env)->GetArrayLength(env, out) < max_out * PALM_STRIDE) return STATUS_BAD_ARGUMENT;
    uint8_t* pixels = load_frame(env, e, frame, width, height);
    if (!pixels) return STATUS_BAD_FRAME;
    HpPalm palms[16];
    if (max_out > 16) max_out = 16;
    HpTimes t = {0};
    int n = hp_detect_palms(e->pipeline, pixels, width, height, min_score, palms, max_out, &t);
    if (n < 0) return STATUS_INFERENCE_FAILED;
    jfloat buf[16 * PALM_STRIDE];
    for (int i = 0; i < n; i++) {
        jfloat* b = buf + i * PALM_STRIDE;
        b[0] = palms[i].score;
        b[1] = palms[i].cx;
        b[2] = palms[i].cy;
        b[3] = palms[i].w;
        b[4] = palms[i].h;
        memcpy(b + 5, palms[i].kp, sizeof(palms[i].kp));
    }
    if (n > 0) (*env)->SetFloatArrayRegion(env, out, 0, n * PALM_STRIDE, buf);
    put_times(env, times, &t);
    return n;
}

JNIEXPORT jint JNICALL Java_com_fitbaus_arcade_NativeHandBridge_nativeDetectFaces(
    JNIEnv* env, jclass cls, jlong handle, jbyteArray frame, jint width, jint height, jfloat min_score,
    jfloatArray out, jint max_out, jfloatArray times) {
    (void)cls;
    Engine* e = (Engine*)(intptr_t)handle;
    if (!e || max_out <= 0 || (*env)->GetArrayLength(env, out) < max_out * FACE_STRIDE) return STATUS_BAD_ARGUMENT;
    uint8_t* pixels = load_frame(env, e, frame, width, height);
    if (!pixels) return STATUS_BAD_FRAME;
    HpPalm faces[8];
    if (max_out > 8) max_out = 8;
    HpTimes t = {0};
    int n = hp_detect_faces(e->pipeline, pixels, width, height, min_score, faces, max_out, &t);
    if (n < 0) return STATUS_INFERENCE_FAILED;
    jfloat buf[8 * FACE_STRIDE];
    for (int i = 0; i < n; i++) {
        jfloat* b = buf + i * FACE_STRIDE;
        b[0] = faces[i].score;
        b[1] = faces[i].cx;
        b[2] = faces[i].cy;
        b[3] = faces[i].w;
        b[4] = faces[i].h;
        memcpy(b + 5, faces[i].kp, sizeof(float) * HP_FACE_KEYPOINTS * 2);
    }
    if (n > 0) (*env)->SetFloatArrayRegion(env, out, 0, n * FACE_STRIDE, buf);
    put_times(env, times, &t);
    return n;
}

JNIEXPORT jint JNICALL Java_com_fitbaus_arcade_NativeHandBridge_nativeLandmarks(
    JNIEnv* env, jclass cls, jlong handle, jbyteArray frame, jint width, jint height, jfloat cx, jfloat cy,
    jfloat size, jfloat rotation, jfloatArray out, jfloatArray times) {
    (void)cls;
    Engine* e = (Engine*)(intptr_t)handle;
    if (!e || (*env)->GetArrayLength(env, out) < LANDMARK_STRIDE) return STATUS_BAD_ARGUMENT;
    uint8_t* pixels = load_frame(env, e, frame, width, height);
    if (!pixels) return STATUS_BAD_FRAME;
    HpLandmarks lm;
    HpTimes t = {0};
    if (hp_landmarks(e->pipeline, pixels, width, height, cx, cy, size, rotation, &lm, &t) != 0) return STATUS_INFERENCE_FAILED;
    jfloat buf[LANDMARK_STRIDE];
    buf[0] = lm.presence;
    buf[1] = lm.handedness;
    memcpy(buf + 2, lm.xy, sizeof(lm.xy));
    (*env)->SetFloatArrayRegion(env, out, 0, LANDMARK_STRIDE, buf);
    put_times(env, times, &t);
    return 0;
}

JNIEXPORT void JNICALL Java_com_fitbaus_arcade_NativeHandBridge_nativeRenderPreview(
    JNIEnv* env, jclass cls, jlong handle, jbyteArray frame, jint width, jint height, jint cols, jint rows,
    jboolean mirror, jintArray out) {
    (void)cls;
    Engine* e = (Engine*)(intptr_t)handle;
    if (!e || cols <= 0 || rows <= 0 || (*env)->GetArrayLength(env, out) < cols * rows) return;
    uint8_t* pixels = load_frame(env, e, frame, width, height);
    if (!pixels) return;
    jint* dest = (*env)->GetIntArrayElements(env, out, NULL);
    hp_render_preview(pixels, width, height, cols, rows, mirror ? 1 : 0, (uint32_t*)dest);
    (*env)->ReleaseIntArrayElements(env, out, dest, 0);
}

JNIEXPORT void JNICALL Java_com_fitbaus_arcade_NativeHandBridge_nativeDestroy(JNIEnv* env, jclass cls, jlong handle) {
    (void)env;
    (void)cls;
    Engine* e = (Engine*)(intptr_t)handle;
    if (!e) return;
    hp_destroy(e->pipeline);
    free(e->frame);
    free(e);
}
