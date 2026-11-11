// SPDX-License-Identifier: AGPL-3.0-only
#include "hand_pipeline.h"

#include <dlfcn.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define PALM_SIZE 192
#define LM_SIZE 224
#define FACE_SIZE 128
#define ANCHORS 2016
#define FACE_ANCHORS 896
#define BOX_VALUES 18
#define FACE_BOX_VALUES 16
#define MAX_BOX_VALUES 18
#define MAX_CANDIDATES 64

typedef struct TfLiteModel TfLiteModel;
typedef struct TfLiteInterpreterOptions TfLiteInterpreterOptions;
typedef struct TfLiteInterpreter TfLiteInterpreter;
typedef struct TfLiteTensor TfLiteTensor;
typedef struct TfLiteDelegate TfLiteDelegate;

typedef struct {
    int32_t num_threads;
    uint32_t flags;
    void* weights_cache;
    bool handle_variable_ops;
    bool experimental_adaptive_avx_optimization;
} XnnOptions;

typedef struct {
    TfLiteModel* (*model_create)(const void*, size_t);
    void (*model_delete)(TfLiteModel*);
    TfLiteInterpreterOptions* (*options_create)(void);
    void (*options_delete)(TfLiteInterpreterOptions*);
    void (*options_threads)(TfLiteInterpreterOptions*, int32_t);
    void (*options_add_delegate)(TfLiteInterpreterOptions*, TfLiteDelegate*);
    TfLiteInterpreter* (*interpreter_create)(const TfLiteModel*, const TfLiteInterpreterOptions*);
    void (*interpreter_delete)(TfLiteInterpreter*);
    int (*allocate)(TfLiteInterpreter*);
    int (*invoke)(TfLiteInterpreter*);
    TfLiteTensor* (*input)(const TfLiteInterpreter*, int32_t);
    const TfLiteTensor* (*output)(const TfLiteInterpreter*, int32_t);
    size_t (*byte_size)(const TfLiteTensor*);
    int (*copy_from)(TfLiteTensor*, const void*, size_t);
    int (*copy_to)(const TfLiteTensor*, void*, size_t);
    XnnOptions (*xnn_defaults)(void);
    TfLiteDelegate* (*xnn_create)(const XnnOptions*);
    void (*xnn_delete)(TfLiteDelegate*);
} TfLiteApi;

typedef struct {
    void* data;
    TfLiteModel* model;
    TfLiteDelegate* delegate;
    TfLiteInterpreter* interpreter;
} Net;

struct HandPipeline {
    void* library;
    TfLiteApi api;
    Net palm;
    Net landmark;
    Net face;
    int face_input_signed;
    float anchors[ANCHORS * 2];
    float face_anchors[FACE_ANCHORS * 2];
    float face_in[FACE_SIZE * FACE_SIZE * 3];
    float face_boxes[FACE_ANCHORS * FACE_BOX_VALUES];
    float face_scores[FACE_ANCHORS];
    float palm_in[PALM_SIZE * PALM_SIZE * 3];
    float lm_in[LM_SIZE * LM_SIZE * 3];
    float boxes[ANCHORS * BOX_VALUES];
    float scores[ANCHORS];
    float lm_out[HP_LANDMARKS * 3];
};

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

static void set_error(char* error, size_t size, const char* message, const char* detail) {
    if (error && size) snprintf(error, size, "%s%s%s", message, detail ? ": " : "", detail ? detail : "");
}

#define BIND(field, name, required)                                   \
    do {                                                              \
        *(void**)(&p->api.field) = dlsym(p->library, name);           \
        if ((required) && !p->api.field) {                            \
            set_error(error, error_size, "missing TFLite symbol", name); \
            return false;                                             \
        }                                                             \
    } while (0)

