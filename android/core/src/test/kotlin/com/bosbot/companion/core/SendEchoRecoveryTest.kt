package com.openmausbot.companion.core

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flow
import okhttp3.mockwebserver.*
import kotlin.test.*

class SendEchoRecoveryTest {
    @Test fun acceptedMessageRecoversStalledSseWithoutSendingAgain() = runBlocking<Unit> {
        MockWebServer().use { server ->
            val posts = AtomicInteger()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.requestUrl?.encodedPath?.endsWith("/messages") == true && request.method == "POST") {
                        posts.incrementAndGet()
                        return MockResponse().setResponseCode(202).setBody("""{"threadId":"thread","message":{"id":"accepted","role":"user","kind":"text","at":1,"text":"hello"}}""")
                    }
                    return MockResponse().setResponseCode(404).setBody("{}")
                }
            }
            server.start()
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val streams = AtomicInteger()
            val bot = decodeFixture<Fleet>("bots-paged").bots.first().copy(threadId = "thread")
            val session = Session(scope, object : ConnectionStore {
                override suspend fun load() = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
            }, object : TokenStore {
                override suspend fun read(connectionId: String) = TokenStore.ReadResult.Found("fixture-token")
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun remove(connectionId: String) = Unit
            }, InMemoryOnboardingStore(), { "fixture" },
                eventsFn = { _, _, _ -> flow {
                    streams.incrementAndGet()
                    emit(StreamFrame(Frame.Hello("epoch:1", resumed = true)))
                    awaitCancellation()
                } },
                hydrateFn = { _, _ -> Fleet(listOf(bot), emptyList()) },
                instancesFn = { emptyList() }, metadataFn = { throw APIError.Status(404) })
            try {
                session.awaitRestored()
                session.connect()
                withTimeout(3_000) { while (streams.get() < 1) delay(10) }
                assertTrue(session.send("hello", emptyList(), Chat.BotChat(bot), durableSendId = "logical-send-0001"))
                assertEquals("accepted", session.state.value.transcript("thread").single().id)
                withTimeout(3_000) { while (streams.get() < 2) delay(10) }
                assertEquals(1, posts.get())
            } finally { session.disconnect(); scope.cancel() }
        }
    }
}
