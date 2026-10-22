package com.openmausbot.companion.sharing

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/** Shares only the bounded, typed connection events, never a raw exception or URL. */
fun shareConnectionTrace(context: Context, trace: String): String? = try {
    val directory = File(context.cacheDir, "connection-traces")
    check(directory.exists() || directory.mkdirs())
    val file = File(directory, "bos-connection-trace.log")
    file.writeText(trace)
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.transcripts", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, "BOS connection trace")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, "Share connection trace").apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (context !is android.app.Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(chooser)
    null
} catch (_: Exception) {
    "Could not share the trace. Please try again."
}
