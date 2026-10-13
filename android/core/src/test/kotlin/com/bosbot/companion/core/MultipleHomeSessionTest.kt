package com.openmausbot.companion.core

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.MutableSharedFlow
import okhttp3.mockwebserver.*
import kotlin.test.*

class MultipleHomeSessionTest {
    @Test fun pairedHomesStreamSeparatelyAndSendUsesOwningScopedToken() = runBlocking<Unit> {
        MockWebServer().use { first -> MockWebServer().use { second ->
            val firstPosts = AtomicInteger()
            val secondPosts = AtomicInteger()
            val cancelled = AtomicInteger()
            fun dispatcher(counter: AtomicInteger) = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.method == "POST" && request.requestUrl?.encodedPath?.endsWith("/messages") == true) {
                        counter.incrementAndGet()
                        return MockResponse().setResponseCode(202).setBody("""{"threadId":"other-thread","message":{"id":"accepted","role":"user","kind":"text","at":1,"text":"hello"}}""")
                    }
                    return MockResponse().setResponseCode(404).setBody("{}")
                }
            }
            first.dispatcher = dispatcher(firstPosts); second.dispatcher = dispatcher(secondPosts)
            first.start(); second.start()
            val primary = requireNotNull(Connection.parse(first.url("/").toString())).copy(id = "primary")
            val other = requireNotNull(Connection.parse(second.url("/").toString())).copy(id = "other", serverScopes = listOf("client"))
            var saved = ConnectionRegistry(listOf(primary, other), primary.id)
            val store = object : ConnectionStore {
                override suspend fun load() = saved.activeConnection
                override suspend fun save(connection: Connection) { saved = saved.upsert(connection) }
                override suspend fun clear() = Unit
                override suspend fun loadRegistry() = ConnectionRegistryRestore(saved, false)
                override suspend fun saveRegistry(registry: ConnectionRegistry) { saved = registry }
            }
            val tokens = object : TokenStore {
                override suspend fun read(connectionId: String) = TokenStore.ReadResult.Found("token-$connectionId")
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun remove(connectionId: String) = Unit
            }
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val template = decodeFixture<Fleet>("bots-paged").bots.first()
            val mainFrames = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 4)
            val otherFrames = MutableSharedFlow<StreamFrame>(extraBufferCapacity = 4)
            val session = Session(scope, store, tokens, InMemoryOnboardingStore(), { "fixture" },
                eventsFn = { client, _, _ -> flow {
                    try { emit(StreamFrame(Frame.Hello("epoch:1", false))); emitAll(if (client.connection.id == "primary") mainFrames else otherFrames) }
                    finally { cancelled.incrementAndGet() }
                } }, hydrateFn = { client, _ -> Fleet(listOf(template.copy(
                    id = "bot-${client.connection.id}", threadId = if (client.connection.id == "primary") "primary-thread" else "other-thread", tasks = null)), emptyList()) },
                instancesFn = { emptyList() }, metadataFn = { throw APIError.Status(404) })
            try {
                session.awaitRestored(); session.connect()
                withTimeout(4_000) { while (session.homesState.value.size != 2 || session.homesState.value.any { it.state.bots.isEmpty() }) delay(10) }
                val child = assertNotNull(session.home("other"))
                val bot = child.state.value.bots.single()
                assertSame(child, session.owner(Chat.BotChat(bot), "other"))
                assertNull(session.home("missing"))
                assertFailsWith<APIError.Transport> { session.startVoiceCall(bot.id, null, "call", expectedConnectionId = "other") }
                assertFailsWith<APIError.Transport> { session.reportVoiceUsage(bot.id, "call", 5, expectedConnectionId = "other") }
                assertTrue(session.send("hello", emptyList(), Chat.BotChat(bot), durableSendId = "logical-home-0001"))
                assertEquals(0, firstPosts.get()); assertEquals(1, secondPosts.get())
                assertTrue(session.state.value.transcript("other-thread").isEmpty())
                assertEquals("accepted", child.state.value.transcript("other-thread").first { it.id == "accepted" }.id)
                var request: RecordedRequest? = null
                while (request?.method != "POST") request = second.takeRequest()
                assertEquals("Bearer token-other", request.getHeader("Authorization"))
                mainFrames.emit(StreamFrame(Frame.Bot(bot.copy(name = "local duplicate"))))
                withTimeout(3_000) { while (session.state.value.bot(bot.id) == null) delay(10) }
                assertNull(session.owner(Chat.BotChat(bot)))
                assertSame(child, session.owner(Chat.BotChat(bot), "other"))
                assertFalse(session.send("ambiguous", emptyList(), Chat.BotChat(bot), durableSendId = "ambiguous-home-0001"))
                assertEquals(0, firstPosts.get()); assertEquals(1, secondPosts.get())
                session.disconnect()
                withTimeout(3_000) { while (cancelled.get() < 2) delay(10) }
            } finally { session.disconnect(); scope.cancel() }
        } }
    }
}
