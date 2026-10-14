package com.openmausbot.companion.ui

import android.content.Context
import android.graphics.Region
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/** Same shipped body paths and glyph table as iOS, parsed once per process. */
internal class GlyphArtwork(context: Context) {
    val table = JSONObject(context.assets.open("glyph-faces.json").bufferedReader().use { it.readText() })
    private val paths = table.getJSONObject("paths")
    val glyphs = paths.keys().asSequence().associateWith { PathParser().parsePathString(paths.getString(it)).toPath() }
    val faces = table.getJSONObject("faces")
    val palette = table.getJSONObject("palette")
    val layout = table.getJSONObject("layout")
    val bodies: Map<String, Path>
    val centers: Map<String, Offset>

    init {
        val raw = JSONArray(context.assets.open("flat-mascot-bodies.json").bufferedReader().use { it.readText() })
        bodies = (0 until raw.length()).associate { i ->
            val row = raw.getJSONObject(i)
            row.getString("id") to PathParser().parsePathString(row.getString("path")).toPath()
        }
        centers = bodies.mapValues { (_, path) ->
            val region = Region().apply { setPath(path.asAndroidPath(), Region(0, 0, 100, 100)) }
            var xSum = 0f; var ySum = 0f; var count = 0
            for (y in 1 until 100 step 2) for (x in 1 until 100 step 2) if (region.contains(x, y)) {
                xSum += x; ySum += y; count++
            }
            if (count == 0) Offset(50f, 50f) else Offset(xSum / count, ySum / count)
        }
    }

    fun bodyKey(id: String?): String {
        val key = when (id) { "shield" -> "hexagon"; "diamond" -> "squircle"; null -> "circle"; else -> id }
        return key.takeIf { it in bodies } ?: "circle"
    }
    fun color(name: String): Color {
        val hex = if (Regex("#[0-9a-fA-F]{6}").matches(name)) name else palette.optString(name, "#009957")
        return Color(android.graphics.Color.parseColor(hex))
    }

    companion object {
        @Volatile private var cached: GlyphArtwork? = null
        fun load(context: Context): GlyphArtwork = cached ?: synchronized(this) {
            cached ?: GlyphArtwork(context.applicationContext).also { cached = it }
        }
    }
}

internal fun MausState.glyphState(): String = when (this) {
    MausState.THINKING -> "thinking"
    MausState.SEARCHING -> "searching"
    MausState.WORKING, MausState.ORBIT, MausState.PROGRESS, MausState.LOADING -> "working"
    MausState.SAD, MausState.ANGRY -> "failed"
    MausState.HAPPY, MausState.EXCITED, MausState.PLAYFUL -> "happy"
    MausState.CELEBRATE, MausState.PROUD -> "finished"
    MausState.DROWSY, MausState.SLEEPING -> "asleep"
    else -> if (id.contains("wait") || id.contains("approval")) "waiting" else "idle"
}

private fun luminance(c: Color): Double {
    fun channel(v: Float) = if (v <= .04045f) v / 12.92 else ((v + .055) / 1.055).pow(2.4)
    return .2126 * channel(c.red) + .7152 * channel(c.green) + .0722 * channel(c.blue)
}
private fun contrast(a: Color, b: Color): Double {
    val x = luminance(a); val y = luminance(b)
    return (max(x, y) + .05) / (min(x, y) + .05)
}

