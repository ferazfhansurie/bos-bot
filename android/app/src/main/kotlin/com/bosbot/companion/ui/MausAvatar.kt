package com.openmausbot.companion.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.MutableLongState
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.min
import kotlin.math.sqrt
import kotlinx.coroutines.flow.collectLatest

/**
 * A bot, at whatever size the row needs — and alive, exactly the way it is on the
 * desktop. The port of `MausAvatar` in `ios/App/MausAvatar.swift`: [MausFaceEngine]
 * picks and morphs the expressions of the [state], this draws them — body, eyes
 * (no mouth, ever), and the comet rings the working states wear.
 *
 * The frame clock is read inside the canvas, not in composition, so a tick
 * repaints the mascot without recomposing the row it sits in.
 */
@Composable
internal fun MausAvatar(
    color: String,
    /** Which catalog body to draw; null and unknown ids fall back to the cursor. */
    bodyId: String? = null,
    size: Dp = 52.dp,
    state: MausState = MausState.IDLE,
    /** Off draws the state's resting face, still. For lists of many. */
    animated: Boolean = false,
    modifier: Modifier = Modifier,
    eyeStyle: String = "glyph",
    gaze: androidx.compose.ui.geometry.Offset = androidx.compose.ui.geometry.Offset.Zero,
) {
    GlyphAvatar(color, bodyId, size, state, animated, modifier, eyeStyle, gaze)
}

/**
 * The person, not a bot — the roster header and the settings row. A letter
 * rather than a mascot, deliberately: the mascots mean "this is a bot", and
 * giving the human one too would blur the only distinction the roster makes.
 */
