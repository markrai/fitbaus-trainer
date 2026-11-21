// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.GLUtils
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.egl.EGL10
import javax.microedition.khronos.egl.EGLContext
import javax.microedition.khronos.egl.EGLDisplay
import javax.microedition.khronos.opengles.GL10
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/** Reports EGL context creation failure before GLSurfaceView's render loop gives up. */
internal class GhoulEglContextFactory(private val failed: (String) -> Unit) : GLSurfaceView.EGLContextFactory {
    private val attributes = intArrayOf(EGL_CONTEXT_CLIENT_VERSION, 2, EGL10.EGL_NONE)

    override fun createContext(egl: EGL10, display: EGLDisplay, eglConfig: EGLConfig): EGLContext {
        val context = egl.eglCreateContext(display, eglConfig, EGL10.EGL_NO_CONTEXT, attributes)
        if (context == null || context === EGL10.EGL_NO_CONTEXT) {
            failed("GLES2 context creation failed: EGL 0x${egl.eglGetError().toString(16)}")
            return EGL10.EGL_NO_CONTEXT
        }
        return context
    }

    override fun destroyContext(egl: EGL10, display: EGLDisplay, context: EGLContext) {
        egl.eglDestroyContext(display, context)
    }

    private companion object {
        const val EGL_CONTEXT_CLIENT_VERSION = 0x3098
    }
}

