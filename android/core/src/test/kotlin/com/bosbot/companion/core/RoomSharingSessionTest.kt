package com.openmausbot.companion.core
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import kotlin.test.*
class RoomSharingSessionTest {
    @Test fun clientOnlyAndRemoteRoomsRefuseSettingsBeforeAnyMutation() = runBlocking<Unit> {
        MockWebServer().use { server ->
            val writes = AtomicInteger()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.method != "GET") writes.incrementAndGet()
                    return if (request.requestUrl?.encodedPath == "/.well-known/openmausbot/environment") MockResponse().setBody("""{"environmentId":"env","label":"fixture"}""") else MockResponse().setResponseCode(404).setBody("{}")
                }
            }
            server.start()
            val base = requireNotNull(Connection.parse(server.url("/").toString()))
            val room = decodeFixture<Fleet>("bots-paged").groups.first().copy(id = "room", home = RoomHome("remote", "remote"))
            suspend fun check(connection: Connection, sharedRoom: Room) {
                val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                val session = Session(scope, object : ConnectionStore {
                    override suspend fun load() = connection
                    override suspend fun save(connection: Connection) = Unit
                    override suspend fun clear() = Unit
                }, object : TokenStore {
                    override suspend fun read(connectionId: String) = TokenStore.ReadResult.Found("fixture-token")
                    override suspend fun save(connectionId: String, token: String) = Unit
                    override suspend fun remove(connectionId: String) = Unit
                }, InMemoryOnboardingStore(), { "fixture" }, eventsFn = { _, _, _ -> flow { emit(StreamFrame(Frame.Hello("epoch:1", false))); awaitCancellation() } },
                    hydrateFn = { _, _ -> Fleet(emptyList(), listOf(sharedRoom)) }, instancesFn = { emptyList() }, metadataFn = { throw APIError.Status(404) })
                try {
                    session.awaitRestored(); session.connect()
                    withTimeout(3_000) { while (session.state.value.rooms.isEmpty()) delay(10) }
                    val denied = assertFailsWith<APIError.Status> { session.updateRoomSettings("room", buildJsonObject { put("name", "new") }, connection.id) }
                    assertEquals(403, denied.code)
                    assertFailsWith<APIError.Transport> { session.updateRoomSettings("room", buildJsonObject { put("name", "new") }, "wrong-source") }
                    assertEquals(0, writes.get())
                } finally { session.disconnect(); scope.cancel() }
            }
            check(base, room)
            check(base.copy(serverEnvironmentId = "env", serverScopes = listOf("client")), room.copy(home = null))
        }
    }
}