@Composable
internal fun GlyphAvatar(color: String, bodyId: String?, size: Dp, state: MausState, animated: Boolean, modifier: Modifier, eyeStyle: String = "glyph", gaze: Offset = Offset.Zero) {
    val context = LocalContext.current
    val art = remember(context.applicationContext) { GlyphArtwork.load(context) }
    val bodyKey = art.bodyKey(bodyId)
    val body = art.bodies.getValue(bodyKey)
    val centre = art.centers.getValue(bodyKey)
    val paint = art.color(color)
    val dark = androidx.compose.material3.MaterialTheme.colorScheme.surface.red < .5f
    val background = if (dark) Color(0xFF111111) else Color.White
    val ink = if (contrast(paint, Color.White) >= contrast(paint, Color.Black)) Color.White else Color.Black
    val accentPaint = if (contrast(paint, background) >= 1.6) paint else if (dark) Color.White else Color.Black
    val phase = remember { mutableLongStateOf(0L) }
    LaunchedEffect(animated) {
        if (!animated || (coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f) == 0f) return@LaunchedEffect
        while (true) awaitMotionTick { now -> phase.longValue = now }
    }
    val face = art.faces.getJSONObject(state.glyphState())
    // Its own layer when it moves: a tick then re-records this face, not the screen.
    Canvas(modifier.size(size).then(if (animated) Modifier.graphicsLayer() else Modifier)) {
        val side = min(this.size.width, this.size.height)
        val k = side / 100f
        val bounds = body.getBounds()
        val diameter = min(bounds.width, bounds.height) * k
        val t = phase.longValue / 1_000_000_000.0
        val blink = animated && phase.longValue > 0 && (t + color.sumOf { it.code } % 17 / 4.0) % 4.3 < .11
        withTransform({ scale(k, k, Offset.Zero) }) {
            drawPath(body, paint)
            if (contrast(paint, background) < 1.25) drawPath(body, ink.copy(alpha = .22f), style = Stroke(max(1f, side / 52f) / k))
        }
        if (eyeStyle != "glyph") {
            val openness = if (blink) .14f else 1f
            withTransform({ scale(k, k, Offset.Zero); translate(centre.x - 50f + gaze.x.coerceIn(-6f, 6f), centre.y - 45f + gaze.y.coerceIn(-6f, 6f)) }) {
                for (x in listOf(40f, 60f)) {
                    when (eyeStyle) {
                        "round" -> drawOval(ink, Offset(x - 1.75f, 45f - 5f * openness), Size(10f, 10f * openness))
                        "arches" -> { val path = Path().apply { moveTo(x - 1f, 47f); quadraticBezierTo(x + 3.25f, 47f - 13f * openness, x + 7.5f, 47f) }; drawPath(path, ink, style = Stroke(4f, cap = StrokeCap.Round, join = StrokeJoin.Round)) }
                        "angled" -> drawLine(ink, Offset(x + 1.75f, 45f - 6f * openness), Offset(x + 4.75f, 45f + 6f * openness), strokeWidth = 6f, cap = StrokeCap.Round)
                        else -> drawRoundRect(ink, Offset(x, 45f - 7f * openness), Size(6.5f, 14f * openness), CornerRadius(min(3.25f, 7f * openness)))
                    }
                }
            }
            return@Canvas
        }
        val eyeScale = art.layout.getDouble("eyeBox").toFloat() * diameter / art.table.getDouble("viewBox").toFloat()
        val stroke = max(art.table.getDouble("stroke").toFloat(), art.layout.getDouble("minStrokePx").toFloat() / eyeScale)
        withTransform({ translate((centre.x + gaze.x.coerceIn(-6f, 6f)) * k, (centre.y + gaze.y.coerceIn(-6f, 6f)) * k); rotate(art.table.getDouble("tiltDeg").toFloat(), Offset.Zero) }) {
            for ((glyph, direction) in listOf(face.getString("left") to -1, face.getString("right") to 1)) {
                withTransform({
                    translate(direction * art.layout.getDouble("eyeX").toFloat() * diameter, art.layout.getDouble("eyeY").toFloat() * diameter)
                    scale(eyeScale, eyeScale, Offset.Zero); translate(-12f, -12f)
                }) { drawPath(art.glyphs.getValue(if (blink) "dash" else glyph), ink, style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round)) }
            }
        }
        val anchor = face.optString("anchor")
        val glyph = face.optString("accent")
        if (size.value >= art.layout.getDouble("accentMinSize") && art.glyphs.containsKey(glyph)) {
            val place = art.layout.getJSONObject("accent").optJSONObject(anchor)
            if (place != null) {
                val box = place.getDouble("box").toFloat() * diameter
                val scale = box / 24f
                val float = if (animated && anchor != "split") sin(t * 2 * Math.PI / 1.8).toFloat() * .025f * diameter else 0f
                withTransform({
                    translate(bounds.center.x * k + place.getDouble("x").toFloat() * diameter - box / 2,
                        bounds.center.y * k + place.getDouble("y").toFloat() * diameter - box / 2 + float)
                    scale(scale, scale, Offset.Zero)
                }) { drawPath(art.glyphs.getValue(glyph), accentPaint, style = Stroke(max(place.getDouble("stroke").toFloat(), 1.5f / scale), cap = StrokeCap.Round, join = StrokeJoin.Round)) }
            }
        }
    }
}
