package com.openmausbot.companion.core

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The server's activity feed: what every bot is doing in every (bot, thread)
 * lane. The wire shape is provisional, so decoding is tolerant — only `botId`
 * and `threadId` are load-bearing — and the store must never let a stale
 * update or an overtaken snapshot rewind a lane.
 */
class ActivityFeedTest {

    // -- decoding an entry ---------------------------------------------------

    @Test
    fun `every known state decodes from its wire name`() {
        for (state in ActivityState.entries) {
            assertEquals(state, entry("""{"botId":"b","threadId":"t","state":"${state.wire}"}""").state, state.wire)
        }
        // the wire is read case- and whitespace-insensitively
        assertEquals(ActivityState.TOOL, entry("""{"botId":"b","threadId":"t","state":" TOOL "}""").state)
    }

    @Test
    fun `an unknown state is idle, not a failure`() {
        val decoded = entry("""{"botId":"b","threadId":"t","state":"juggling"}""")
        assertEquals(ActivityState.IDLE, decoded.state)
        assertEquals("b", decoded.botId)
    }

    @Test
    fun `a missing state is idle`() {
        assertEquals(ActivityState.IDLE, entry("""{"botId":"b","threadId":"t"}""").state)
    }

    @Test
    fun `a missing or null roomId is fine`() {
        assertNull(entry("""{"botId":"b","threadId":"t","state":"tool"}""").roomId)
        assertNull(entry("""{"botId":"b","threadId":"t","roomId":null}""").roomId)
        assertEquals("r", entry("""{"botId":"b","threadId":"t","roomId":"r"}""").roomId)
    }

    @Test
    fun `since reads as epoch millis, a number or a numeric string`() {
        assertEquals(1_791_280_800_000, since("1791280800000"))
        assertEquals(1_791_280_800_000, since("\"1791280800000\""))
    }

    @Test
    fun `since reads as an ISO-8601 instant, with or without an offset`() {
        assertEquals(1_791_280_800_000, since("\"2026-10-06T10:00:00Z\""))
        assertEquals(1_791_273_600_000, since("\"2026-10-06T10:00:00+02:00\""))
    }

    @Test
    fun `an unreadable or missing since is null`() {
        assertNull(since("\"last tuesday\""))
        assertNull(since("\"\""))
        assertNull(since("null"))
        assertNull(since("true"))
        assertNull(entry("""{"botId":"b","threadId":"t"}""").since)
    }

    @Test
    fun `an entry without a botId or threadId drops out of a snapshot alone`() {
        val decoded = ActivityFeed.decodeSnapshot(json(
            """
            [
              {"botId":"b1","threadId":"t1","state":"tool"},
              {"threadId":"t2","state":"typing"},
              {"botId":"b3","state":"typing"},
              {"botId":"","threadId":"t4"},
              "junk",
              {"botId":"b5","threadId":"t5","state":"waiting"}
            ]
            """,
        ))
        assertEquals(listOf("b1", "b5"), decoded.map(ActivityFeedEntry::botId))
    }

    @Test
    fun `a snapshot body decodes bare or wrapped`() {
        val lane = """{"botId":"b","threadId":"t","state":"thinking"}"""
        val expected = listOf(ActivityFeedEntry("b", "t", state = ActivityState.THINKING))
        assertEquals(expected, ActivityFeed.decodeSnapshot(json("[$lane]")))
        assertEquals(expected, ActivityFeed.decodeSnapshot(json("""{"items":[$lane]}""")))
        assertEquals(expected, ActivityFeed.decodeSnapshot(json("""{"entries":[$lane]}""")))
        assertEquals(expected, ActivityFeed.decodeSnapshot(json("""{"activity":[$lane]}""")))
        assertEquals(emptyList(), ActivityFeed.decodeSnapshot(json("""{"other":[$lane]}""")))
        assertEquals(emptyList(), ActivityFeed.decodeSnapshot(json("\"nope\"")))
    }

    // -- decoding the frame --------------------------------------------------

    @Test
    fun `an activity frame with a list is a whole snapshot`() {
        val frame = frame(
            """{"kind":"activity","items":[
                {"botId":"b1","threadId":"t1","state":"tool","since":5},
                {"botId":"b2","threadId":"t2","roomId":"r","state":"waiting"}
            ]}""",
        )
        assertIs<Frame.Activity>(frame)
        assertTrue(frame.replace)
        assertEquals(
            listOf(
                ActivityFeedEntry("b1", "t1", state = ActivityState.TOOL, since = 5),
                ActivityFeedEntry("b2", "t2", roomId = "r", state = ActivityState.WAITING),
            ),
            frame.entries,
        )
    }

