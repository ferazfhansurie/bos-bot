package com.openmausbot.companion.core

import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// ---------------------------------------------------------------------------
// ACTIVITY FEED WIRE CONTRACT — PROVISIONAL.
//
// The server half is still in progress (`api/1.9-activity-federation`, which
// serves `GET /api/activity` → `{ items: [...] }` and broadcasts
// `{ kind: "activity", items: [...] }` on `/api/events`). Every name the phone
// depends on lives in these two constants, so the final contract is a two-line
// change. A server without the route answers 404, the feed stays empty, and
// every face falls back to what it showed before the feed existed.
// ---------------------------------------------------------------------------

/** The snapshot route: every (bot, thread) lane this phone may see. */
const val ACTIVITY_FEED_SNAPSHOT_PATH: String = "/api/activity"

/** The `kind` of the frame that pushes the feed over the existing event stream. */
const val ACTIVITY_FEED_EVENT: String = "activity"

/**
 * What one bot is doing in one thread, as the server's activity feed says it.
 *
 * Ranked, low to high, by how busy it reads: a lane waiting on a person is the
 * busiest thing a bot can be doing, an idle one the least. The settled states
 * — [FAILED], [STOPPED] — sit above idle so a bot whose last turn broke still
 * says so, and below every live state so a running lane always wins.
 */
enum class ActivityState(val wire: String, val rank: Int) {
    IDLE("idle", 0),
    STOPPED("stopped", 1),
    FAILED("failed", 2),
    THINKING("thinking", 3),
    TYPING("typing", 4),
    TOOL("tool", 5),
    WAITING("waiting", 6),
    ;

    /** A turn is running (or parked on a person) in this lane. */
    val isLive: Boolean get() = rank >= THINKING.rank

    /** The turn ended without an answer; the face settles rather than loops. */
    val isSettled: Boolean get() = this == FAILED || this == STOPPED

    companion object {
        /** Anything this build does not know — a newer server's state, junk — is idle. */
        fun fromWire(value: String?): ActivityState {
            val key = value?.trim()?.lowercase() ?: return IDLE
            return entries.firstOrNull { it.wire == key } ?: IDLE
        }
    }
}

/**
 * One lane of the feed. [since] is epoch milliseconds, or null when the server
 * sent none this build could read — such an entry always applies, because there
 * is nothing to say it is stale.
 */
@Serializable(with = ActivityFeedEntrySerializer::class)
data class ActivityFeedEntry(
    val botId: String,
    val threadId: String,
    val roomId: String? = null,
    val state: ActivityState = ActivityState.IDLE,
    val since: Long? = null,
) {
    val key: ActivityFeed.Key get() = ActivityFeed.Key(botId, threadId)

    /** True when [other] is the same lane, observed strictly later. */
    internal fun isOlderThan(other: ActivityFeedEntry): Boolean {
        val mine = since ?: return false
        val theirs = other.since ?: return false
        return mine < theirs
    }
}

/**
 * Tolerant by design: the shape is provisional. `botId` and `threadId` are the
 * only fields an entry cannot do without; an unknown `state` is idle, a missing
 * `roomId` is null, and `since` may be epoch milliseconds (number or numeric
 * string) or an ISO-8601 instant.
 */
object ActivityFeedEntrySerializer : KSerializer<ActivityFeedEntry> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("ActivityFeedEntry")

    override fun deserialize(decoder: Decoder): ActivityFeedEntry {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("ActivityFeedEntry can only be decoded from JSON")
        val value = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("An activity entry must be an object")
        return ActivityFeedEntry(
            botId = value.string("botId")
                ?: throw SerializationException("An activity entry needs a botId"),
            threadId = value.string("threadId")
                ?: throw SerializationException("An activity entry needs a threadId"),
            roomId = value.string("roomId"),
            state = ActivityState.fromWire(value.string("state")),
            since = ActivitySince.parse(value["since"]),
        )
    }

    override fun serialize(encoder: Encoder, value: ActivityFeedEntry) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("ActivityFeedEntry can only be encoded as JSON")
        output.encodeJsonElement(buildJsonObject {
            put("botId", value.botId)
            put("threadId", value.threadId)
            put("roomId", value.roomId?.let(::JsonPrimitive) ?: JsonNull)
            put("state", value.state.wire)
            value.since?.let { put("since", it) }
        })
    }

    private fun JsonObject.string(name: String): String? =
        (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.takeIf { it.isNotEmpty() }
}

