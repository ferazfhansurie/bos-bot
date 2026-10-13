package com.openmausbot.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** A destination is selected immediately; old conversation content never remains beneath it. */
@Composable
internal fun ConversationSkeleton(modifier: Modifier = Modifier) {
    val paint = MaterialTheme.colorScheme.onSurface.copy(alpha = .08f)
    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface).semantics {
        contentDescription = "Loading conversation"
    }.padding(horizontal = 20.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Box(Modifier.width(160.dp).height(24.dp).background(paint, RoundedCornerShape(12.dp)))
        Spacer(Modifier.height(14.dp))
        repeat(4) { row ->
            Column(Modifier.fillMaxWidth(if (row % 2 == 0) .82f else .64f).background(paint, RoundedCornerShape(22.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(3) { Box(Modifier.fillMaxWidth(if (it == 2) .7f else 1f).height(10.dp).background(paint, RoundedCornerShape(6.dp))) }
            }
        }
        Spacer(Modifier.weight(1f))
        Box(Modifier.fillMaxWidth().height(48.dp).background(paint, RoundedCornerShape(24.dp)))
    }
}
