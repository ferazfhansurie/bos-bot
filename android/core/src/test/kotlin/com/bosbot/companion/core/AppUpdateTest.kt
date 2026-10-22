package com.openmausbot.companion.core

import java.security.MessageDigest
import kotlin.test.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first

class AppUpdateTest {
    @Test fun initialServerCodeProbeGatesBeforeDecodingOrRedeemingTheCode() = runTest {
        val server = okhttp3.mockwebserver.MockWebServer()
        server.start()
        try {
            server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("""{"minPhoneVersion":"2.1.3","environmentId":{}}"""))
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
            assertFailsWith<PhoneUpdateRequired> {
                CompanionClient.pairFirstReachable(connection, "ABCD2345EFGH", "Fixture phone", phoneVersion = "2.0.5")
            }
            assertEquals(1, server.requestCount)
            assertEquals("GET", server.takeRequest().method)
        } finally { server.shutdown() }
    }

    @Test fun compatibilityFailureSurfacesTheGateWithoutBurningTheQrCredential() = runTest {
        val connection = Connection(id = "fixture", name = "Fixture", host = "127.0.0.1", port = 1)
        val connections = object : ConnectionStore {
            override suspend fun load(): Connection? = null
            override suspend fun save(connection: Connection) = Unit
            override suspend fun clear() = Unit
        }
        val tokens = object : TokenStore {
            override suspend fun read(connectionId: String) = TokenStore.ReadResult.Missing
            override suspend fun save(connectionId: String, token: String) = Unit
            override suspend fun remove(connectionId: String) = Unit
        }
        var probes = 0
        val session = Session(backgroundScope, connections, tokens, InMemoryOnboardingStore(), { "Fixture" },
            pairFn = { _, _, _, _ -> probes++; throw PhoneUpdateRequired("2.1.3", AndroidAppUpdates.MANIFEST_URL) })
        session.awaitRestored()
        val credential = "omb_pair_" + "a".repeat(43)
        repeat(2) { assertFailsWith<PhoneUpdateRequired> { session.pair(connection, credential) } }
        assertEquals(2, probes)
        assertEquals("2.1.3", session.phoneUpdateRequired.value?.minimumVersion)
    }

    @Test fun streamedBodyCannotExceedTheLimitWithoutAContentLength() {
        val output = java.io.ByteArrayOutputStream()
        assertFailsWith<IllegalArgumentException> {
            copyBoundedUpdate(java.io.ByteArrayInputStream(ByteArray(40_000)), output, 32_768)
        }
        assertEquals(32_768, output.size())
    }

    @Test fun streamedBodyCopiesTheExactBytesWithinTheLimit() {
        val bytes = ByteArray(40_000) { it.toByte() }
        val output = java.io.ByteArrayOutputStream()
        copyBoundedUpdate(java.io.ByteArrayInputStream(bytes), output, 40_000)
        assertContentEquals(bytes, output.toByteArray())
    }

    @Test fun sessionBlocksTheStreamWhenAnOlderPhoneNeedsAnUpdate() = kotlinx.coroutines.runBlocking {
        val server = okhttp3.mockwebserver.MockWebServer()
        server.start()
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default + kotlinx.coroutines.SupervisorJob())
        try {
            server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("""{"minPhoneVersion":"2.1.3","environmentId":{}}"""))
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
            val connections = object : ConnectionStore {
                override suspend fun load() = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
            }
            val tokens = object : TokenStore {
                override suspend fun read(connectionId: String) = TokenStore.ReadResult.Found("fixture-token")
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun remove(connectionId: String) = Unit
            }
            var openedStream = false
            val session = Session(scope, connections, tokens, InMemoryOnboardingStore(), { "Fixture phone" },
                phoneVersion = "2.0.5", eventsFn = { _, _, _ -> openedStream = true; kotlinx.coroutines.flow.emptyFlow() })
            session.awaitRestored()
            session.connect()
            val required = kotlinx.coroutines.withTimeout(5_000) {
                session.phoneUpdateRequired.first { it != null }
            }
            assertEquals("2.1.3", required?.minimumVersion)
            assertFalse(openedStream)
            assertEquals(Session.Status.Offline("Update the app to continue."), session.status.value)
        } finally { scope.cancel(); server.shutdown() }
    }

    @Test fun environmentRejectsOldPhoneBeforeDecodingNewFields() = runTest {
        val server = okhttp3.mockwebserver.MockWebServer()
        server.start()
        try {
            server.enqueue(okhttp3.mockwebserver.MockResponse().setBody("""{"minPhoneVersion":"2.1.3","environmentId":{}}"""))
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
            val error = assertFailsWith<PhoneUpdateRequired> { CompanionClient(connection, null).environment("2.0.5") }
            assertEquals("2.1.3", error.minimumVersion)
        } finally { server.shutdown() }
    }

    @Test fun checkIsDueOnlyOncePerDayIncludingClockRollback() {
        assertTrue(AndroidAppUpdates.checkDue(null, 100))
        assertFalse(AndroidAppUpdates.checkDue(100, 101))
        assertFalse(AndroidAppUpdates.checkDue(100, 99))
        assertTrue(AndroidAppUpdates.checkDue(100, 100 + 86_400_000))
    }

    @Test fun validManifestOnlyOffersHigherVersionCodeOverHttps() {
        val manifest = AndroidUpdateManifest("2.1.3", 20103, "https://bosbot.my/updates/bos.apk", "a".repeat(64))
        assertTrue(manifest.isNewerThan(20102))
        assertFalse(manifest.isNewerThan(20103))
        assertFailsWith<IllegalArgumentException> { manifest.copy(url = "http://bosbot.my/bos.apk").validate() }
        assertFailsWith<IllegalArgumentException> { manifest.copy(sha256 = "bad").validate() }
    }

    @Test fun checksumFailureNeverLeavesAnInstallableApk() = runTest {
        val directory = kotlin.io.path.createTempDirectory("bos-update-test").toFile()
        try {
            val manifest = AndroidUpdateManifest("2.1.3", 20103, "https://bosbot.my/bos.apk", "a".repeat(64))
            directory.resolve("bos-update.apk").writeText("stale update")
            val updates = AndroidAppUpdates(fetch = { "tampered".toByteArray() })
            assertFailsWith<IllegalArgumentException> { updates.download(manifest, directory) }
            assertTrue(directory.listFiles().orEmpty().isEmpty())
        } finally { directory.deleteRecursively() }
    }

    @Test fun verifiedDownloadIsPromotedOnlyAfterChecksumMatches() = runTest {
        val directory = kotlin.io.path.createTempDirectory("bos-update-test").toFile()
        try {
            val bytes = "verified apk fixture".toByteArray()
            val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            val manifest = AndroidUpdateManifest("2.1.3", 20103, "https://bosbot.my/bos.apk", hash.uppercase())
            val file = AndroidAppUpdates(fetch = { bytes }).download(manifest, directory)
            assertEquals("bos-update.apk", file.name)
            assertContentEquals(bytes, file.readBytes())
        } finally { directory.deleteRecursively() }
    }

    @Test fun phoneGateReadsMinimumBeforeIncompatibleEnvironmentDecode() {
        val raw = CompanionJson.parseToJsonElement("""{"minPhoneVersion":"2.1.3","environmentId":{},"phoneUpdateUrls":{"android":"https://bosbot.my/updates/android.json"}}""")
        val required = PhoneCompatibility.requiredUpdate(raw, "2.0.5")
        assertEquals("2.1.3", required?.minimumVersion)
        assertEquals(AndroidAppUpdates.MANIFEST_URL, required?.url)
        assertNull(PhoneCompatibility.requiredUpdate(raw, "2.1.3"))
        assertNull(PhoneCompatibility.requiredUpdate(CompanionJson.parseToJsonElement("{}"), "2.0.5"))
        assertNull(PhoneCompatibility.requiredUpdate(CompanionJson.parseToJsonElement("""{"minPhoneVersion":"invalid"}"""), "2.0.5"))
    }
}