    @Test
    fun `an activity frame with one entry is an update`() {
        val expected = Frame.Activity(
            listOf(ActivityFeedEntry("b1", "t1", state = ActivityState.TYPING, since = 7)),
            replace = false,
        )
        val lane = """{"botId":"b1","threadId":"t1","state":"typing","since":7}"""
        assertEquals(expected, frame("""{"kind":"activity","entry":$lane}"""))
        assertEquals(expected, frame("""{"kind":"activity","item":$lane}"""))
        assertEquals(
            expected,
            frame("""{"kind":"activity","botId":"b1","threadId":"t1","state":"typing","since":7}"""),
        )
    }

    @Test
    fun `an activity frame with nothing readable is unknown, never an empty snapshot`() {
        assertEquals(Frame.Unknown("activity"), frame("""{"kind":"activity"}"""))
        assertEquals(Frame.Unknown("activity"), frame("""{"kind":"activity","entry":{"state":"tool"}}"""))
        assertEquals(Frame.Unknown("activity"), frame("""{"kind":"activity","items":"soon"}"""))
        // lanes were sent and none of them read: a shape this build does not know
        assertEquals(Frame.Unknown("activity"), frame("""{"kind":"activity","items":[{"state":"tool"}]}"""))
    }

    @Test
    fun `an empty list is the server saying nothing is running`() {
        assertEquals(Frame.Activity(emptyList(), replace = true), frame("""{"kind":"activity","items":[]}"""))
    }

    @Test
    fun `an activity stream frame round-trips`() {
        val snapshot = StreamFrame(
            Frame.Activity(
                listOf(
                    ActivityFeedEntry("b1", "t1", roomId = "r", state = ActivityState.TOOL, since = 42),
                    ActivityFeedEntry("b2", "t2", state = ActivityState.FAILED),
                ),
                replace = true,
            ),
            seq = 9,
        )
        val update = StreamFrame(
            Frame.Activity(listOf(ActivityFeedEntry("b1", "t1", state = ActivityState.STOPPED, since = 43)), replace = false),
        )
        for (original in listOf(snapshot, update)) {
            val text = CompanionJson.encodeToString(original)
            assertEquals(original, CompanionJson.decodeFromString<StreamFrame>(text), text)
        }
    }

    // -- the store -----------------------------------------------------------

    @Test
    fun `an update older than the lane is ignored`() {
        val feed = ActivityFeed().applyUpdate(lane("b", "t", ActivityState.TOOL, since = 100))
        val stale = feed.applyUpdate(lane("b", "t", ActivityState.IDLE, since = 99))
        assertSame(feed, stale)
        assertEquals(ActivityState.TOOL, stale.stateFor("b", "t"))
    }

    @Test
    fun `a newer or equally timed update applies`() {
        val feed = ActivityFeed().applyUpdate(lane("b", "t", ActivityState.TOOL, since = 100))
        assertEquals(ActivityState.TYPING, feed.applyUpdate(lane("b", "t", ActivityState.TYPING, since = 101)).stateFor("b", "t"))
        assertEquals(ActivityState.WAITING, feed.applyUpdate(lane("b", "t", ActivityState.WAITING, since = 100)).stateFor("b", "t"))
    }

    @Test
    fun `an update without since always applies, and so does one onto a lane without since`() {
        val timed = ActivityFeed().applyUpdate(lane("b", "t", ActivityState.TOOL, since = 100))
        assertEquals(ActivityState.IDLE, timed.applyUpdate(lane("b", "t", ActivityState.IDLE)).stateFor("b", "t"))

        val untimed = ActivityFeed().applyUpdate(lane("b", "t", ActivityState.TOOL))
        assertEquals(ActivityState.FAILED, untimed.applyUpdate(lane("b", "t", ActivityState.FAILED, since = 1)).stateFor("b", "t"))
    }

    @Test
    fun `applyUpdates folds in order, still refusing stale ones`() {
        val feed = ActivityFeed().applyUpdates(
            listOf(
                lane("b", "t", ActivityState.THINKING, since = 10),
                lane("b", "t", ActivityState.TOOL, since = 20),
                lane("b", "t", ActivityState.TYPING, since = 15),
            ),
        )
        assertEquals(ActivityState.TOOL, feed.stateFor("b", "t"))
    }

