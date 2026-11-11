// SPDX-License-Identifier: AGPL-3.0-only
#ifndef FITBAUS_ARCADE_HAND_PIPELINE_H
#define FITBAUS_ARCADE_HAND_PIPELINE_H

#include <stddef.h>
#include <stdint.h>

#define HP_PALM_KEYPOINTS 7
#define HP_FACE_KEYPOINTS 6
#define HP_LANDMARKS 21

typedef struct HandPipeline HandPipeline;

typedef struct {
    float score;
    float cx, cy, w, h;
    float kp[HP_PALM_KEYPOINTS * 2];
} HpPalm;

typedef struct {
    float presence;
    float handedness;
    float xy[HP_LANDMARKS * 2];
} HpLandmarks;

typedef struct {
    double pre_ms;
    double infer_ms;
    double post_ms;
} HpTimes;

int hp_create(HandPipeline** out, const char* tflite_library, const void* palm_model, size_t palm_size,
              const void* landmark_model, size_t landmark_size, const void* face_model, size_t face_size, int threads,
              char* error, size_t error_size);

int hp_detect_faces(HandPipeline* p, const uint8_t* nv21, int width, int height, float min_score,
                    HpPalm* out, int max_out, HpTimes* times);

void hp_set_face_input_signed(HandPipeline* p, int is_signed);

int hp_detect_palms(HandPipeline* p, const uint8_t* nv21, int width, int height, float min_score,
                    HpPalm* out, int max_out, HpTimes* times);

int hp_landmarks(HandPipeline* p, const uint8_t* nv21, int width, int height, float cx, float cy,
                 float size, float rotation, HpLandmarks* out, HpTimes* times);

void hp_render_preview(const uint8_t* nv21, int width, int height, int cols, int rows, int mirror, uint32_t* out);

void hp_destroy(HandPipeline* p);

#endif
