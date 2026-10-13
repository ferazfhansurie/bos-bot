package com.openmausbot.companion.core

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import kotlin.test.*

class ServerPairingParityTest {
    @Test fun serverCodeNormalizationMatchesServerAlphabet() {
        assertEquals("ABCD2345EFGH", CompanionClient.normalizedServerCode("abcd-2345 efgh"))
        assertNull(CompanionClient.normalizedServerCode("ABCD-2345-EFG0"))
        assertNull(CompanionClient.normalizedServerCode("123456"))
        assertFalse(Session.isQrCredential("ABCD-2345-EFGH"))
    }

    @Test fun directServerPairPreflightsDescriptorThenPersistsGrantedScopes() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val connection = requireNotNull(Connection.parse(server.url("/").toString())).establishingRoutePolicyFromInvite()
            server.enqueue(MockResponse().setBody("""{"environmentId":"env","label":"VPS"}"""))
            server.enqueue(MockResponse().setBody("""{"token":"omb_sess_fixture","session":{"id":"session","label":"Phone","scopes":["client"]},"environment":{"environmentId":"env","label":"VPS"}}"""))
            val result = CompanionClient.pairFirstReachable(connection, "abcd-2345-efgh", "Phone", "attempt-id")
            assertEquals("omb_sess_fixture", result.response.token)
            assertEquals("VPS", result.response.serverName)
            assertEquals(listOf("client"), result.serverPair?.session?.scopes)
            assertEquals("/.well-known/openmausbot/environment", server.takeRequest().path)
            val request = server.takeRequest()
            assertEquals("/api/auth/pair", request.path)
            assertNull(request.getHeader("Authorization"))
            val body = CompanionJson.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals("ABCD2345EFGH", body["code"]?.jsonPrimitive?.content)
            assertEquals("attempt-id", body["attemptId"]?.jsonPrimitive?.content)
        }
    }

    @Test fun sessionPersistsServerScopeAndNeverConfusesClientPairingWithOwner() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl?.encodedPath) {
                    "/.well-known/openmausbot/environment" -> MockResponse().setBody("""{"environmentId":"env","label":"VPS"}""")
                    "/api/auth/pair" -> MockResponse().setBody("""{"token":"omb_sess_fixture","session":{"id":"session","label":"Phone","scopes":["client"]},"environment":{"environmentId":"env","label":"VPS"}}""")
                    else -> MockResponse().setResponseCode(404).setBody("{}")
                }
            }
            var saved: Connection? = null
            val store = object : ConnectionStore {
                override suspend fun load() = saved
                override suspend fun save(connection: Connection) { saved = connection }
                override suspend fun clear() { saved = null }
            }
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val session = Session(scope, store, object : TokenStore {
                override suspend fun read(connectionId: String) = TokenStore.ReadResult.Missing
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun remove(connectionId: String) = Unit
            }, InMemoryOnboardingStore(), { "Phone" }, eventsFn = { _, _, _ -> flow {
                emit(StreamFrame(Frame.Hello("epoch:1", true))); awaitCancellation()
            } }, instancesFn = { emptyList() }, metadataFn = { throw APIError.Status(404) })
            try {
                session.awaitRestored()
                session.pair(requireNotNull(Connection.parse(server.url("/").toString())), "ABCD2345EFGH", "attempt-id")
                assertEquals("env", saved?.serverEnvironmentId)
                assertEquals(listOf("client"), saved?.serverScopes)
                assertFalse(session.canAdminister)
            } finally { session.disconnect(); scope.cancel() }
        }
    }

    @Test fun failedDescriptorNeverSpendsPairCode() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
            server.enqueue(MockResponse().setResponseCode(404).setBody("{}"))
            assertFailsWith<APIError.Transport> { CompanionClient.pairFirstReachable(connection, "ABCD2345EFGH", "Phone") }
            assertEquals(1, server.requestCount)
            assertEquals("/.well-known/openmausbot/environment", server.takeRequest().path)
        }
    }

    @Test fun workingTaskCannotBeMarkedDone() {
        assertFalse(BotTask("thread", "task", 1.0, busy = true).canMarkDone)
        assertFalse(BotTask("thread", "task", 1.0, activity = "running").canMarkDone)
        assertTrue(BotTask("thread", "task", 1.0, waitingOnTeammate = true).canMarkDone)
    }
}