static bool bind_api(HandPipeline* p, char* error, size_t error_size) {
    BIND(model_create, "TfLiteModelCreate", true);
    BIND(model_delete, "TfLiteModelDelete", false);
    BIND(options_create, "TfLiteInterpreterOptionsCreate", true);
    BIND(options_delete, "TfLiteInterpreterOptionsDelete", false);
    BIND(options_threads, "TfLiteInterpreterOptionsSetNumThreads", true);
    BIND(options_add_delegate, "TfLiteInterpreterOptionsAddDelegate", true);
    BIND(interpreter_create, "TfLiteInterpreterCreate", true);
    BIND(interpreter_delete, "TfLiteInterpreterDelete", false);
    BIND(allocate, "TfLiteInterpreterAllocateTensors", true);
    BIND(invoke, "TfLiteInterpreterInvoke", true);
    BIND(input, "TfLiteInterpreterGetInputTensor", true);
    BIND(output, "TfLiteInterpreterGetOutputTensor", true);
    BIND(byte_size, "TfLiteTensorByteSize", true);
    BIND(copy_from, "TfLiteTensorCopyFromBuffer", true);
    BIND(copy_to, "TfLiteTensorCopyToBuffer", true);
    BIND(xnn_defaults, "TfLiteXNNPackDelegateOptionsDefault", true);
    BIND(xnn_create, "TfLiteXNNPackDelegateCreate", true);
    BIND(xnn_delete, "TfLiteXNNPackDelegateDelete", false);
    return true;
}

static bool open_net(HandPipeline* p, Net* net, const void* model, size_t size, int threads, size_t input_bytes,
                     char* error, size_t error_size) {
    net->data = malloc(size);
    if (!net->data) { set_error(error, error_size, "out of memory", NULL); return false; }
    memcpy(net->data, model, size);
    net->model = p->api.model_create(net->data, size);
    if (!net->model) { set_error(error, error_size, "model rejected", NULL); return false; }
    TfLiteInterpreterOptions* options = p->api.options_create();
    p->api.options_threads(options, threads);
    XnnOptions xo = p->api.xnn_defaults();
    xo.num_threads = threads;
    net->delegate = p->api.xnn_create(&xo);
    if (net->delegate) p->api.options_add_delegate(options, net->delegate);
    net->interpreter = p->api.interpreter_create(net->model, options);
    if (p->api.options_delete) p->api.options_delete(options);
    if (!net->interpreter || p->api.allocate(net->interpreter) != 0) {
        set_error(error, error_size, "interpreter creation failed", NULL);
        return false;
    }
    if (p->api.byte_size(p->api.input(net->interpreter, 0)) != input_bytes) {
        set_error(error, error_size, "unexpected model input size", NULL);
        return false;
    }
    return true;
}

static void close_net(HandPipeline* p, Net* net) {
    if (net->interpreter && p->api.interpreter_delete) p->api.interpreter_delete(net->interpreter);
    if (net->delegate && p->api.xnn_delete) p->api.xnn_delete(net->delegate);
    if (net->model && p->api.model_delete) p->api.model_delete(net->model);
    free(net->data);
    memset(net, 0, sizeof(*net));
}

static void make_anchors_for(float* anchors, int fine, int coarse) {
    int k = 0;
    for (int y = 0; y < fine; y++)
        for (int x = 0; x < fine; x++)
            for (int a = 0; a < 2; a++) { anchors[k++] = (x + 0.5f) / fine; anchors[k++] = (y + 0.5f) / fine; }
    for (int y = 0; y < coarse; y++)
        for (int x = 0; x < coarse; x++)
            for (int a = 0; a < 6; a++) { anchors[k++] = (x + 0.5f) / coarse; anchors[k++] = (y + 0.5f) / coarse; }
}

static void make_anchors(float* anchors) { make_anchors_for(anchors, 24, 12); }

