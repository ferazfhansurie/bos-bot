package com.openmausbot.companion.updates

import android.app.Application
import android.content.Intent
import com.openmausbot.companion.core.AndroidAppUpdates
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlin.test.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class AndroidUpdateTest {
    @Test fun mandatoryGateRejectsCachedUpdatesBelowItsFloorOrFromAnotherManifest() {
        val manifest = com.openmausbot.companion.core.AndroidUpdateManifest("2.1.3", 20103, "https://bosbot.my/fixture.apk", "a".repeat(64))
        val ready = AndroidUpdateState(ready = File("fixture.apk"), manifest = manifest)
        assertNull(ready.readyFor(com.openmausbot.companion.core.PhoneUpdateRequired("2.2.0", AndroidAppUpdates.MANIFEST_URL)))
        assertNull(ready.readyFor(com.openmausbot.companion.core.PhoneUpdateRequired("2.1.3", "https://bosbot.my/custom.json")))
        assertNotNull(ready.readyFor(com.openmausbot.companion.core.PhoneUpdateRequired("2.1.3", AndroidAppUpdates.MANIFEST_URL)))
    }

    private val context get() = RuntimeEnvironment.getApplication()
    private fun reset() {
        context.getSharedPreferences("app-updates", 0).edit().clear().commit()
        File(context.cacheDir, "updates").deleteRecursively()
    }

    @Test fun recreatedControllerDoesNotCheckAgainUntilTheNextDay() = runBlocking {
        reset()
        var now = 1_000_000L
        var manifestChecks = 0
        var apkDownloads = 0
        val bytes = "verified fixture".toByteArray()
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val updates = AndroidAppUpdates(fetch = { url ->
            if (url.endsWith("android.json")) {
                manifestChecks++
                """{"version":"9.9.9","versionCode":99999,"url":"https://bosbot.my/fixture.apk","sha256":"$sha"}""".toByteArray()
            } else { apkDownloads++; bytes }
        })
        fun controller() = AndroidUpdateController(context, this, updates, { now })
        val first = controller()
        first.onOpen().join()
        assertContentEquals(bytes, first.state.value.ready!!.readBytes())
        val recreated = controller()
        recreated.onOpen().join()
        assertNotNull(recreated.state.value.ready)
        assertEquals(1, manifestChecks)
        assertEquals(1, apkDownloads)
        now += 86_400_000
        controller().onOpen().join()
        assertEquals(2, manifestChecks)
        assertEquals(1, apkDownloads)
    }

    @Test fun offlineAttemptStillCapsAutomaticChecksAndAllowsAnExplicitRetry() = runBlocking {
        reset()
        var checks = 0
        val updates = AndroidAppUpdates(fetch = { checks++; throw IOException("fixture offline") })
        fun controller() = AndroidUpdateController(context, this, updates, { 1_000_000L })
        val first = controller()
        first.onOpen().join()
        assertNotNull(first.state.value.error)
        controller().onOpen().join()
        assertEquals(1, checks)
        first.retry().join()
        assertEquals(2, checks)
    }

    // One test: FileProvider caches its path roots per authority in a static,
    // and each Robolectric test gets a fresh data dir.
    @Test fun installerReceivesOnlyAReadGrantToTheVerifiedApkAndNothingOutsideTheCache() {
        val apk = File(context.cacheDir, "updates/bos-update.apk").apply { parentFile!!.mkdirs(); writeText("fixture") }
        val intent = updatePackageIntent(context, apk)
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("application/vnd.android.package-archive", intent.type)
        assertEquals("content", intent.data!!.scheme)
        assertEquals("${context.packageName}.updates", intent.data!!.authority)
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags)
        assertEquals(intent.data, intent.clipData!!.getItemAt(0).uri)

        val privateFile = File(context.filesDir, "private-fixture").apply { writeText("fixture") }
        assertFailsWith<IllegalArgumentException> { updatePackageIntent(context, privateFile) }
    }
}