/** `since`, whichever way the server spelled it. */
internal object ActivitySince {
    fun parse(element: JsonElement?): Long? {
        val primitive = element as? JsonPrimitive ?: return null
        if (primitive is JsonNull) return null
        if (!primitive.isString) {
            return primitive.longOrNull ?: primitive.doubleOrNull?.takeIf { it.isFinite() }?.toLong()
        }
        val text = primitive.content.trim()
        if (text.isEmpty()) return null
        text.toLongOrNull()?.let { return it }
        text.toDoubleOrNull()?.takeIf { it.isFinite() }?.let { return it.toLong() }
        return try {
            Instant.parse(text).toEpochMilli()
        } catch (_: DateTimeParseException) {
            try {
                OffsetDateTime.parse(text).toInstant().toEpochMilli()
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}

/**
 * The server's activity feed, keyed by (bot, thread): what every bot is doing in
 * every lane, including the ones the phone is not looking at. Immutable, like
 * [CompanionState], which carries it.
 *
 * Empty means "no feed" — an older server, or nothing fetched yet — and every
 * lookup answers null, so a caller falls back to what it did before.
 */
data class ActivityFeed(val entries: Map<Key, ActivityFeedEntry> = emptyMap()) {
    data class Key(val botId: String, val threadId: String)

    val isEmpty: Boolean get() = entries.isEmpty()

    /**
     * Replace the feed with [snapshot]: lanes it omits are gone. A lane this
     * feed already saw *later* than the snapshot did keeps the later entry — a
     * snapshot fetched over HTTP can land after a push that overtook it.
     */
    fun applySnapshot(snapshot: List<ActivityFeedEntry>): ActivityFeed {
        val next = LinkedHashMap<Key, ActivityFeedEntry>(snapshot.size)
        snapshot.forEach { incoming ->
            val held = next[incoming.key] ?: entries[incoming.key]
            next[incoming.key] = if (held != null && incoming.isOlderThan(held)) held else incoming
        }
        return ActivityFeed(next)
    }

    /** One lane moved. An update older than what this lane already shows is ignored. */
    fun applyUpdate(update: ActivityFeedEntry): ActivityFeed {
        val held = entries[update.key]
        if (held != null && update.isOlderThan(held)) return this
        if (held == update) return this
        return ActivityFeed(entries + (update.key to update))
    }

    fun applyUpdates(updates: List<ActivityFeedEntry>): ActivityFeed =
        updates.fold(this) { feed, update -> feed.applyUpdate(update) }

    /** Forget a deleted bot's lanes rather than wait for the next snapshot. */
    fun forgetBot(botId: String): ActivityFeed =
        if (entries.keys.none { it.botId == botId }) this
        else ActivityFeed(entries.filterKeys { it.botId != botId })

    fun entry(botId: String, threadId: String): ActivityFeedEntry? = entries[Key(botId, threadId)]

    /** Exactly this bot in exactly this thread, or null when the feed has no word on it. */
    fun stateFor(botId: String, threadId: String): ActivityState? = entry(botId, threadId)?.state

    /**
     * The busiest thing [botId] is doing anywhere. Room lanes count only when
     * [includeRooms] is set: a room row already shows its own members' work.
     */
    fun busiestForBot(botId: String, includeRooms: Boolean = false): ActivityState? =
        busiest(entries.values.filter { it.botId == botId && (includeRooms || it.roomId == null) })

    /** The busiest bot in [threadId] — a room's thread has several. */
    fun busiestForThread(threadId: String): ActivityState? =
        busiest(entries.values.filter { it.threadId == threadId })

    /** The busiest bot in any of [roomId]'s threads. */
    fun busiestForRoom(roomId: String): ActivityState? =
        busiest(entries.values.filter { it.roomId == roomId })

    companion object {
        /** The busiest of [states]; null when there are none. */
        fun busiest(entries: Collection<ActivityFeedEntry>): ActivityState? =
            entries.maxByOrNull { it.state.rank }?.state

        /**
         * A snapshot body, however it is wrapped: a bare array, or an object
         * holding one under `items` (the server in progress), `entries` or
         * `activity`. Entries that do not decode drop out one by one.
         */
        fun decodeSnapshot(element: JsonElement): List<ActivityFeedEntry> {
            val list = when (element) {
                is JsonArray -> element
                is JsonObject -> SNAPSHOT_KEYS.firstNotNullOfOrNull { element[it] as? JsonArray }
                else -> null
            } ?: return emptyList()
            return decodeEntries(list)
        }

        fun decodeEntries(list: JsonArray): List<ActivityFeedEntry> = list.mapNotNull { item ->
            runCatching { CompanionJson.decodeFromJsonElement(ActivityFeedEntrySerializer, item) }.getOrNull()
        }

        internal val SNAPSHOT_KEYS = listOf("items", "entries", "activity")
    }
}
