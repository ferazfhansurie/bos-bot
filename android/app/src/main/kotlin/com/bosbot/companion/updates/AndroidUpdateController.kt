package com.openmausbot.companion.updates

import android.content.Context
import androidx.core.content.pm.PackageInfoCompat
import com.openmausbot.companion.core.AndroidAppUpdates
import com.openmausbot.companion.core.AndroidUpdateManifest
import com.openmausbot.companion.core.CompanionJson
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

data class AndroidUpdateState(
    val downloading: Boolean = false,
    val ready: File? = null,
    val error: String? = null,
    val manifest: AndroidUpdateManifest? = null,
    val manifestUrl: String = AndroidAppUpdates.MANIFEST_URL,
) {
    fun readyFor(required: com.openmausbot.companion.core.PhoneUpdateRequired?): File? {
        if (required == null) return ready
        val verified = manifest ?: return null
        return ready.takeIf {
            manifestUrl == required.url && com.openmausbot.companion.core.PhoneCompatibility.isAtLeast(verified.version, required.minimumVersion)
        }
    }
}

/** The check timestamp lives outside the process; an offline launch still counts. */
class AndroidUpdateController(
    context: Context,
    private val scope: CoroutineScope,
    private val updates: AndroidAppUpdates = AndroidAppUpdates(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val preferences = context.getSharedPreferences("app-updates", Context.MODE_PRIVATE)
    private val directory = File(context.cacheDir, "updates")
    private val installedCode = PackageInfoCompat.getLongVersionCode(context.packageManager.getPackageInfo(context.packageName, 0))
    private val mutex = Mutex()
    private val _state = MutableStateFlow(AndroidUpdateState())
    val state = _state.asStateFlow()

    fun onOpen() = checkForUpdate(manual = false)
    fun retry(manifestUrl: String = AndroidAppUpdates.MANIFEST_URL) = checkForUpdate(manual = true, manifestUrl)

    private fun checkForUpdate(manual: Boolean, manifestUrl: String = AndroidAppUpdates.MANIFEST_URL) = scope.launch {
        if (!mutex.tryLock()) return@launch
        try {
            val now = clock()
            val last = if (preferences.contains("last-check")) preferences.getLong("last-check", 0) else null
            val due = manual || AndroidAppUpdates.checkDue(last, now)
            var source = preferences.getString("manifest-url", AndroidAppUpdates.MANIFEST_URL) ?: AndroidAppUpdates.MANIFEST_URL
            var manifest = preferences.getString("manifest", null)?.let {
                runCatching { CompanionJson.decodeFromString<AndroidUpdateManifest>(it) }.getOrNull()
            }
            if (due) {
                _state.value = AndroidUpdateState(downloading = true)
                // Commit before networking so a process death cannot remove the daily cap.
                check(withContext(Dispatchers.IO) { preferences.edit().putLong("last-check", now).commit() })
                manifest = updates.manifest(manifestUrl)
                source = manifestUrl
                preferences.edit().putString("manifest", CompanionJson.encodeToString(manifest)).putString("manifest-url", source).apply()
            }
            val available = manifest
            if (available == null || !available.isNewerThan(installedCode)) {
                _state.value = AndroidUpdateState()
                return@launch
            }
            val ready = File(directory, "bos-update.apk")
            if (withContext(Dispatchers.IO) { AndroidAppUpdates.verified(ready, available) }) {
                _state.value = AndroidUpdateState(ready = ready, manifest = available, manifestUrl = source)
            } else if (due) {
                _state.value = AndroidUpdateState(downloading = true)
                _state.value = AndroidUpdateState(ready = updates.download(available, directory), manifest = available, manifestUrl = source)
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            _state.value = AndroidUpdateState(error = "Couldn't download the update. Check your connection and try again.")
        } finally { mutex.unlock() }
    }
}