/** GLES 2 renderer. Static maze geometry is built and uploaded here, never on the UI thread. */
internal class GhoulRunGlRenderer(
    private val assets: AssetManager,
    private val snapshots: GhoulGlSnapshotBuffer,
    private val failed: (String) -> Unit,
) : GLSurfaceView.Renderer {
    @Volatile var frameNanos: Long = 0L
        private set
    @Volatile var frameIntervalNanos: Long = 0L
        private set
    @Volatile var surfaceWidth: Int = 1
        private set
    @Volatile var surfaceHeight: Int = 1
        private set
    @Volatile var framesDrawn: Long = 0L
        private set
    @Volatile var lastGlError: Int = GLES20.GL_NO_ERROR
        private set

    private var mazeProgram = 0
    private var spriteProgram = 0
    private var ghoulProgram = 0
    private var mazeVbo = 0
    private var spriteVbo = 0
    private var mazeSeed = Long.MIN_VALUE
    private var floorCount = 0
    private var ceilingCount = 0
    private var wallCount = 0
    private val mazeTextures = IntArray(3)
    private val spriteTextures = IntArray(GhoulSpriteKind.entries.size)
    private val ghoulTextures = IntArray(2)
    private var ghoulAnchor = GhoulAnchor(1024, 512, GhoulConceptArt.CHEST, GhoulUv(0.5094f, GhoulConceptArt.FEET_V))
    private val projection = FloatArray(16)
    private val view = FloatArray(16)
    private val viewProjection = FloatArray(16)
    private var ready = false
    private var lastFrameStarted = 0L
    private val frame = GhoulGlSnapshot()
    private val spriteOrder = IntArray(GhoulGlSnapshot.MAX_SPRITES)
    private val spriteDistance = FloatArray(GhoulGlSnapshot.MAX_SPRITES)
    private lateinit var mazeLocations: MazeLocations
    private lateinit var spriteLocations: SpriteLocations
    private lateinit var ghoulLocations: GhoulLocations

    override fun onSurfaceCreated(unused: GL10?, config: EGLConfig?) {
        try {
            releaseHandles()
            GLES20.glClearColor(0f, 0f, 0f, 1f)
            Log.i(
                TAG,
                "GL vendor=${GLES20.glGetString(GLES20.GL_VENDOR)} renderer=${GLES20.glGetString(GLES20.GL_RENDERER)} " +
                    "version=${GLES20.glGetString(GLES20.GL_VERSION)}",
            )
            GLES20.glEnable(GLES20.GL_DEPTH_TEST)
            GLES20.glDepthFunc(GLES20.GL_LEQUAL)
            mazeProgram = link(MAZE_VERTEX, MAZE_FRAGMENT)
            spriteProgram = link(SPRITE_VERTEX, SPRITE_FRAGMENT)
            ghoulProgram = link(SPRITE_VERTEX, GHOUL_FRAGMENT)
            mazeLocations = MazeLocations(mazeProgram)
            spriteLocations = SpriteLocations(spriteProgram)
            ghoulLocations = GhoulLocations(ghoulProgram)
            createMazeTextures()
            createSpriteTextures()
            createGhoulTextures()
            createSpriteVbo()
            mazeSeed = Long.MIN_VALUE
            ready = true
        } catch (error: RuntimeException) {
            ready = false
            failed("GLES2 setup failed: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    override fun onSurfaceChanged(unused: GL10?, newWidth: Int, newHeight: Int) {
        surfaceWidth = max(1, newWidth)
        surfaceHeight = max(1, newHeight)
        GLES20.glViewport(0, 0, surfaceWidth, surfaceHeight)
    }

    override fun onDrawFrame(unused: GL10?) {
        val started = System.nanoTime()
        if (lastFrameStarted != 0L) frameIntervalNanos = started - lastFrameStarted
        lastFrameStarted = started
        if (!ready) return
        try {
            snapshots.readInto(frame)
            if (frame.diagnostics) GLES20.glClearColor(0.25f, 0f, 0.25f, 1f) else GLES20.glClearColor(0f, 0f, 0f, 1f)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            framesDrawn += 1L
            val maze = frame.maze
            if (maze == null) return
            if (maze.seed != mazeSeed) uploadMaze(maze)
            val dirX = cos(frame.yaw)
            val dirY = sin(frame.yaw)
            GhoulGlMatrices.buildViewProjection(
                viewProjection, projection, view,
                frame.cameraX, frame.cameraY, frame.eye, frame.yaw,
                FOV_RADIANS, surfaceWidth.toFloat() / surfaceHeight, NEAR, FAR,
            )
            drawMaze(frame, dirX, dirY)
            drawSprites(frame)
            val error = GLES20.glGetError()
            lastGlError = error
            if (error != GLES20.GL_NO_ERROR) throw IllegalStateException("GL error 0x${error.toString(16)}")
        } catch (error: RuntimeException) {
            ready = false
            failed("GLES2 frame failed: ${error.message ?: error.javaClass.simpleName}")
        } finally {
            frameNanos = System.nanoTime() - started
        }
    }

    private fun uploadMaze(maze: GhoulGlMaze) {
        val mesh = GhoulMazeMesher.build(maze)
        if (mazeVbo == 0) mazeVbo = generateBuffer()
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, mazeVbo)
        val bytes = floatBuffer(mesh.vertices)
        GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, mesh.vertices.size * 4, bytes, GLES20.GL_STATIC_DRAW)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
        floorCount = mesh.floorVertices
        ceilingCount = mesh.ceilingVertices
        wallCount = mesh.wallVertices
        mazeSeed = maze.seed
    }

    private fun drawMaze(frame: GhoulGlSnapshot, dirX: Float, dirY: Float) {
        GLES20.glUseProgram(mazeProgram)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, mazeVbo)
        val stride = GhoulMazeMesh.FLOATS_PER_VERTEX * 4
        attribute(mazeLocations.position, 3, stride, 0)
        attribute(mazeLocations.normal, 3, stride, 12)
        attribute(mazeLocations.uv, 2, stride, 24)
        uniformMatrix(mazeLocations.viewProjection, viewProjection)
        GLES20.glUniform3f(mazeLocations.camera, frame.cameraX, frame.cameraY, frame.eye)
        GLES20.glUniform2f(mazeLocations.direction, dirX, dirY)
        GLES20.glUniform1f(mazeLocations.lampRadius, frame.lampRadius)
        GLES20.glUniform1f(mazeLocations.lampPhase, frame.lampPhase)
        GLES20.glUniform1i(mazeLocations.lightCount, frame.lightCount)
        GLES20.glUniform3fv(mazeLocations.lightXyr, GhoulGlSnapshot.MAX_LIGHTS, frame.lightXyr, 0)
        GLES20.glUniform3fv(mazeLocations.lightRgb, GhoulGlSnapshot.MAX_LIGHTS, frame.lightRgb, 0)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glUniform1i(mazeLocations.texture, 0)
        var first = 0
        bindTexture(mazeTextures[0]); GLES20.glDrawArrays(GLES20.GL_TRIANGLES, first, floorCount); first += floorCount
        bindTexture(mazeTextures[1]); GLES20.glDrawArrays(GLES20.GL_TRIANGLES, first, ceilingCount); first += ceilingCount
        bindTexture(mazeTextures[2]); GLES20.glDrawArrays(GLES20.GL_TRIANGLES, first, wallCount)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
    }

    private fun drawSprites(frame: GhoulGlSnapshot) {
        if (frame.spriteCount == 0) return
        sortSpritesBackToFront(frame)
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA)
        GLES20.glDepthMask(false)
        var activeProgram = 0
        var orderIndex = 0
        while (orderIndex < frame.spriteCount) {
            val index = spriteOrder[orderIndex]
            val base = index * 3
            val kind = GhoulSpriteKind.entries[frame.spriteXyk[base + 2].toInt()]
            if (kind == GhoulSpriteKind.Ghoul || kind == GhoulSpriteKind.GhoulStunned) {
                if (activeProgram != ghoulProgram) {
                    prepareGhoulProgram(frame)
                    activeProgram = ghoulProgram
                }
                GLES20.glUniform3f(
                    ghoulLocations.centre,
                    frame.spriteXyk[base], frame.spriteXyk[base + 1], GhoulConceptArt.BILLBOARD_BASE + frame.ghoulBob,
                )
                GLES20.glUniform1f(ghoulLocations.desaturation, frame.ghoulDesaturation)
            } else {
                if (activeProgram != spriteProgram) {
                    preparePropProgram(frame)
                    activeProgram = spriteProgram
                }
                GLES20.glUniform3f(
                    spriteLocations.centre,
                    frame.spriteXyk[base], frame.spriteXyk[base + 1], GhoulFirstPersonRenderer.spriteBase(kind),
                )
                GLES20.glUniform2f(
                    spriteLocations.size,
                    GhoulFirstPersonRenderer.spriteWidth(kind), GhoulFirstPersonRenderer.spriteHeight(kind),
                )
                GLES20.glUniform1f(
                    spriteLocations.glow,
                    GhoulFirstPersonRenderer.spriteGlow(kind, frame.glowPhase / GhoulShaderPhases.GLOW_RADIANS_PER_SECOND),
                )
                GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
                bindTexture(spriteTextures[kind.ordinal])
            }
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            orderIndex += 1
        }
        GLES20.glDepthMask(true)
        GLES20.glDisable(GLES20.GL_BLEND)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
    }

    private fun sortSpritesBackToFront(frame: GhoulGlSnapshot) {
        var index = 0
        while (index < frame.spriteCount) {
            val base = index * 3
            val dx = frame.spriteXyk[base] - frame.cameraX
            val dy = frame.spriteXyk[base + 1] - frame.cameraY
            val distance = dx * dx + dy * dy
            spriteDistance[index] = distance
            var slot = index
            while (slot > 0 && spriteDistance[spriteOrder[slot - 1]] < distance) {
                spriteOrder[slot] = spriteOrder[slot - 1]
                slot -= 1
            }
            spriteOrder[slot] = index
            index += 1
        }
    }

    private fun preparePropProgram(frame: GhoulGlSnapshot) {
        GLES20.glUseProgram(spriteProgram)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, spriteVbo)
        attribute(spriteLocations.quad, 4, 16, 0)
        uniformMatrix(spriteLocations.viewProjection, viewProjection)
        GLES20.glUniform1f(spriteLocations.yaw, frame.yaw)
        GLES20.glUniform1f(spriteLocations.lampRadius, frame.lampRadius)
        GLES20.glUniform1f(spriteLocations.glowPhase, frame.glowPhase)
        GLES20.glUniform3f(spriteLocations.camera, frame.cameraX, frame.cameraY, frame.eye)
        GLES20.glUniform1i(spriteLocations.texture, 0)
    }

    private fun prepareGhoulProgram(frame: GhoulGlSnapshot) {
        GLES20.glUseProgram(ghoulProgram)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, spriteVbo)
        attribute(ghoulLocations.quad, 4, 16, 0)
        uniformMatrix(ghoulLocations.viewProjection, viewProjection)
        GLES20.glUniform1f(ghoulLocations.yaw, frame.yaw)
        GLES20.glUniform2f(ghoulLocations.size, GhoulConceptArt.BILLBOARD_WIDTH, GhoulConceptArt.BILLBOARD_HEIGHT)
        GLES20.glUniform3f(ghoulLocations.camera, frame.cameraX, frame.cameraY, frame.eye)
        GLES20.glUniform1f(ghoulLocations.lampRadius, frame.lampRadius)
        GLES20.glUniform2f(ghoulLocations.chest, ghoulAnchor.chest.u, ghoulAnchor.chest.v)
        GLES20.glUniform1f(ghoulLocations.feetV, ghoulAnchor.feet.v)
        GLES20.glUniform1f(ghoulLocations.phaseA, frame.ghoulPhaseA)
        GLES20.glUniform1f(ghoulLocations.phaseB, frame.ghoulPhaseB)
        GLES20.glUniform1f(ghoulLocations.flare, frame.ghoulFlare)
        GLES20.glUniform1f(ghoulLocations.sway, frame.ghoulSway)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        bindTexture(ghoulTextures[0])
        GLES20.glUniform1i(ghoulLocations.body, 0)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE1)
        bindTexture(ghoulTextures[1])
        GLES20.glUniform1i(ghoulLocations.halo, 1)
    }

    private fun createMazeTextures() {
        GLES20.glGenTextures(mazeTextures.size, mazeTextures, 0)
        uploadProcedural(mazeTextures[0], TextureKind.Floor)
        uploadProcedural(mazeTextures[1], TextureKind.Ceiling)
        uploadProcedural(mazeTextures[2], TextureKind.Brick)
    }

    private fun createSpriteTextures() {
        for (kind in GhoulSpriteKind.entries) {
            if (kind == GhoulSpriteKind.Ghoul || kind == GhoulSpriteKind.GhoulStunned) continue
            val h = GhoulSpriteArt.textureHeight(kind)
            val w = max(8, (h * GhoulFirstPersonRenderer.spriteWidth(kind) / GhoulFirstPersonRenderer.spriteHeight(kind)).toInt())
            spriteTextures[kind.ordinal] = generateTexture()
            uploadArgb(spriteTextures[kind.ordinal], w, h, GhoulSpriteArt.texture(kind, w, h), mipmaps = false, repeat = false)
        }
    }

    private fun createGhoulTextures() {
        ghoulAnchor = assets.open(GHOUL_ANCHOR_ASSET).bufferedReader().use { GhoulAnchorParser.parse(it.readText()) }
        GLES20.glGenTextures(ghoulTextures.size, ghoulTextures, 0)
        uploadBitmapAsset(ghoulTextures[0], GHOUL_BODY_ASSET)
        uploadBitmapAsset(ghoulTextures[1], GHOUL_HALO_ASSET)
    }

    private fun uploadBitmapAsset(texture: Int, path: String) {
        val options = BitmapFactory.Options().apply {
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inScaled = false
        }
        val decoded = assets.open(path).use { BitmapFactory.decodeStream(it, null, options) }
            ?: throw IllegalStateException("cannot decode $path")
        val bitmap = if (decoded.config == Bitmap.Config.ARGB_8888) decoded else {
            decoded.copy(Bitmap.Config.ARGB_8888, false).also { decoded.recycle() }
        }
        try {
            require(bitmap.width == ghoulAnchor.canvasWidth && bitmap.height == ghoulAnchor.canvasHeight) {
                "$path is ${bitmap.width}x${bitmap.height}, expected ${ghoulAnchor.canvasWidth}x${ghoulAnchor.canvasHeight}"
            }
            bindTexture(texture)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR_MIPMAP_LINEAR)
            GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
            GLES20.glGenerateMipmap(GLES20.GL_TEXTURE_2D)
        } finally {
            bitmap.recycle()
        }
    }

    private fun createSpriteVbo() {
        // x across billboard, y up billboard, then UV (artwork has v=0 at its top).
        val quad = floatArrayOf(-0.5f, 0f, 0f, 1f, 0.5f, 0f, 1f, 1f, -0.5f, 1f, 0f, 0f, 0.5f, 1f, 1f, 0f)
        spriteVbo = generateBuffer()
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, spriteVbo)
        GLES20.glBufferData(GLES20.GL_ARRAY_BUFFER, quad.size * 4, floatBuffer(quad), GLES20.GL_STATIC_DRAW)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
    }

    private fun uploadProcedural(texture: Int, kind: TextureKind) {
        val size = TEXTURE_SIZE
        val pixels = IntArray(size * size)
        var y = 0
        while (y < size) {
            var x = 0
            while (x < size) {
                val noise = ((x * 17 + y * 31 + x * y * 3) and 15) - 7
                val color = when (kind) {
                    TextureKind.Floor -> {
                        val joint = x % 16 <= 1 || y % 16 <= 1
                        if (joint) rgb(35, 32, 30) else rgb(76 + noise, 68 + noise, 58 + noise)
                    }
                    TextureKind.Ceiling -> {
                        val panel = x % 32 <= 1 || y % 32 <= 1
                        if (panel) rgb(16, 18, 22) else rgb(34 + noise / 2, 36 + noise / 2, 42 + noise / 2)
                    }
                    TextureKind.Brick -> {
                        val row = y / 12
                        val joint = y % 12 <= 1 || (x + if (row % 2 == 0) 0 else 16) % 32 <= 1
                        if (joint) rgb(56, 54, 52) else rgb(148 + noise, 140 + noise, 132 + noise)
                    }
                }
                pixels[y * size + x] = color
                x += 1
            }
            y += 1
        }
        uploadArgb(texture, size, size, pixels, mipmaps = true, repeat = true)
    }

    private fun uploadArgb(texture: Int, width: Int, height: Int, pixels: IntArray, mipmaps: Boolean, repeat: Boolean) {
        val bytes = ByteBuffer.allocateDirect(width * height * 4).order(ByteOrder.nativeOrder())
        var index = 0
        while (index < pixels.size) {
            val color = pixels[index]
            bytes.put((color shr 16 and 0xFF).toByte())
            bytes.put((color shr 8 and 0xFF).toByte())
            bytes.put((color and 0xFF).toByte())
            bytes.put((color ushr 24).toByte())
            index += 1
        }
        bytes.position(0)
        bindTexture(texture)
        val wrap = if (repeat) GLES20.GL_REPEAT else GLES20.GL_CLAMP_TO_EDGE
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, wrap)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, wrap)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(
            GLES20.GL_TEXTURE_2D,
            GLES20.GL_TEXTURE_MIN_FILTER,
            if (mipmaps) GLES20.GL_LINEAR_MIPMAP_LINEAR else GLES20.GL_LINEAR,
        )
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, width, height, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, bytes)
        if (mipmaps) GLES20.glGenerateMipmap(GLES20.GL_TEXTURE_2D)
    }

    private fun link(vertexSource: String, fragmentSource: String): Int {
        val vertex = compile(GLES20.GL_VERTEX_SHADER, vertexSource)
        val fragment = compile(GLES20.GL_FRAGMENT_SHADER, fragmentSource)
        val program = GLES20.glCreateProgram()
        if (program == 0) throw IllegalStateException("glCreateProgram returned 0")
        GLES20.glAttachShader(program, vertex)
        GLES20.glAttachShader(program, fragment)
        GLES20.glLinkProgram(program)
        val status = IntArray(1)
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
        GLES20.glDeleteShader(vertex)
        GLES20.glDeleteShader(fragment)
        if (status[0] == 0) {
            val log = GLES20.glGetProgramInfoLog(program)
            GLES20.glDeleteProgram(program)
            throw IllegalStateException("program link: $log")
        }
        return program
    }

    private fun compile(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        if (shader == 0) throw IllegalStateException("glCreateShader returned 0")
        GLES20.glShaderSource(shader, source)
        GLES20.glCompileShader(shader)
        val status = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
        if (status[0] == 0) {
            val log = GLES20.glGetShaderInfoLog(shader)
            GLES20.glDeleteShader(shader)
            throw IllegalStateException("shader compile: $log")
        }
        return shader
    }

    private fun attribute(location: Int, size: Int, stride: Int, offset: Int) {
        if (location < 0) throw IllegalStateException("missing vertex attribute")
        GLES20.glEnableVertexAttribArray(location)
        GLES20.glVertexAttribPointer(location, size, GLES20.GL_FLOAT, false, stride, offset)
    }

    private fun uniformMatrix(location: Int, value: FloatArray) {
        GLES20.glUniformMatrix4fv(location, 1, false, value, 0)
    }

    private fun generateBuffer(): Int {
        val names = IntArray(1)
        GLES20.glGenBuffers(1, names, 0)
        if (names[0] == 0) throw IllegalStateException("glGenBuffers returned 0")
        return names[0]
    }

    private fun generateTexture(): Int {
        val names = IntArray(1)
        GLES20.glGenTextures(1, names, 0)
        if (names[0] == 0) throw IllegalStateException("glGenTextures returned 0")
        return names[0]
    }

    private fun releaseHandles() {
        mazeProgram = 0; spriteProgram = 0; ghoulProgram = 0; mazeVbo = 0; spriteVbo = 0
        mazeTextures.fill(0); spriteTextures.fill(0); ghoulTextures.fill(0)
    }

    private fun bindTexture(texture: Int) = GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)

    private fun floatBuffer(values: FloatArray): FloatBuffer =
        ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(values); position(0) }

    private fun rgb(r: Int, g: Int, b: Int): Int = -0x1000000 or (r.coerceIn(0, 255) shl 16) or
        (g.coerceIn(0, 255) shl 8) or b.coerceIn(0, 255)

    private enum class TextureKind { Floor, Ceiling, Brick }

    private class MazeLocations(program: Int) {
        val position = attribute(program, "aPosition")
        val normal = attribute(program, "aNormal")
        val uv = attribute(program, "aUv")
        val viewProjection = uniform(program, "uViewProjection")
        val camera = uniform(program, "uCamera")
        val direction = uniform(program, "uDirection")
        val lampRadius = uniform(program, "uLampRadius")
        val lampPhase = uniform(program, "uLampPhase")
        val lightCount = uniform(program, "uLightCount")
        val lightXyr = uniform(program, "uLightXyr[0]")
        val lightRgb = uniform(program, "uLightRgb[0]")
        val texture = uniform(program, "uTexture")
    }

    private class SpriteLocations(program: Int) {
        val quad = attribute(program, "aQuad")
        val viewProjection = uniform(program, "uViewProjection")
        val centre = uniform(program, "uCentre")
        val size = uniform(program, "uSize")
        val yaw = uniform(program, "uYaw")
        val lampRadius = uniform(program, "uLampRadius")
        val glowPhase = uniform(program, "uGlowPhase")
        val camera = uniform(program, "uCamera")
        val texture = uniform(program, "uTexture")
        val glow = uniform(program, "uGlow")
    }

    private class GhoulLocations(program: Int) {
        val quad = attribute(program, "aQuad")
        val viewProjection = uniform(program, "uViewProjection")
        val centre = uniform(program, "uCentre")
        val size = uniform(program, "uSize")
        val yaw = uniform(program, "uYaw")
        val camera = uniform(program, "uCamera")
        val lampRadius = uniform(program, "uLampRadius")
        val body = uniform(program, "uBody")
        val halo = uniform(program, "uHalo")
        val chest = uniform(program, "uChest")
        val feetV = uniform(program, "uFeetV")
        val phaseA = uniform(program, "uPhaseA")
        val phaseB = uniform(program, "uPhaseB")
        val flare = uniform(program, "uFlare")
        val sway = uniform(program, "uSway")
        val desaturation = uniform(program, "uDesat")
    }

    private companion object {
        fun attribute(program: Int, name: String): Int = GLES20.glGetAttribLocation(program, name).also {
            if (it < 0) throw IllegalStateException("missing attribute $name")
        }

        fun uniform(program: Int, name: String): Int = GLES20.glGetUniformLocation(program, name).also {
            if (it < 0) throw IllegalStateException("missing uniform $name")
        }

        const val TAG = "GhoulRun"
        const val FOV_RADIANS = (70.0 * PI / 180.0).toFloat()
        const val NEAR = 0.08f
        const val FAR = 60f
        const val TEXTURE_SIZE = 64
        const val GHOUL_BODY_ASSET = "arcade/ghoul/ghoul_body.png"
        const val GHOUL_HALO_ASSET = "arcade/ghoul/ghoul_halo.png"
        const val GHOUL_ANCHOR_ASSET = "arcade/ghoul/ghoul_anchor.json"

        const val MAZE_VERTEX = """
            uniform mat4 uViewProjection;
            attribute vec3 aPosition;
            attribute vec3 aNormal;
            attribute vec2 aUv;
            varying vec3 vWorld;
            varying vec3 vNormal;
            varying vec2 vUv;
            void main() {
                vWorld = aPosition;
                vNormal = aNormal;
                vUv = aUv * 2.0;
                gl_Position = uViewProjection * vec4(aPosition, 1.0);
            }
        """
        const val MAZE_FRAGMENT = """
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uTexture;
            uniform vec3 uCamera;
            uniform vec2 uDirection;
            uniform float uLampRadius;
            uniform float uLampPhase;
            uniform int uLightCount;
            uniform vec3 uLightXyr[8];
            uniform vec3 uLightRgb[8];
            varying vec3 vWorld;
            varying vec3 vNormal;
            varying vec2 vUv;
            void main() {
                vec3 delta = vWorld - uCamera;
                float distanceToCamera = length(delta);
                float radius = max(uLampRadius, 0.001);
                float cone = 0.64 + 0.36 * max(0.0, dot(normalize(delta.xy), uDirection));
                float lamp = (1.0 - smoothstep(radius * 0.30, radius, distanceToCamera)) * cone;
                lamp *= 0.975 + 0.025 * sin(uLampPhase);
                float pilot = 0.28 * (1.0 - smoothstep(0.35, 1.6, distanceToCamera));
                vec3 lighting = vec3(max(lamp, pilot)) * vec3(1.0, 0.86, 0.68);
                for (int i = 0; i < 8; ++i) {
                    if (i < uLightCount) {
                        vec3 toLight = vec3(uLightXyr[i].xy, 0.55) - vWorld;
                        float d = length(toLight);
                        float falloff = 1.0 - smoothstep(uLightXyr[i].z * 0.15, uLightXyr[i].z, d);
                        float lambert = 0.3 + 0.7 * max(0.0, dot(normalize(vNormal), normalize(toLight)));
                        lighting += uLightRgb[i] * falloff * lambert;
                    }
                }
                float face = 0.55 + 0.45 * abs(vNormal.z + vNormal.x * 0.55 - vNormal.y * 0.25);
                float fog = 1.0 - smoothstep(20.0, 42.0, distanceToCamera);
                vec3 base = texture2D(uTexture, vUv).rgb;
                gl_FragColor = vec4(base * min(vec3(1.35), lighting) * face * fog, 1.0);
            }
        """
        const val SPRITE_VERTEX = """
            uniform mat4 uViewProjection;
            uniform vec3 uCentre;
            uniform vec2 uSize;
            uniform float uYaw;
            attribute vec4 aQuad;
            varying vec2 vUv;
            varying vec3 vWorld;
            void main() {
                vec3 right = vec3(-sin(uYaw), cos(uYaw), 0.0);
                vWorld = uCentre + right * aQuad.x * uSize.x + vec3(0.0, 0.0, aQuad.y * uSize.y);
                vUv = aQuad.zw;
                gl_Position = uViewProjection * vec4(vWorld, 1.0);
            }
        """
        const val SPRITE_FRAGMENT = """
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uTexture;
            uniform vec3 uCamera;
            uniform float uLampRadius;
            uniform float uGlow;
            uniform float uGlowPhase;
            varying vec2 vUv;
            varying vec3 vWorld;
            void main() {
                vec4 texel = texture2D(uTexture, vUv);
                if (texel.a < 0.35) discard;
                float d = distance(vWorld, uCamera);
                float lamp = 1.0 - smoothstep(max(0.5, uLampRadius * 0.3), max(0.6, uLampRadius), d);
                float pilot = 0.28 * (1.0 - smoothstep(0.35, 1.6, d));
                float light = max(max(lamp, pilot), uGlow * (0.9 + 0.1 * sin(uGlowPhase)));
                gl_FragColor = vec4(texel.rgb * light, texel.a);
            }
        """
        const val GHOUL_FRAGMENT = """
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uBody;
            uniform sampler2D uHalo;
            uniform vec3 uCamera;
            uniform float uLampRadius;
            uniform vec2 uChest;
            uniform float uFeetV;
            uniform float uPhaseA;
            uniform float uPhaseB;
            uniform float uFlare;
            uniform float uSway;
            uniform float uDesat;
            varying vec2 vUv;
            varying vec3 vWorld;
            void main() {
                float distanceToCamera = distance(vWorld, uCamera);
                float lamp = 1.0 - smoothstep(max(0.5, uLampRadius * 0.3), max(0.6, uLampRadius), distanceToCamera);
                float pilot = 0.28 * (1.0 - smoothstep(0.35, 1.6, distanceToCamera));
                float light = max(lamp, pilot);

                const float ASPECT = 2.0;
                vec2 d = (vUv - uChest) * vec2(ASPECT, 1.0);
                float r = length(d) / 0.586;
                float theta = atan(d.y, d.x + 1e-5);
                float w = smoothstep(0.08, 0.9, r) * r;
                float tang = 0.0176 * w * sin(uPhaseA + theta * 3.0 + r * 4.0);
                float rad  = 0.0088 * w * sin(uPhaseB + theta * 5.0 - r * 6.0);
                float s = 1.0 + 0.14 * uFlare * smoothstep(0.3, 1.0, r);
                vec2 t = vec2(-sin(theta), cos(theta));
                vec2 u = vec2(cos(theta), sin(theta));
                vec2 dh = d / s - (t * tang + u * rad);
                vec4 halo = texture2D(uHalo, uChest + dh / vec2(ASPECT, 1.0));
                vec4 body = texture2D(uBody, vUv - vec2((uFeetV - vUv.y) * tan(uSway) / ASPECT, 0.0));
                vec4 c = body + halo * (1.0 - body.a);
                c.rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.3, 0.59, 0.11))), uDesat);
                if (c.a < 0.02) discard;
                gl_FragColor = vec4(c.rgb * light, c.a);
            }
        """
    }
}
