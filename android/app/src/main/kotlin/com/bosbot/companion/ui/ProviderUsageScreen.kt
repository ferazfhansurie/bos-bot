package com.openmausbot.companion.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.ProviderUsageAccount
import com.openmausbot.companion.core.ProviderUsageWindow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProviderUsageScreen(onBack: () -> Unit) {
    val session = LocalCompanion.current.session
    val connection by session.connection.collectAsState()
    val fleet by session.state.collectAsState()
    val scope = rememberCoroutineScope()
    var accounts by remember(connection?.id) { mutableStateOf<List<ProviderUsageAccount>>(emptyList()) }
    var loading by remember(connection?.id) { mutableStateOf(true) }
    var error by remember(connection?.id) { mutableStateOf<String?>(null) }
    var checkedAt by remember(connection?.id) { mutableStateOf<Date?>(null) }
    suspend fun refresh() {
        val id = connection?.id
        loading = true
        try {
            val result = session.loadProviderUsage()
            if (id == session.connection.value?.id) { accounts = result; error = null; checkedAt = Date() }
        } catch (exception: CancellationException) { throw exception
        } catch (exception: Exception) { if (id == session.connection.value?.id) error = "Limits unavailable. Pull to retry." }
        finally { if (id == session.connection.value?.id) loading = false }
    }
    LaunchedEffect(connection?.id) { refresh() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            HeaderBackButton(onBack); Text(localized("Subscription limits"), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.weight(1f)); TextButton(enabled = !loading, onClick = { scope.launch { refresh() } }) { Text(localized("Refresh")) }
        }
        PullToRefreshBox(isRefreshing = loading && accounts.isNotEmpty(), onRefresh = { if (!loading) scope.launch { refresh() } }, modifier = Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                if (loading && accounts.isEmpty()) item { CircularProgressIndicator(Modifier.padding(16.dp)) }
                error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
                if (!loading && error == null && accounts.isEmpty()) item { Text(localized("No Claude or Codex account configured.")) }
                checkedAt?.let { item { Text(localized("Fetched ${DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(it)}. Pull to refresh."), style = MaterialTheme.typography.bodySmall) } }
                items(accounts, key = { "${it.provider}:${it.instanceId ?: it.account}" }) { account ->
                    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("${account.account} · ${if (account.provider == "claude") "Claude" else "Codex"}", style = MaterialTheme.typography.titleMedium)
                        val names = fleet.bots.filter { it.remote == null && it.modelSelection.instanceId == account.instanceId }.map { it.name }
                        if (names.isNotEmpty()) Text(names.joinToString(" + "), style = MaterialTheme.typography.bodySmall)
                        account.fiveHour?.let { UsageMeter("5h", it) }
                        UsageMeter("7d", account.sevenDay)
                    } }
                }
            }
        }
    }
}
@Composable
private fun UsageMeter(label: String, window: ProviderUsageWindow) {
    val percent = window.usedPercent?.takeIf { it.isFinite() }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth()) { Text(label, style = MaterialTheme.typography.titleSmall); Spacer(Modifier.weight(1f)); Text(percent?.let { "${it.roundToInt()}% used" } ?: "Unavailable", style = MaterialTheme.typography.bodySmall) }
        percent?.let { LinearProgressIndicator(progress = { (it / 100).toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth(), color = if (it >= 85) MaterialTheme.colorScheme.error else if (it >= 65) Color(0xFFFF9800) else MaterialTheme.colorScheme.primary) }
        window.resetsAt?.takeIf { it.isFinite() }?.let { Text(localized("Resets ${DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date((it * 1000).toLong()))}"), style = MaterialTheme.typography.bodySmall) }
    }
}
