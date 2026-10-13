package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay

internal object DoneUndo {
    data class Offer(val title: String, val undo: suspend () -> Boolean, val id: Long = System.nanoTime())
    val current = MutableStateFlow<Offer?>(null)
    fun offer(title: String, undo: suspend () -> Boolean) { current.value = Offer(title, undo) }
}

@Composable
internal fun DoneUndoPill() {
    val offer by DoneUndo.current.collectAsState()
    val scope = rememberCoroutineScope()
    var busy by remember(offer?.id) { mutableStateOf(false) }
    LaunchedEffect(offer?.id) { val pending = offer ?: return@LaunchedEffect; delay(8000); if (DoneUndo.current.value === pending) DoneUndo.current.value = null }
    offer?.let { pending ->
        Surface(shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp), tonalElevation = 4.dp,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 90.dp)) {
            Row(Modifier.padding(start = 16.dp, end = 8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text(localized("Marked done"), Modifier.weight(1f))
                TextButton(enabled = !busy, onClick = { busy = true; scope.launch { try { if (pending.undo()) DoneUndo.current.value = null } finally { busy = false } } }) { Text(localized("Undo")) }
            }
        }
    }
}