int hp_create(HandPipeline** out, const char* tflite_library, const void* palm_model, size_t palm_size,
              const void* landmark_model, size_t landmark_size, const void* face_model, size_t face_size, int threads,
              char* error, size_t error_size) {
    *out = NULL;
    HandPipeline* p = calloc(1, sizeof(HandPipeline));
    if (!p) { set_error(error, error_size, "out of memory", NULL); return -1; }
    p->library = dlopen(tflite_library, RTLD_NOW);
    if (!p->library) {
        set_error(error, error_size, "cannot load TFLite runtime", dlerror());
        free(p);
        return -1;
    }
    if (threads < 1) threads = 1;
    if (!palm_model && !landmark_model && !face_model) {
        set_error(error, error_size, "no model supplied", NULL);
        dlclose(p->library);
        free(p);
        return -1;
    }
    if (!bind_api(p, error, error_size) ||
        (palm_model && !open_net(p, &p->palm, palm_model, palm_size, threads, sizeof(p->palm_in), error, error_size)) ||
        (landmark_model && !open_net(p, &p->landmark, landmark_model, landmark_size, threads, sizeof(p->lm_in), error, error_size)) ||
        (face_model && !open_net(p, &p->face, face_model, face_size, threads, sizeof(p->face_in), error, error_size))) {
        hp_destroy(p);
        return -1;
    }
    make_anchors(p->anchors);
    make_anchors_for(p->face_anchors, 16, 8);
    p->face_input_signed = 1;
    *out = p;
    return 0;
}

void hp_destroy(HandPipeline* p) {
    if (!p) return;
    close_net(p, &p->palm);
    close_net(p, &p->landmark);
    close_net(p, &p->face);
    if (p->library) dlclose(p->library);
    free(p);
}

static inline void sample_rgb(const uint8_t* nv21, int w, int h, float x, float y, float* r, float* g, float* b) {
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x > w - 1.001f) x = w - 1.001f;
    if (y > h - 1.001f) y = h - 1.001f;
    int x0 = (int)x, y0 = (int)y;
    float fx = x - x0, fy = y - y0;
    const uint8_t* p = nv21 + y0 * w + x0;
    float Y = (p[0] * (1 - fx) + p[1] * fx) * (1 - fy) + (p[w] * (1 - fx) + p[w + 1] * fx) * fy;
    const uint8_t* c = nv21 + w * h + (y0 >> 1) * w + (x0 & ~1);
    float V = c[0] - 128.0f, U = c[1] - 128.0f;
    *r = clampf(Y + 1.402f * V, 0, 255);
    *g = clampf(Y - 0.344f * U - 0.714f * V, 0, 255);
    *b = clampf(Y + 1.772f * U, 0, 255);
}

typedef struct {
    float scale;
    float pad_x;
    float pad_y;
} Letterbox;

static Letterbox letterbox_for(int w, int h, int size) {
    Letterbox lb;
    lb.scale = (float)(w > h ? w : h) / size;
    lb.pad_x = (size - w / lb.scale) / 2;
    lb.pad_y = (size - h / lb.scale) / 2;
    return lb;
}

static Letterbox letterbox(int w, int h) { return letterbox_for(w, h, PALM_SIZE); }

static void fill_letterboxed(const uint8_t* nv21, int w, int h, int size, float mul, float add, float* o) {
    Letterbox lb = letterbox_for(w, h, size);
    for (int v = 0; v < size; v++) {
        float sy = (v + 0.5f - lb.pad_y) * lb.scale - 0.5f;
        for (int u = 0; u < size; u++) {
            float sx = (u + 0.5f - lb.pad_x) * lb.scale - 0.5f;
            float r = 0, g = 0, b = 0;
            if (sx >= -0.5f && sy >= -0.5f && sx <= w - 0.5f && sy <= h - 0.5f) sample_rgb(nv21, w, h, sx, sy, &r, &g, &b);
            *o++ = r * mul + add;
            *o++ = g * mul + add;
            *o++ = b * mul + add;
        }
    }
}

static float sigmoid(float v);
static float iou(const float* a, const float* b);

