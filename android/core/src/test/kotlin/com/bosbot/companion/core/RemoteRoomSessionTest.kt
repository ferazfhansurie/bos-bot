package com.openmausbot.companion.core

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flow
import okhttp3.mockwebserver.*
import kotlin.test.*

class RemoteRoomSessionTest {
    @Test fun relayedRoomStreamCannotAdvanceLocalCursorOrInjectPrivateState() = runBlocking<Unit> {
        MockWebServer().use { server ->
            server.start()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = if (request.requestUrl?.encodedPath == "/api/threads/joined/messages")
                    MockResponse().setBody("""{"messages":[],"hasMore":false}""") else MockResponse().setResponseCode(404).setBody("{}")
            }
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
            val bot = decodeFixture<Fleet>("bots-paged").bots.first()
            val room = decodeFixture<Fleet>("bots-paged").groups.first().copy(id = "joined-room", threadId = "joined", home = RoomHome("remote", "Remote"), messages = emptyList())
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val session = Session(scope, object : ConnectionStore {
                override suspend fun load() = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
            }, object : TokenStore {
                override suspend fun read(connectionId: String) = TokenStore.ReadResult.Found("fixture-token")
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun remove(connectionId: String) = Unit
            }, InMemoryOnboardingStore(), { "fixture" }, eventsFn = { _, _, _ -> flow {
                emit(StreamFrame(Frame.Hello("local:1", false))); awaitCancellation()
            } }, hydrateFn = { _, _ -> Fleet(listOf(bot), listOf(room)) }, instancesFn = { emptyList() },
                metadataFn = { throw APIError.Status(404) }, roomEventsFn = { _, roomId -> flow {
                    assertEquals("joined-room", roomId)
                    emit(StreamFrame(Frame.Hello("foreign:50", false)))
                    emit(StreamFrame(Frame.Bot(bot.copy(id = "foreign-private")), 51))
                    emit(StreamFrame(Frame.Message("private-thread", Message("private", Message.Role.BOT, Message.Kind.TEXT, 1.0, text = "private")), 52))
                    emit(StreamFrame(Frame.Message("joined", Message("joined-message", Message.Role.BOT, Message.Kind.TEXT, 1.0, text = "joined")), 53))
                    awaitCancellation()
                } })
            try {
                session.awaitRestored(); session.connect()
                withTimeout(4_000) { while (session.state.value.transcript("joined").none { it.id == "joined-message" }) delay(10) }
                assertEquals("local:1", session.state.value.cursor)
                assertNull(session.state.value.bot("foreign-private"))
                assertTrue(session.state.value.transcript("private-thread").isEmpty())
                assertEquals("remote", session.state.value.rooms.single().home?.id)
            } finally { session.disconnect(); scope.cancel() }
        }
    }
}
