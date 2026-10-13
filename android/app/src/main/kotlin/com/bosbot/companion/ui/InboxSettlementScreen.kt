package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Workspace setting, read and saved on the currently paired computer. Never optimistic. */
@Composable
fun InboxSettlementScreen(onBack: () -> Unit) {
    val session = LocalCompanion.current.session
    val connection by session.connection.collectAsState()
    val scope = rememberCoroutineScope()
    var days by remember(connection?.id) { mutableStateOf<Int?>(null) }
    var loading by remember(connection?.id) { mutableStateOf(true) }
    var saving by remember(connection?.id) { mutableStateOf(false) }
    var error by remember(connection?.id) { mutableStateOf<String?>(null) }
    var loadAttempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(connection?.id, loadAttempt) {
        loading = true
        val config = session.configStatus()
        if (config != null) { days = config.threads?.autoSettleDays ?: 3; error = null }
        else error = "Couldn't load this setting from your computer. Check that it's connected, then retry."
        loading = false
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) { HeaderBackButton(onBack); Text(localized("Inbox settlement"), style = MaterialTheme.typography.titleMedium) }
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) { Text(localized("Close idle threads after"), Modifier.weight(1f)); if (loading || saving) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
            val choices = listOf(0, 1, 3, 7, 14, 30).let { if (days != null && days !in it) (it + days!!).sorted() else it }
            choices.forEach { value ->
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected = value == days, enabled = days != null && !loading && !saving, role = Role.RadioButton, onClick = {
                    val id = connection?.id
                    saving = true; error = null
                    scope.launch {
                        try {
                            session.setThreadSettlement(value)
                            val verified = session.configStatus() ?: throw IllegalStateException("Saved, but could not verify the setting. Retry to read it from your computer.")
                            if (id == session.connection.value?.id) days = verified.threads?.autoSettleDays ?: 3
                        } catch (exception: CancellationException) { throw exception
                        } catch (exception: Exception) { if (id == session.connection.value?.id) error = exception.message ?: "Couldn't save this setting. Retry when the computer is connected." }
                        finally { if (id == session.connection.value?.id) saving = false }
                    }
                }), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = value == days, onClick = null, enabled = days != null && !loading && !saving)
                    Text(when(value) { 0 -> "Off"; 1 -> "1 day"; else -> "$value days" })
                }
            }
            Text(localized("Unread replies, questions, approvals and running work stay open. Closed threads remain in All threads."), style = MaterialTheme.typography.bodySmall)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { loadAttempt++ }, enabled = !loading && !saving) { Text(localized("Retry")) } }
        }
    }
}