static int decode_detections(const float* boxes, const float* scores, const float* anchors, int anchor_count, int values,
                             int keypoints, int size, Letterbox lb, float min_score, HpPalm* out, int max_out) {
    int idx[MAX_CANDIDATES];
    float sc[MAX_CANDIDATES];
    int n = 0;
    for (int i = 0; i < anchor_count; i++) {
        float s = sigmoid(scores[i]);
        if (s < min_score) continue;
        int pos;
        if (n < MAX_CANDIDATES) pos = n++;
        else if (s > sc[MAX_CANDIDATES - 1]) pos = MAX_CANDIDATES - 1;
        else continue;
        while (pos > 0 && sc[pos - 1] < s) { sc[pos] = sc[pos - 1]; idx[pos] = idx[pos - 1]; pos--; }
        sc[pos] = s;
        idx[pos] = i;
    }
    float decoded[MAX_CANDIDATES][MAX_BOX_VALUES];
    for (int k = 0; k < n; k++) {
        const float* raw = boxes + idx[k] * values;
        float ax = anchors[idx[k] * 2], ay = anchors[idx[k] * 2 + 1];
        decoded[k][0] = raw[0] / size + ax;
        decoded[k][1] = raw[1] / size + ay;
        decoded[k][2] = raw[2] / size;
        decoded[k][3] = raw[3] / size;
        for (int j = 0; j < keypoints; j++) {
            decoded[k][4 + j * 2] = raw[4 + j * 2] / size + ax;
            decoded[k][5 + j * 2] = raw[5 + j * 2] / size + ay;
        }
    }
    bool used[MAX_CANDIDATES] = {false};
    int count = 0;
    for (int k = 0; k < n && count < max_out; k++) {
        if (used[k]) continue;
        float acc[MAX_BOX_VALUES] = {0}, total = 0;
        for (int j = k; j < n; j++) {
            if (used[j] || iou(decoded[k], decoded[j]) < 0.3f) continue;
            used[j] = true;
            for (int v = 0; v < values; v++) acc[v] += decoded[j][v] * sc[j];
            total += sc[j];
        }
        HpPalm* d = &out[count++];
        memset(d, 0, sizeof(*d));
        d->score = sc[k];
        d->cx = (acc[0] / total * size - lb.pad_x) * lb.scale;
        d->cy = (acc[1] / total * size - lb.pad_y) * lb.scale;
        d->w = acc[2] / total * size * lb.scale;
        d->h = acc[3] / total * size * lb.scale;
        for (int j = 0; j < keypoints; j++) {
            d->kp[j * 2] = (acc[4 + j * 2] / total * size - lb.pad_x) * lb.scale;
            d->kp[j * 2 + 1] = (acc[5 + j * 2] / total * size - lb.pad_y) * lb.scale;
        }
    }
    return count;
}

static float sigmoid(float v) { return 1.0f / (1.0f + expf(-clampf(v, -100, 100))); }

