// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

internal object HandShapes {
    private val upright = floatArrayOf(
        0f, 0f, -0.3f, -0.15f, -0.45f, -0.35f, -0.55f, -0.55f, -0.6f, -0.75f,
        -0.2f, -0.6f, -0.22f, -0.85f, -0.23f, -1.0f, -0.24f, -1.15f,
        0f, -0.62f, 0f, -0.9f, 0f, -1.05f, 0f, -1.2f,
        0.18f, -0.58f, 0.2f, -0.82f, 0.21f, -0.97f, 0.22f, -1.1f,
        0.33f, -0.5f, 0.36f, -0.68f, 0.38f, -0.8f, 0.4f, -0.92f,
    )

    fun landmarks(presence: Float, handedness: Float, wristX: Float, wristY: Float, scale: Float = 100f): FloatArray {
        val out = FloatArray(HandModelLayout.LANDMARK_STRIDE)
        out[0] = presence
        out[1] = handedness
        for (i in 0 until HandModelLayout.LANDMARKS) {
            out[2 + i * 2] = wristX + upright[i * 2] * scale
            out[3 + i * 2] = wristY + upright[i * 2 + 1] * scale
        }
        return out
    }

    fun face(score: Float, noseX: Float, noseY: Float, size: Float = 90f): FloatArray {
        val row = FloatArray(HandModelLayout.FACE_STRIDE)
        row[0] = score
        row[1] = noseX
        row[2] = noseY - 0.05f * size
        row[3] = size
        row[4] = size
        row[5] = noseX - 0.2f * size
        row[6] = noseY - 0.25f * size
        row[7] = noseX + 0.2f * size
        row[8] = noseY - 0.25f * size
        row[9] = noseX
        row[10] = noseY
        return row
    }

    fun palm(score: Float, wristX: Float, wristY: Float, scale: Float = 100f): FloatArray {
        val row = FloatArray(HandModelLayout.PALM_STRIDE)
        row[0] = score
        row[1] = wristX
        row[2] = wristY - 0.45f * scale
        row[3] = 0.9f * scale
        row[4] = 0.9f * scale
        row[5] = wristX
        row[6] = wristY
        row[9] = wristX
        row[10] = wristY - 0.62f * scale
        return row
    }
}

internal class FakeHandModels : HandModelBackend {
    var palms: List<FloatArray> = emptyList()
    var responder: (HandRoi) -> FloatArray? = { null }
    var palmStatus: Int? = null
    var palmInferenceMs = 160f
    var faces: List<FloatArray> = emptyList()
    var faceStatus: Int? = null
    var faceCalls = 0
    val landmarkRois = ArrayList<HandRoi>()
    var palmCalls = 0
    var previewCalls = 0
    var closed = false
    var lastFrameMarker: Byte = 0

    override fun detectPalms(frame: ByteArray, width: Int, height: Int, minScore: Float, out: FloatArray, maxOut: Int, times: FloatArray): Int {
        palmCalls += 1
        lastFrameMarker = frame[0]
        times[1] = palmInferenceMs
        palmStatus?.let { return it }
        val usable = palms.filter { it[0] >= minScore }.take(maxOut)
        usable.forEachIndexed { i, row -> System.arraycopy(row, 0, out, i * HandModelLayout.PALM_STRIDE, row.size) }
        return usable.size
    }

    override fun landmarks(frame: ByteArray, width: Int, height: Int, roi: HandRoi, out: FloatArray, times: FloatArray): Int {
        landmarkRois += roi
        lastFrameMarker = frame[0]
        times[1] = 90f
        val result = responder(roi) ?: return -3
        System.arraycopy(result, 0, out, 0, result.size)
        return 0
    }

    override fun detectFaces(frame: ByteArray, width: Int, height: Int, minScore: Float, out: FloatArray, maxOut: Int, times: FloatArray): Int {
        faceCalls += 1
        times[1] = 55f
        faceStatus?.let { return it }
        val usable = faces.filter { it[0] >= minScore }.take(maxOut)
        usable.forEachIndexed { i, row -> System.arraycopy(row, 0, out, i * HandModelLayout.FACE_STRIDE, row.size) }
        return usable.size
    }

    override fun renderPreview(frame: ByteArray, width: Int, height: Int, cols: Int, rows: Int, mirror: Boolean, out: IntArray) {
        previewCalls += 1
        out.fill(-0x1000000 or frame[0].toInt().and(0xFF))
    }

    override fun close() {
        closed = true
    }
}

internal class FakeClock(var nanos: Long = 1_000_000_000L) {
    fun advanceMs(ms: Long) {
        nanos += ms * 1_000_000L
    }
}