    @Test
    fun `a snapshot drops the lanes it omits`() {
        val feed = ActivityFeed()
            .applyUpdate(lane("b1", "t1", ActivityState.TOOL))
            .applyUpdate(lane("b2", "t2", ActivityState.TYPING))
            .applySnapshot(listOf(lane("b1", "t1", ActivityState.THINKING)))
        assertEquals(ActivityState.THINKING, feed.stateFor("b1", "t1"))
        assertNull(feed.stateFor("b2", "t2"))
        assertEquals(1, feed.entries.size)
    }

    @Test
    fun `a snapshot keeps a lane the feed observed later than the snapshot did`() {
        // a push overtook the HTTP snapshot: the pushed lane must not rewind
        val feed = ActivityFeed()
            .applyUpdate(lane("b1", "t1", ActivityState.WAITING, since = 200))
            .applyUpdate(lane("b2", "t2", ActivityState.TOOL, since = 50))
            .applySnapshot(
                listOf(
                    lane("b1", "t1", ActivityState.TOOL, since = 150),
                    lane("b2", "t2", ActivityState.IDLE, since = 60),
                ),
            )
        assertEquals(ActivityState.WAITING, feed.stateFor("b1", "t1"))
        assertEquals(ActivityState.IDLE, feed.stateFor("b2", "t2"))
    }

    @Test
    fun `lanes are scoped to the bot and the thread`() {
        val feed = ActivityFeed()
            .applyUpdate(lane("b1", "t1", ActivityState.TOOL))
            .applyUpdate(lane("b1", "t2", ActivityState.WAITING))
        assertEquals(ActivityState.TOOL, feed.stateFor("b1", "t1"))
        assertEquals(ActivityState.WAITING, feed.stateFor("b1", "t2"))
        assertNull(feed.stateFor("b1", "t3"))
        assertNull(feed.stateFor("b2", "t1"))
        assertNull(feed.busiestForBot("b2"))
    }

    @Test
    fun `the busiest lane wins, in rank order`() {
        val ladder = listOf(
            ActivityState.WAITING,
            ActivityState.TOOL,
            ActivityState.TYPING,
            ActivityState.THINKING,
            ActivityState.FAILED,
            ActivityState.STOPPED,
            ActivityState.IDLE,
        )
        // drop the busiest one rung at a time; the next rung must take over
        for (top in ladder.indices) {
            val feed = ActivityFeed().applySnapshot(
                ladder.drop(top).mapIndexed { index, state -> lane("b", "t$index", state) }.shuffled(java.util.Random(top.toLong())),
            )
            assertEquals(ladder[top], feed.busiestForBot("b"), "rung $top")
        }
    }

    @Test
    fun `a bot's busiest leaves out room lanes unless asked`() {
        val feed = ActivityFeed()
            .applyUpdate(lane("b", "own", ActivityState.THINKING))
            .applyUpdate(lane("b", "room-thread", ActivityState.WAITING, roomId = "r"))
        assertEquals(ActivityState.THINKING, feed.busiestForBot("b"))
        assertEquals(ActivityState.WAITING, feed.busiestForBot("b", includeRooms = true))

        val roomOnly = ActivityFeed().applyUpdate(lane("b", "room-thread", ActivityState.TOOL, roomId = "r"))
        assertNull(roomOnly.busiestForBot("b"))
    }

    @Test
    fun `the busiest bot in a thread and in a room`() {
        val feed = ActivityFeed()
            .applyUpdate(lane("b1", "rt1", ActivityState.THINKING, roomId = "r"))
            .applyUpdate(lane("b2", "rt1", ActivityState.TOOL, roomId = "r"))
            .applyUpdate(lane("b3", "rt2", ActivityState.WAITING, roomId = "r"))
            .applyUpdate(lane("b1", "own", ActivityState.FAILED))
        assertEquals(ActivityState.TOOL, feed.busiestForThread("rt1"))
        assertEquals(ActivityState.WAITING, feed.busiestForThread("rt2"))
        assertEquals(ActivityState.WAITING, feed.busiestForRoom("r"))
        assertNull(feed.busiestForRoom("other"))
        assertNull(feed.busiestForThread("nowhere"))
    }

    @Test
    fun `an empty feed has no word on anything`() {
        val feed = ActivityFeed()
        assertTrue(feed.isEmpty)
        assertNull(feed.stateFor("b", "t"))
        assertNull(feed.busiestForBot("b", includeRooms = true))
        assertNull(feed.busiestForThread("t"))
        assertNull(feed.busiestForRoom("r"))
    }

