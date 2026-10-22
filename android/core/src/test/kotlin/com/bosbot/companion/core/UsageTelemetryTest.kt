package com.openmausbot.companion.core

import kotlin.test.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*

class UsageTelemetryTest {
    @Test fun lifecyclePayloadAndDurableIdentity() = runTest {
        var stored: String? = null
        val bodies = mutableListOf<String>()
        fun make() = UsageTelemetry("2.1.3", { stored }, { stored = it }, { UsageTelemetryPolicy.ALLOWED }, { bodies += it; true })
        val telemetry = make()
        telemetry.foreground(); telemetry.foreground(); telemetry.flush()
        val body = Json.parseToJsonElement(bodies[0]).jsonObject
        assertEquals(setOf("install_id", "version", "platform", "events"), body.keys)
        assertEquals("android", body["platform"]!!.jsonPrimitive.content)
        val events = body["events"]!!.jsonArray
        assertEquals(listOf("install", "open"), events.map { it.jsonObject["name"]!!.jsonPrimitive.content })
        events.forEach { assertEquals(buildJsonObject {}, it.jsonObject["props"]); java.time.Instant.parse(it.jsonObject["at"]!!.jsonPrimitive.content) }
        make().also { it.foreground(); it.flush() }
        val second = Json.parseToJsonElement(bodies[1]).jsonObject
        assertEquals(body["install_id"], second["install_id"])
        assertEquals(1, second["events"]!!.jsonArray.size)
    }
    @Test fun optOutAndUnavailableNeverPost() = runTest {
        var posts = 0
        var policy = UsageTelemetryPolicy.UNAVAILABLE
        val telemetry = UsageTelemetry("test", { null }, {}, { policy }, { posts++; true })
        telemetry.foreground(); telemetry.flush(); assertEquals(0, posts)
        policy = UsageTelemetryPolicy.DENIED; telemetry.flush()
        policy = UsageTelemetryPolicy.ALLOWED; telemetry.flush(); assertEquals(0, posts)
        telemetry.setEnabled(false); telemetry.record(UsageEvent.PAIR_SUCCESS); telemetry.flush(); assertEquals(0, posts)
    }
    @Test fun boundedOfflineQueueAndFiftyEventBatches() = runTest {
        var succeed = false
        val counts = mutableListOf<Int>()
        val telemetry = UsageTelemetry("test", { null }, {}, { UsageTelemetryPolicy.ALLOWED }, { counts += Json.parseToJsonElement(it).jsonObject["events"]!!.jsonArray.size; succeed })
        repeat(300) { telemetry.record(UsageEvent.PAIR_SUCCESS) }
        telemetry.flush(); assertEquals(listOf(50), counts)
        succeed = true
        repeat(5) { telemetry.flush() }
        assertEquals(listOf(50,50,50,50,50), counts)
    }
    @Test fun environmentAndPolicyFailClosed() {
        listOf("{}", "{\"enabled\":false}", "{\"enabled\":true,\"disabledByEnv\":true}").forEach {
            assertFalse(CompanionJson.decodeFromString<AnonymousUsagePolicy>(it).allowsTelemetry)
        }
        assertTrue(CompanionJson.decodeFromString<AnonymousUsagePolicy>("{\"enabled\":true,\"disabledByEnv\":false}").allowsTelemetry)
        assertFalse(UsageTelemetry.environmentAllows(mapOf("BOS_NO_PING" to "1")))
    }
    @Test fun backgroundFlushAndNextForegroundOpen() = runTest {
        val names = mutableListOf<List<String>>()
        val telemetry = UsageTelemetry("test", { null }, {}, { UsageTelemetryPolicy.ALLOWED }, {
            names += Json.parseToJsonElement(it).jsonObject["events"]!!.jsonArray.map { event -> event.jsonObject["name"]!!.jsonPrimitive.content }
            true
        })
        telemetry.foreground(); telemetry.background()
        telemetry.foreground(); telemetry.background()
        assertEquals(listOf(listOf("install", "open"), listOf("open")), names)
    }
    @Test fun disabledEnvironmentNeverAuthorizesOrPosts() = runTest {
        var attempts = 0
        val telemetry = UsageTelemetry("test", { null }, {}, { attempts++; UsageTelemetryPolicy.ALLOWED }, { attempts++; true }, mapOf("BOS_NO_PING" to "1"))
        telemetry.foreground(); telemetry.setEnabled(true); telemetry.record(UsageEvent.PAIR_SUCCESS); telemetry.background()
        assertEquals(0, attempts)
    }
    @Test fun queueOverflowDuringSendKeepsNewEvents() = runTest {
        var sends = 0
        lateinit var telemetry: UsageTelemetry
        telemetry = UsageTelemetry("test", { null }, {}, { UsageTelemetryPolicy.ALLOWED }, {
            sends++
            if (sends == 1) repeat(300) { telemetry.record(UsageEvent.PAIR_SUCCESS) }
            true
        })
        telemetry.record(UsageEvent.PAIR_SUCCESS)
        repeat(6) { telemetry.flush() }
        assertEquals(5, sends)
    }
}