@Composable
fun ProfileAvatar(name: String, size: Dp = 34.dp, modifier: Modifier = Modifier) {
    Box(modifier = modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size)) {
            drawCircle(color = Color(MausPalette.argb("green")))
        }
        Text(
            text = name.trim().take(1).uppercase(),
            color = Color.White,
            fontSize = (size.value * 0.45f).sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/**
 * One avatar's clock: the loop hands it frame times, the canvas reads the one it
 * published.
 *
 * A class holding [onFrame] rather than a lambda written inside the loop, because a
 * lambda that captures a `var` cannot be a constant — the compiler builds a fresh
 * one on every turn of the loop, which is an allocation per frame per face on
 * screen, in a build with no shrinker behind it to notice. The frame state lives
 * here for the same reason: captured `var`s become a `Ref` object.
 *
 * The origin survives the loop stopping and starting, so a face that scrolled away
 * and came back continues its own timeline rather than jumping.
 *
 * Shared with [WorkingBubble], which wants exactly this: a 30fps tick published as
 * state the draw phase reads, with nothing allocated per frame.
 */
internal class MausFrameClock {
    /** Nanoseconds since this avatar's first animated frame; read in the draw phase. */
    val nanos: MutableLongState = mutableLongStateOf(0L)

    /** Built once, handed to `awaitMotionTick` on every tick. */
    val onFrame: (Long) -> Unit = ::publish

    private var origin = NO_ORIGIN

    private fun publish(now: Long) {
        if (origin == NO_ORIGIN) origin = now
        val elapsed = now - origin
        // The tick itself is held to 30fps by awaitMotionTick; every frame it
        // delivers is one to draw.
        nanos.longValue = elapsed
    }
}

/** The scratch one drawn mascot reuses: a list of them redraws on every scroll frame. */
private class MausFaceGeometry {
    val eyes: Array<Path> = arrayOf(Path(), Path())
    val comet: Path = Path()
    val comets: MausCometField = MausCometField()
    val pose: MausBodyPose = MausBodyPose()

    /**
     * One brush per comet palette, over the unit segment (0,0)→(1,0); [drawComets]
     * aims it at the comet with a transform rather than building a new gradient.
     * They belong to the avatar rather than the process because a `ShaderBrush`
     * caches its shader per draw size, and two avatars are two sizes.
     */
    val cometBrushes: Array<Brush> by lazy(LazyThreadSafetyMode.NONE) {
        Array(MausComets.colors.size) { index ->
            val palette = MausComets.colors[index]
            Brush.linearGradient(
                colorStops = arrayOf(
                    0f to Color(palette[0]),
                    0.52f to Color(palette[1]),
                    1f to Color(palette[2]).copy(alpha = 0.35f),
                ),
                start = Offset.Zero,
                end = Offset(1f, 0f),
            )
        }
    }
}

private fun DrawScope.drawMaus(
    engine: MausFaceEngine,
    geometry: MausFaceGeometry,
    body: Brush,
    bodyId: String?,
    live: Boolean,
    nowNanos: Long,
) {
    val box = MausFaceData.FACE_BOX + MausSilhouette.FACE_MARGIN * 2
    val fit = min(size.width, size.height) / box
    withTransform({
        translate((size.width - box * fit) / 2f, (size.height - box * fit) / 2f)
        scale(fit, fit, Offset.Zero)
        translate(MausSilhouette.FACE_MARGIN, MausSilhouette.FACE_MARGIN)
    }) {
        val centre = MausFaceData.FACE_BOX / 2f
        val elapsed = engine.elapsedMillis(nowNanos)
        val trail = MausComets.trails[engine.state]
        if (trail != null) {
            geometry.comets.update(trail, elapsed, centre, centre)
            drawComets(geometry, front = false)
        }

        val pose = geometry.pose
        if (live) engine.motion.poseAt(elapsed, pose)
        // The body in its own transform, so the rings are not under it. Comet
        // states sit back a little, so the rings clear them.
        withTransform({
            if (trail != null) scale(trail.bodyScale, trail.bodyScale, Offset(centre, centre))
            if (live) {
                translate(pose.dx, pose.dy)
                rotate(pose.rotationDegrees, Offset(centre, centre))
                scale(pose.scale, pose.scale, Offset(centre, centre))
                scale(pose.squashX, pose.squashY, Offset(centre, MausFaceData.FACE_BOX))
            }
        }) {
            drawBody(engine, geometry, body, bodyId, nowNanos)
        }

        if (trail != null) drawComets(geometry, front = true)
    }
}

private fun DrawScope.drawBody(
    engine: MausFaceEngine,
    geometry: MausFaceGeometry,
    body: Brush,
    bodyId: String?,
    nowNanos: Long,
) {
    // Parsed and placed once per body, inside [MausSilhouette]; this is a lookup.
    val silhouette = MausSilhouette.inFaceBox(bodyId)
    val anchor = MausSilhouette.anchor(bodyId)
    drawPath(silhouette, body)

    // The face is painted on the body: clipped to it, anchored in it — where the
    // generator solved the anchor for this body.
    clipPath(silhouette) {
        withTransform({
            translate(anchor.x, anchor.y)
            scale(anchor.scale, anchor.scale, Offset.Zero)
            translate(-MausFaceData.FACE_CENTRE_X, -MausFaceData.FACE_CENTRE_Y)
        }) {
            val left = engine.ring(0)
            val right = engine.ring(1)
            val blink = engine.blinkScale(nowNanos)
            drawEye(left, geometry.eyes[0], blink)
            drawEye(right, geometry.eyes[1], blink)
        }
    }
}

private fun DrawScope.drawEye(ring: FloatArray, path: Path, blink: Float) {
    val axis = centreY(ring)
    path.reset()
    var index = 0
    while (index < ring.size) {
        // blink squashes the eye towards its own centre line
        val y = axis + (ring[index + 1] - axis) * blink
        if (index == 0) path.moveTo(ring[0], y) else path.lineTo(ring[index], y)
        index += 2
    }
    path.close()
    drawPath(path, Color.White)
}

/**
 * A comet's colours run head to tail along it, and both ends move every frame. So
 * the piece is drawn in the gradient's own space — head at (0,0), tail at (1,0) —
 * and put back where it belongs with a transform. Same pixels as aiming a fresh
 * gradient at it, without a new brush, colour list and shader per piece per frame.
 */
private fun DrawScope.drawComets(geometry: MausFaceGeometry, front: Boolean) {
    val field = geometry.comets
    for (index in 0 until field.count) {
        val piece = field.piece(index)
        if (piece.front != front) continue
        val axisX = piece.gradientEndX - piece.gradientStartX
        val axisY = piece.gradientEndY - piece.gradientStartY
        val span = axisX * axisX + axisY * axisY
        if (span < 1e-6f) continue

        val path = geometry.comet
        path.reset()
        for (point in 0 until piece.points) {
            val offsetX = piece.outline[point * 2] - piece.gradientStartX
            val offsetY = piece.outline[point * 2 + 1] - piece.gradientStartY
            val along = (offsetX * axisX + offsetY * axisY) / span
            val across = (offsetY * axisX - offsetX * axisY) / span
            if (point == 0) path.moveTo(along, across) else path.lineTo(along, across)
        }
        path.close()

        val length = sqrt(span)
        withTransform({
            translate(piece.gradientStartX, piece.gradientStartY)
            rotate(atan2(axisY, axisX) * DEGREES_PER_RADIAN, Offset.Zero)
            scale(length, length, Offset.Zero)
        }) {
            drawPath(path, geometry.cometBrushes[piece.colorIndex])
        }
    }
}

private fun centreY(ring: FloatArray): Float {
    var total = 0f
    var index = 1
    while (index < ring.size) {
        total += ring[index]
        index += 2
    }
    return total / (ring.size / 2)
}

private val DEGREES_PER_RADIAN = (180 / PI).toFloat()
private const val NO_ORIGIN = Long.MIN_VALUE
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data
