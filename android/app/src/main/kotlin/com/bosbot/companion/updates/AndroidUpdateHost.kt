package com.openmausbot.companion.updates

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.core.Session
import java.io.File

@Composable
fun AndroidUpdateHost(controller: AndroidUpdateController, session: Session, install: (File) -> Unit, content: @Composable () -> Unit) {
    val required by session.phoneUpdateRequired.collectAsState()
    val update by controller.state.collectAsState()
    val compatibleReady = update.readyFor(required)
    var dismissed by remember(update.ready) { mutableStateOf(false) }
    if (required != null) {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Update the app", style = MaterialTheme.typography.headlineMedium)
                Text("This computer needs BOS ${required!!.minimumVersion} or later on your phone.")
                if (update.downloading) Text("Downloading the update…")
                update.error?.let { Text(it) }
                Button(enabled = !update.downloading, onClick = {
                    compatibleReady?.let(install) ?: controller.retry(required!!.url)
                }) { Text(if (compatibleReady != null) "Install update" else "Update the app") }
            }
        }
    } else {
        content()
        if (update.ready != null && !dismissed) {
            AlertDialog(
                onDismissRequest = { dismissed = true },
                title = { Text("BOS update ready") },
                text = { Text("Android will ask you to confirm the installation.") },
                confirmButton = { TextButton(onClick = { dismissed = true; install(update.ready!!) }) { Text("Install update") } },
                dismissButton = { TextButton(onClick = { dismissed = true }) { Text("Later") } },
            )
        }
    }
}
