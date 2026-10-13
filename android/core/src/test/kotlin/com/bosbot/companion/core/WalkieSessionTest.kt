package com.openmausbot.companion.core

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.flow
import okhttp3.mockwebserver.*
import kotlin.test.*

class WalkieSessionTest {
    @Test fun archivePublishesBeforeHttpAndRollsBackFailedUndoWithoutStreamRestart() = runBlocking<Unit> {
        MockWebServer().use { server ->
            val patches = AtomicInteger()
            val streams = AtomicInteger()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.method == "PATCH") return MockResponse().setResponseCode(if (patches.incrementAndGet() == 1) 200 else 500)
                        .setBody("{}").setBodyDelay(200, java.util.concurrent.TimeUnit.MILLISECONDS)
                    return MockResponse().setResponseCode(404).setBody("{}")
                }
            }
            server.start()
            val connection = requireNotNull(Connection.parse(server.url("/").toString()))
            val task = BotTask("task", "task", 1.0)
            val bot = decodeFixture<Fleet>("bots-paged").bots.first().copy(threadId = task.threadId, tasks = listOf(task))
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
                streams.incrementAndGet(); emit(StreamFrame(Frame.Hello("epoch:1", false))); awaitCancellation()
            } }, hydrateFn = { _, _ -> Fleet(listOf(bot), emptyList()) }, instancesFn = { emptyList() }, metadataFn = { throw APIError.Status(404) })
            try {
                session.awaitRestored(); session.connect()
                withTimeout(3_000) { while (session.state.value.bot(bot.id) == null) delay(10) }
                val archive = async { session.archiveTask(task, bot, 123.0) }
                withTimeout(3_000) { while (session.state.value.bot(bot.id)!!.tasks!!.single().archivedAt != 123.0) delay(10) }
                assertFalse(archive.isCompleted)
                assertTrue(archive.await())
                assertEquals(1, streams.get())
                val undo = async { session.archiveTask(task, bot, null) }
                withTimeout(3_000) { while (session.state.value.bot(bot.id)!!.tasks!!.single().archivedAt != null) delay(10) }
                assertFalse(undo.await())
                assertEquals(123.0, session.state.value.bot(bot.id)!!.tasks!!.single().archivedAt)
                assertEquals(1, streams.get())
            } finally { session.disconnect(); scope.cancel() }
        }
    }
}
