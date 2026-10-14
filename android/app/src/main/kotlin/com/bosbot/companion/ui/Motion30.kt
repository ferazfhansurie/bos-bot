package com.openmausbot.companion.ui

import androidx.compose.foundation.Canvas
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * Everything that moves while a bot works — faces, the typing dots, the busy
 * spinners — ticks here, at 30fps, on one shared grid. A bare `withFrameNanos`
 * loop asks for every vsync, so one busy bot kept the whole window repainting at
 * 60fps (RenderThread ~60% CPU on a Galaxy A13, sitting still). Sleeping until
 * the next 1/30s grid point means no frame is requested in between, and every
 * loop on screen wakes on the same frame instead of interleaving back up to 60.
 * The iOS side is `TimelineView(.animation(minimumInterval: 1/30))`.
 */
internal suspend fun awaitMotionTick(onFrame: (Long) -> Unit) {
    withFrameNanos(onFrame)
    val now = System.nanoTime()
    val next = (now / MOTION_TICK_NANOS + 1) * MOTION_TICK_NANOS
    // Wake a little early: withFrameNanos then lands on the vsync at the grid point.
    val wait = (next - now) / 1_000_000 - 6
    if (wait > 0) delay(wait)
}

/**
 * The small indeterminate spinner, on the shared 30fps tick. Material's
 * CircularProgressIndicator runs its own 60fps infinite transition, which is
 * fine for a second of loading and expensive on a roster row that spins for a
 * whole turn.
 */
@Composable
internal fun TickSpinner(
    modifier: Modifier = Modifier,
    strokeWidth: Dp = 2.dp,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    val tick = remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        if ((coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f) == 0f) return@LaunchedEffect
        while (true) awaitMotionTick { tick.longValue = it }
    }
    Canvas(modifier.graphicsLayer()) {
        val t = tick.longValue / 1_000_000_000.0
        val stroke = strokeWidth.toPx()
        val inset = stroke / 2
        val sweep = 60f + 210f * ((kotlin.math.sin(t * Math.PI / .75) + 1) / 2).toFloat()
        drawArc(
            color = color,
            startAngle = ((t * 300) % 360).toFloat() - 90f,
            sweepAngle = sweep,
            useCenter = false,
            topLeft = androidx.compose.ui.geometry.Offset(inset, inset),
            size = androidx.compose.ui.geometry.Size(size.width - stroke, size.height - stroke),
            style = Stroke(stroke, cap = StrokeCap.Round),
        )
    }
}

internal const val MOTION_TICK_NANOS = 1_000_000_000L / 30
