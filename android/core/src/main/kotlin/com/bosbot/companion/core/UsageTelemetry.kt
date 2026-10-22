package com.openmausbot.companion.core

import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject

@Serializable data class AnonymousUsagePolicy(val enabled: Boolean? = null, val disabledByEnv: Boolean? = null) {
    val allowsTelemetry: Boolean get() = enabled == true && disabledByEnv != true
}
enum class UsageTelemetryPolicy { ALLOWED, DENIED, UNAVAILABLE }
enum class UsageEvent(val wire: String) { INSTALL("install"), OPEN("open"), PAIR_SUCCESS("pair_success") }

/** Content-free, bounded best-effort queue. No Android or user-data dependency. */
class UsageTelemetry(
    private val version: String,
    load: () -> String?,
    private val save: (String) -> Unit,
    private val authorize: suspend () -> UsageTelemetryPolicy,
    private val post: suspend (String) -> Boolean,
    environment: Map<String, String> = System.getenv(),
) {
    @Serializable private data class Event(val name: String, val at: String, val props: JsonObject = buildJsonObject {})
    @Serializable private data class State(
        val installID: String = UUID.randomUUID().toString(),
        val installed: Boolean = false,
        val enabled: Boolean = true,
        val events: List<Event> = emptyList(),
    )
    @Serializable private data class Payload(val install_id: String, val version: String, val platform: String = "android", val events: List<Event>)
    private val lock = Any()
    // The wire contract requires platform and empty props even when defaulted.
    private val wireJson = Json(CompanionJson) { encodeDefaults = true }
    private val flushGate = Mutex()
    private val environmentAllowed = environmentAllows(environment)
    private var active = false
    private var queueRevision = 0L
    private var state = runCatching { load()?.let { CompanionJson.decodeFromString<State>(it) } }.getOrNull() ?: State()
    val enabled: Boolean get() = synchronized(lock) { state.enabled && environmentAllowed }
    init {
        state = state.copy(events = if (enabled) state.events.takeLast(200) else emptyList())
        persist()
    }
    fun setEnabled(enabled: Boolean) = synchronized(lock) {
        if (!enabled) queueRevision++
        state = state.copy(enabled = enabled, events = if (enabled) state.events else emptyList())
        persist()
    }
    fun foreground() = synchronized(lock) {
        if (active) return@synchronized
        active = true
        if (!state.installed) {
            state = state.copy(installed = true)
            record(UsageEvent.INSTALL)
        }
        record(UsageEvent.OPEN)
    }
    suspend fun background() {
        synchronized(lock) { active = false }
        flush()
    }
    fun record(event: UsageEvent) = synchronized(lock) {
        if (!enabled) return@synchronized
        if (state.events.size >= 200) queueRevision++
        state = state.copy(events = (state.events + Event(event.wire, Instant.now().toString())).takeLast(200))
        persist()
    }
    suspend fun flush() = flushGate.withLock {
        if (!enabled || synchronized(lock) { state.events.isEmpty() }) return@withLock
        val policy = try { authorize() } catch (_: Exception) { UsageTelemetryPolicy.UNAVAILABLE }
        if (policy == UsageTelemetryPolicy.DENIED) {
            synchronized(lock) { state = state.copy(events = emptyList()); queueRevision++; persist() }
            return@withLock
        }
        if (policy != UsageTelemetryPolicy.ALLOWED || !enabled) return@withLock
        val (batch, revision) = synchronized(lock) { state.events.take(50) to queueRevision }
        if (batch.isEmpty()) return@withLock
        val body = wireJson.encodeToString(Payload(state.installID, version, events = batch))
        val success = try { post(body) } catch (_: Exception) { false }
        if (success) synchronized(lock) {
            if (queueRevision == revision && state.events.take(batch.size) == batch) {
                state = state.copy(events = state.events.drop(batch.size))
                persist()
            }
        }
    }
    private fun persist() { runCatching { save(CompanionJson.encodeToString(state)) } }
    companion object {
        fun environmentAllows(environment: Map<String, String>): Boolean = environment["BOS_NO_PING"] != "1"
    }
}
