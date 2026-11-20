// SPDX-License-Identifier: AGPL-3.0-only

package com.fitbaus.arcade

import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.egl.EGL10
import javax.microedition.khronos.egl.EGLContext
import javax.microedition.khronos.egl.EGLDisplay
import javax.microedition.khronos.opengles.GL10
import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.tan

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
    private val snapshots: GhoulGlSnapshotBuffer,
    private val failed: (String) -> Unit,
) : GLSurfaceView.Renderer {
    @Volatile var frameNanos: Long = 0L
        private set
    @Volatile var frameIntervalNanos: Long = 0L
        private set

    private var mazeProgram = 0
    private var spriteProgram = 0
    private var mazeVbo = 0
    private var spriteVbo = 0
    private var mazeSeed = Long.MIN_VALUE
    private var floorCount = 0
    private var ceilingCount = 0
    private var wallCount = 0
    private val mazeTextures = IntArray(3)
    private val spriteTextures = Array(GhoulSpriteKind.entries.size) { IntArray(GhoulSpriteArt.GHOUL_FRAMES) }
    private val eyeTextures = IntArray(GhoulSpriteArt.GHOUL_FRAMES)
    private val projection = FloatArray(16)
    private val view = FloatArray(16)
    private val viewProjection = FloatArray(16)
    private var width = 1
    private var height = 1
    private var ready = false
    private var lastFrameStarted = 0L
    private val frame = GhoulGlSnapshot()
    private lateinit var mazeLocations: MazeLocations
    private lateinit var spriteLocations: SpriteLocations

    override fun onSurfaceCreated(unused: GL10?, config: EGLConfig?) {
        try {
            releaseHandles()
            GLES20.glClearColor(0f, 0f, 0f, 1f)
            GLES20.glEnable(GLES20.GL_DEPTH_TEST)
            GLES20.glDepthFunc(GLES20.GL_LEQUAL)
            mazeProgram = link(MAZE_VERTEX, MAZE_FRAGMENT)
            spriteProgram = link(SPRITE_VERTEX, SPRITE_FRAGMENT)
            mazeLocations = MazeLocations(mazeProgram)
            spriteLocations = SpriteLocations(spriteProgram)
            createMazeTextures()
            createSpriteTextures()
            createSpriteVbo()
            mazeSeed = Long.MIN_VALUE
            ready = true
        } catch (error: RuntimeException) {
            ready = false
            failed("GLES2 setup failed: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    override fun onSurfaceChanged(unused: GL10?, newWidth: Int, newHeight: Int) {
        width = max(1, newWidth)
        height = max(1, newHeight)
        GLES20.glViewport(0, 0, width, height)
        val aspect = width.toFloat() / height
        val horizontal = FOV_DEGREES * PI.toFloat() / 180f
        val vertical = (2f * atan(tan(horizontal / 2f) / aspect)) * 180f / PI.toFloat()
        Matrix.perspectiveM(projection, 0, vertical, aspect, NEAR, FAR)
    }

    override fun onDrawFrame(unused: GL10?) {
        val started = System.nanoTime()
        if (lastFrameStarted != 0L) frameIntervalNanos = started - lastFrameStarted
        lastFrameStarted = started
        if (!ready) return
        try {
            snapshots.readInto(frame)
            val maze = frame.maze
            if (maze == null) {
                GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
                return
            }
            if (maze.seed != mazeSeed) uploadMaze(maze)
            val dirX = cos(frame.yaw)
            val dirY = sin(frame.yaw)
            Matrix.setLookAtM(
                view, 0,
                frame.cameraX, frame.cameraY, frame.eye,
                frame.cameraX + dirX, frame.cameraY + dirY, frame.eye,
                0f, 0f, 1f,
            )
            Matrix.multiplyMM(viewProjection, 0, projection, 0, view, 0)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            drawMaze(frame, dirX, dirY)
            drawSprites(frame)
            val error = GLES20.glGetError()
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
        GLES20.glUniform1f(mazeLocations.cadenceHz, frame.cadenceHz)
        GLES20.glUniform1f(mazeLocations.time, frame.timeSeconds)
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
        GLES20.glUseProgram(spriteProgram)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, spriteVbo)
        attribute(spriteLocations.quad, 4, 16, 0)
        uniformMatrix(spriteLocations.viewProjection, viewProjection)
        GLES20.glUniform1f(spriteLocations.yaw, frame.yaw)
        GLES20.glUniform1f(spriteLocations.lampRadius, frame.lampRadius)
        GLES20.glUniform1f(spriteLocations.time, frame.timeSeconds)
        GLES20.glUniform3f(spriteLocations.camera, frame.cameraX, frame.cameraY, frame.eye)
        GLES20.glUniform1i(spriteLocations.texture, 0)
        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)
        val frameIndex = (frame.timeSeconds / GhoulSpriteArt.FRAME_SECONDS).toInt() % GhoulSpriteArt.GHOUL_FRAMES
        var index = 0
        while (index < frame.spriteCount) {
            val base = index * 3
            val kind = GhoulSpriteKind.entries[frame.spriteXyk[base + 2].toInt()]
            val width = GhoulFirstPersonRenderer.spriteWidth(kind)
            val height = GhoulFirstPersonRenderer.spriteHeight(kind)
            GLES20.glUniform3f(spriteLocations.centre, frame.spriteXyk[base], frame.spriteXyk[base + 1], GhoulFirstPersonRenderer.spriteBase(kind))
            GLES20.glUniform2f(spriteLocations.size, width, height)
            GLES20.glUniform1f(spriteLocations.glow, GhoulFirstPersonRenderer.spriteGlow(kind, frame.timeSeconds))
            val textureFrame = if (kind == GhoulSpriteKind.Ghoul) frameIndex else 0
            bindTexture(spriteTextures[kind.ordinal][textureFrame])
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            if (kind == GhoulSpriteKind.Ghoul) {
                GLES20.glUniform1f(spriteLocations.glow, 1f)
                bindTexture(eyeTextures[frameIndex])
                GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            }
            index += 1
        }
        GLES20.glDisable(GLES20.GL_BLEND)
        GLES20.glBindBuffer(GLES20.GL_ARRAY_BUFFER, 0)
    }

    private fun createMazeTextures() {
        GLES20.glGenTextures(mazeTextures.size, mazeTextures, 0)
        uploadProcedural(mazeTextures[0], TextureKind.Floor)
        uploadProcedural(mazeTextures[1], TextureKind.Ceiling)
        uploadProcedural(mazeTextures[2], TextureKind.Brick)
    }

    private fun createSpriteTextures() {
        for (kind in GhoulSpriteKind.entries) {
            val h = GhoulSpriteArt.textureHeight(kind)
            val w = max(8, (h * GhoulFirstPersonRenderer.spriteWidth(kind) / GhoulFirstPersonRenderer.spriteHeight(kind)).toInt())
            val frames = if (kind == GhoulSpriteKind.Ghoul) GhoulSpriteArt.GHOUL_FRAMES else 1
            GLES20.glGenTextures(frames, spriteTextures[kind.ordinal], 0)
            var frame = 0
            while (frame < frames) {
                uploadArgb(spriteTextures[kind.ordinal][frame], w, h, GhoulSpriteArt.texture(kind, w, h, frame), mipmaps = false)
                frame += 1
            }
        }
        GLES20.glGenTextures(eyeTextures.size, eyeTextures, 0)
        val h = GhoulSpriteArt.textureHeight(GhoulSpriteKind.Ghoul)
        val w = (h * GhoulFirstPersonRenderer.spriteWidth(GhoulSpriteKind.Ghoul) / GhoulFirstPersonRenderer.spriteHeight(GhoulSpriteKind.Ghoul)).toInt()
        var frame = 0
        while (frame < eyeTextures.size) {
            uploadArgb(eyeTextures[frame], w, h, GhoulSpriteArt.texture(GhoulSpriteKind.Ghoul, w, h, frame, eyesOnly = true), mipmaps = false)
            frame += 1
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
        uploadArgb(texture, size, size, pixels, mipmaps = true)
    }

    private fun uploadArgb(texture: Int, width: Int, height: Int, pixels: IntArray, mipmaps: Boolean) {
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
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
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

    private fun releaseHandles() {
        mazeProgram = 0; spriteProgram = 0; mazeVbo = 0; spriteVbo = 0
        mazeTextures.fill(0); spriteTextures.forEach { it.fill(0) }; eyeTextures.fill(0)
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
        val cadenceHz = uniform(program, "uCadenceHz")
        val time = uniform(program, "uTime")
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
        val time = uniform(program, "uTime")
        val camera = uniform(program, "uCamera")
        val texture = uniform(program, "uTexture")
        val glow = uniform(program, "uGlow")
    }

    private companion object {
        fun attribute(program: Int, name: String): Int = GLES20.glGetAttribLocation(program, name).also {
            if (it < 0) throw IllegalStateException("missing attribute $name")
        }

        fun uniform(program: Int, name: String): Int = GLES20.glGetUniformLocation(program, name).also {
            if (it < 0) throw IllegalStateException("missing uniform $name")
        }

        const val FOV_DEGREES = 70f
        const val NEAR = 0.08f
        const val FAR = 60f
        const val TEXTURE_SIZE = 64

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
            precision mediump float;
            uniform sampler2D uTexture;
            uniform vec3 uCamera;
            uniform vec2 uDirection;
            uniform float uLampRadius;
            uniform float uCadenceHz;
            uniform float uTime;
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
                lamp *= 0.975 + 0.025 * sin(uTime * (7.0 + uCadenceHz * 6.0));
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
            precision mediump float;
            uniform sampler2D uTexture;
            uniform vec3 uCamera;
            uniform float uLampRadius;
            uniform float uGlow;
            uniform float uTime;
            varying vec2 vUv;
            varying vec3 vWorld;
            void main() {
                vec4 texel = texture2D(uTexture, vUv);
                if (texel.a < 0.35) discard;
                float d = distance(vWorld, uCamera);
                float lamp = 1.0 - smoothstep(max(0.5, uLampRadius * 0.3), max(0.6, uLampRadius), d);
                float pilot = 0.28 * (1.0 - smoothstep(0.35, 1.6, d));
                float light = max(max(lamp, pilot), uGlow * (0.9 + 0.1 * sin(uTime * 4.0)));
                gl_FragColor = vec4(texel.rgb * light, texel.a);
            }
        """
    }
}