static float iou(const float* a, const float* b) {
    float ax0 = a[0] - a[2] / 2, ay0 = a[1] - a[3] / 2, ax1 = a[0] + a[2] / 2, ay1 = a[1] + a[3] / 2;
    float bx0 = b[0] - b[2] / 2, by0 = b[1] - b[3] / 2, bx1 = b[0] + b[2] / 2, by1 = b[1] + b[3] / 2;
    float iw = fminf(ax1, bx1) - fmaxf(ax0, bx0), ih = fminf(ay1, by1) - fmaxf(ay0, by0);
    if (iw <= 0 || ih <= 0) return 0;
    float inter = iw * ih;
    return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

int hp_detect_palms(HandPipeline* p, const uint8_t* nv21, int w, int h, float min_score, HpPalm* out, int max_out,
                    HpTimes* times) {
    if (!p->palm.interpreter) return -1;
    double t0 = now_ms();
    Letterbox lb = letterbox(w, h);
    float* o = p->palm_in;
    for (int v = 0; v < PALM_SIZE; v++) {
        float sy = (v + 0.5f - lb.pad_y) * lb.scale - 0.5f;
        for (int u = 0; u < PALM_SIZE; u++) {
            float sx = (u + 0.5f - lb.pad_x) * lb.scale - 0.5f;
            float r = 0, g = 0, b = 0;
            if (sx >= -0.5f && sy >= -0.5f && sx <= w - 0.5f && sy <= h - 0.5f) sample_rgb(nv21, w, h, sx, sy, &r, &g, &b);
            *o++ = r / 255.0f;
            *o++ = g / 255.0f;
            *o++ = b / 255.0f;
        }
    }
    double t1 = now_ms();
    if (p->api.copy_from(p->api.input(p->palm.interpreter, 0), p->palm_in, sizeof(p->palm_in)) != 0 ||
        p->api.invoke(p->palm.interpreter) != 0 ||
        p->api.copy_to(p->api.output(p->palm.interpreter, 0), p->boxes, sizeof(p->boxes)) != 0 ||
        p->api.copy_to(p->api.output(p->palm.interpreter, 1), p->scores, sizeof(p->scores)) != 0) {
        return -1;
    }
    double t2 = now_ms();

    int idx[MAX_CANDIDATES];
    float sc[MAX_CANDIDATES];
    int n = 0;
    for (int i = 0; i < ANCHORS; i++) {
        float s = sigmoid(p->scores[i]);
        if (s < min_score) continue;
        int pos;
        if (n < MAX_CANDIDATES) pos = n++;
        else if (s > sc[MAX_CANDIDATES - 1]) pos = MAX_CANDIDATES - 1;
        else continue;
        while (pos > 0 && sc[pos - 1] < s) { sc[pos] = sc[pos - 1]; idx[pos] = idx[pos - 1]; pos--; }
        sc[pos] = s;
        idx[pos] = i;
    }
    float decoded[MAX_CANDIDATES][BOX_VALUES];
    for (int k = 0; k < n; k++) {
        const float* raw = p->boxes + idx[k] * BOX_VALUES;
        float ax = p->anchors[idx[k] * 2], ay = p->anchors[idx[k] * 2 + 1];
        decoded[k][0] = raw[0] / PALM_SIZE + ax;
        decoded[k][1] = raw[1] / PALM_SIZE + ay;
        decoded[k][2] = raw[2] / PALM_SIZE;
        decoded[k][3] = raw[3] / PALM_SIZE;
        for (int j = 0; j < HP_PALM_KEYPOINTS; j++) {
            decoded[k][4 + j * 2] = raw[4 + j * 2] / PALM_SIZE + ax;
            decoded[k][5 + j * 2] = raw[5 + j * 2] / PALM_SIZE + ay;
        }
    }
    bool used[MAX_CANDIDATES] = {false};
    int count = 0;
    for (int k = 0; k < n && count < max_out; k++) {
        if (used[k]) continue;
        float acc[BOX_VALUES] = {0}, total = 0;
        for (int j = k; j < n; j++) {
            if (used[j] || iou(decoded[k], decoded[j]) < 0.3f) continue;
            used[j] = true;
            for (int v = 0; v < BOX_VALUES; v++) acc[v] += decoded[j][v] * sc[j];
            total += sc[j];
        }
        HpPalm* d = &out[count++];
        d->score = sc[k];
        d->cx = (acc[0] / total * PALM_SIZE - lb.pad_x) * lb.scale;
        d->cy = (acc[1] / total * PALM_SIZE - lb.pad_y) * lb.scale;
        d->w = acc[2] / total * PALM_SIZE * lb.scale;
        d->h = acc[3] / total * PALM_SIZE * lb.scale;
        for (int j = 0; j < HP_PALM_KEYPOINTS; j++) {
            d->kp[j * 2] = (acc[4 + j * 2] / total * PALM_SIZE - lb.pad_x) * lb.scale;
            d->kp[j * 2 + 1] = (acc[5 + j * 2] / total * PALM_SIZE - lb.pad_y) * lb.scale;
        }
    }
    double t3 = now_ms();
    if (times) { times->pre_ms = t1 - t0; times->infer_ms = t2 - t1; times->post_ms = t3 - t2; }
    return count;
}

void hp_set_face_input_signed(HandPipeline* p, int is_signed) { p->face_input_signed = is_signed; }

int hp_detect_faces(HandPipeline* p, const uint8_t* nv21, int w, int h, float min_score, HpPalm* out, int max_out,
                    HpTimes* times) {
    if (!p->face.interpreter) return -1;
    double t0 = now_ms();
    if (p->face_input_signed) fill_letterboxed(nv21, w, h, FACE_SIZE, 1.0f / 127.5f, -1.0f, p->face_in);
    else fill_letterboxed(nv21, w, h, FACE_SIZE, 1.0f / 255.0f, 0.0f, p->face_in);
    double t1 = now_ms();
    if (p->api.copy_from(p->api.input(p->face.interpreter, 0), p->face_in, sizeof(p->face_in)) != 0 ||
        p->api.invoke(p->face.interpreter) != 0 ||
        p->api.copy_to(p->api.output(p->face.interpreter, 0), p->face_boxes, sizeof(p->face_boxes)) != 0 ||
        p->api.copy_to(p->api.output(p->face.interpreter, 1), p->face_scores, sizeof(p->face_scores)) != 0) {
        return -1;
    }
    double t2 = now_ms();
    int count = decode_detections(p->face_boxes, p->face_scores, p->face_anchors, FACE_ANCHORS, FACE_BOX_VALUES,
                                  HP_FACE_KEYPOINTS, FACE_SIZE, letterbox_for(w, h, FACE_SIZE), min_score, out, max_out);
    double t3 = now_ms();
    if (times) { times->pre_ms = t1 - t0; times->infer_ms = t2 - t1; times->post_ms = t3 - t2; }
    return count;
}

int hp_landmarks(HandPipeline* p, const uint8_t* nv21, int w, int h, float cx, float cy, float size, float rotation,
                 HpLandmarks* out, HpTimes* times) {
    if (!p->landmark.interpreter) return -1;
    double t0 = now_ms();
    float cs = cosf(rotation), sn = sinf(rotation);
    float* o = p->lm_in;
    for (int v = 0; v < LM_SIZE; v++) {
        float bb = ((v + 0.5f) / LM_SIZE - 0.5f) * size;
        for (int u = 0; u < LM_SIZE; u++) {
            float aa = ((u + 0.5f) / LM_SIZE - 0.5f) * size;
            float sx = cx + aa * cs - bb * sn, sy = cy + aa * sn + bb * cs;
            float r = 0, g = 0, b = 0;
            if (sx >= 0 && sy >= 0 && sx <= w - 1 && sy <= h - 1) sample_rgb(nv21, w, h, sx, sy, &r, &g, &b);
            *o++ = r / 255.0f;
            *o++ = g / 255.0f;
            *o++ = b / 255.0f;
        }
    }
    double t1 = now_ms();
    if (p->api.copy_from(p->api.input(p->landmark.interpreter, 0), p->lm_in, sizeof(p->lm_in)) != 0 ||
        p->api.invoke(p->landmark.interpreter) != 0 ||
        p->api.copy_to(p->api.output(p->landmark.interpreter, 0), p->lm_out, sizeof(p->lm_out)) != 0 ||
        p->api.copy_to(p->api.output(p->landmark.interpreter, 1), &out->presence, sizeof(float)) != 0 ||
        p->api.copy_to(p->api.output(p->landmark.interpreter, 2), &out->handedness, sizeof(float)) != 0) {
        return -1;
    }
    double t2 = now_ms();
    for (int i = 0; i < HP_LANDMARKS; i++) {
        float aa = (p->lm_out[i * 3] / LM_SIZE - 0.5f) * size, bb = (p->lm_out[i * 3 + 1] / LM_SIZE - 0.5f) * size;
        out->xy[i * 2] = cx + aa * cs - bb * sn;
        out->xy[i * 2 + 1] = cy + aa * sn + bb * cs;
    }
    double t3 = now_ms();
    if (times) { times->pre_ms = t1 - t0; times->infer_ms = t2 - t1; times->post_ms = t3 - t2; }
    return 0;
}

void hp_render_preview(const uint8_t* nv21, int w, int h, int cols, int rows, int mirror, uint32_t* out) {
    for (int gy = 0; gy < rows; gy++) {
        int py = (int)((gy + 0.5f) * h / rows);
        for (int gx = 0; gx < cols; gx++) {
            int sx = mirror ? cols - 1 - gx : gx;
            int px = (int)((sx + 0.5f) * w / cols);
            uint32_t l = nv21[py * w + px];
            out[gy * cols + gx] = 0xFF000000u | (l << 16) | (l << 8) | l;
        }
    }
}
