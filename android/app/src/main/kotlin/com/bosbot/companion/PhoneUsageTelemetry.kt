package com.openmausbot.companion

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.openmausbot.companion.core.Session
import com.openmausbot.companion.core.UsageEvent
import com.openmausbot.companion.core.UsageTelemetry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** Process lifecycle, independent local opt-out, no credentials or cookies. */
class PhoneUsageTelemetry(context: Context, private val scope: CoroutineScope, session: () -> Session) : DefaultLifecycleObserver {
    private val prefs = context.getSharedPreferences("bos.phoneUsage.v1", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS).build()
    private val telemetry = UsageTelemetry(
        version = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown",
        load = { prefs.getString("state", null) },
        save = { prefs.edit().putString("state", it).apply() },
        authorize = { session().phoneUsagePolicy() },
        post = { body ->
            withContext(Dispatchers.IO) {
                runCatching {
                    val request = Request.Builder().url("https://bosbot.my/api/events")
                        .post(body.toRequestBody("application/json".toMediaType())).build()
                    http.newCall(request).execute().use { it.isSuccessful }
                }.getOrDefault(false)
            }
        },
        // Debug/preview fixtures must never send synthetic public events.
        environment = if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
            System.getenv() + ("BOS_NO_PING" to "1") else System.getenv(),
    )
    private var ticker: Job? = null
    val enabled: Boolean get() = telemetry.enabled
    fun setEnabled(enabled: Boolean) = telemetry.setEnabled(enabled)
    fun pairSucceeded() = telemetry.record(UsageEvent.PAIR_SUCCESS)
    override fun onStart(owner: LifecycleOwner) {
        telemetry.foreground()
        if (ticker?.isActive == true) return
        ticker = scope.launch {
            while (isActive) {
                delay(60_000)
                telemetry.flush()
            }
        }
    }
    override fun onStop(owner: LifecycleOwner) {
        ticker?.cancel()
        ticker = null
        scope.launch { telemetry.background() }
    }
}