    @Test
    fun `forgetting a bot drops only its lanes`() {
        val feed = ActivityFeed()
            .applyUpdate(lane("b1", "t1", ActivityState.TOOL))
            .applyUpdate(lane("b1", "t2", ActivityState.TYPING, roomId = "r"))
            .applyUpdate(lane("b2", "t1", ActivityState.WAITING))
        val forgotten = feed.forgetBot("b1")
        assertNull(forgotten.busiestForBot("b1", includeRooms = true))
        assertEquals(ActivityState.WAITING, forgotten.stateFor("b2", "t1"))
        assertSame(forgotten, forgotten.forgetBot("b1"))
    }

    @Test
    fun `the companion state applies activity frames, snapshot and update alike`() {
        val snapshot = CompanionState().apply(
            Frame.Activity(
                listOf(lane("b1", "t1", ActivityState.TOOL, since = 10), lane("b2", "t2", ActivityState.TYPING)),
                replace = true,
            ),
        )
        assertEquals(ActivityState.TOOL, snapshot.activity.stateFor("b1", "t1"))
        assertEquals(ActivityState.TYPING, snapshot.activity.stateFor("b2", "t2"))

        val updated = snapshot.apply(Frame.Activity(listOf(lane("b1", "t1", ActivityState.WAITING, since = 11)), replace = false))
        assertEquals(ActivityState.WAITING, updated.activity.stateFor("b1", "t1"))
        assertEquals(ActivityState.TYPING, updated.activity.stateFor("b2", "t2"), "an update keeps the other lanes")

        val stale = updated.apply(Frame.Activity(listOf(lane("b1", "t1", ActivityState.IDLE, since = 1)), replace = false))
        assertEquals(ActivityState.WAITING, stale.activity.stateFor("b1", "t1"))

        val replaced = updated.apply(Frame.Activity(listOf(lane("b2", "t2", ActivityState.IDLE)), replace = true))
        assertNull(replaced.activity.stateFor("b1", "t1"))
        assertEquals(ActivityState.IDLE, replaced.activity.stateFor("b2", "t2"))
    }

    @Test
    fun `a pushed activity frame decodes all the way into the state`() {
        val state = CompanionState().apply(
            CompanionJson.decodeFromString<StreamFrame>(
                """{"kind":"activity","seq":3,"entry":{"botId":"b","threadId":"t","state":"waiting"}}""",
            ),
        )
        assertEquals(ActivityState.WAITING, state.activity.stateFor("b", "t"))
    }

    @Test
    fun `deleting a bot forgets its lanes`() {
        val bot = Bot(
            id = "b1",
            threadId = "t1",
            name = "Scout",
            title = "",
            description = "",
            notifications = true,
            color = "green",
            unread = false,
            modelSelection = ModelSelection("instance-1", "model-1"),
            createdAt = 0.0,
        )
        val state = CompanionState(bots = listOf(bot))
            .apply(Frame.Activity(listOf(lane("b1", "t1", ActivityState.TOOL), lane("b2", "t2", ActivityState.TOOL)), replace = true))
            .apply(Frame.BotDeleted("b1"))
        assertNull(state.activity.stateFor("b1", "t1"))
        assertEquals(ActivityState.TOOL, state.activity.stateFor("b2", "t2"))
    }

    @Test
    fun `live and settled states are told apart`() {
        assertFalse(ActivityState.IDLE.isLive)
        assertFalse(ActivityState.FAILED.isLive)
        assertTrue(ActivityState.THINKING.isLive)
        assertTrue(ActivityState.WAITING.isLive)
        assertTrue(ActivityState.FAILED.isSettled)
        assertTrue(ActivityState.STOPPED.isSettled)
        assertFalse(ActivityState.TOOL.isSettled)
    }

    private fun json(text: String): JsonElement = CompanionJson.parseToJsonElement(text)

    private fun entry(text: String): ActivityFeedEntry =
        CompanionJson.decodeFromString(ActivityFeedEntrySerializer, text)

    private fun since(raw: String): Long? = entry("""{"botId":"b","threadId":"t","since":$raw}""").since

    private fun frame(text: String): Frame = CompanionJson.decodeFromString(FrameSerializer, text)

    private fun lane(
        botId: String,
        threadId: String,
        state: ActivityState,
        since: Long? = null,
        roomId: String? = null,
    ) = ActivityFeedEntry(botId = botId, threadId = threadId, roomId = roomId, state = state, since = since)
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data
