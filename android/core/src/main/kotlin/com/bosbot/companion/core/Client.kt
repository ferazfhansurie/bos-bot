package com.openmausbot.companion.core

import java.io.File
import java.io.IOException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URI
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dns
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Response

internal data class ConnectionEndpoint(val baseUrl: HttpUrl, val dns: Dns)

/** The durable pairing result together with the route that actually redeemed it. */
data class PairingOutcome(
    val response: PairResponse,
    val connection: Connection,
    val serverPair: ServerPairResponse? = null,
)

/** No automatically permitted route identified itself and completed the logical pairing. */
class PairingRouteError(val attemptedRoutes: List<String>) : IOException(
    "Couldn't reach this computer through any available route " +
        "(${attemptedRoutes.joinToString()}). Keep Phone access turned on in BOS Bot, then try again.",
)

internal const val SCOPED_IPV6_HTTP_HOST = "scoped-ipv6.openmausbot.invalid"

/**
 * OkHttp deliberately rejects RFC 6874 zone identifiers in HttpUrl hosts.
 * A bare IPv6 literal makes OkHttp bypass Dns entirely, so a zoned address
 * uses a private synthetic hostname in HttpUrl. ScopedIpv6Dns maps that name
 * straight to the scoped Inet6Address OkHttp passes to Socket.connect.
 */
internal fun Connection.httpEndpoint(fallbackDns: Dns): ConnectionEndpoint? {
    val dialingEndpoint = activeEndpoint
        ?: CompanionEndpoint.direct(host, port, priority = 0)
        ?: return null
    if (!allowsEndpoint(dialingEndpoint)) return null
    return runCatching {
        val dialingHost = dialingEndpoint.host
        val dialingPort = dialingEndpoint.port
        val dialingScheme = if (dialingEndpoint.isSecure) "https" else "http"
        val bareHost = if (dialingHost.startsWith('[') && dialingHost.endsWith(']')) {
            dialingHost.substring(1, dialingHost.length - 1)
        } else {
            dialingHost
        }
        val zoneAt = if (':' in bareHost) bareHost.indexOf('%') else -1
        require(zoneAt < 0 || zoneAt < bareHost.lastIndex) { "IPv6 zone identifier is empty" }
        val addressHost = if (zoneAt >= 0) bareHost.substring(0, zoneAt) else bareHost
        val httpHost = if (zoneAt >= 0) SCOPED_IPV6_HTTP_HOST else addressHost
        val zone = if (zoneAt >= 0) bareHost.substring(zoneAt + 1) else null
        val url = HttpUrl.Builder()
            .scheme(dialingScheme)
            .host(httpHost)
            .port(dialingPort)
            .build()
        val dns = if (zone == null) {
            fallbackDns
        } else {
            ScopedIpv6Dns(url.host, addressHost, zone, fallbackDns)
        }
        ConnectionEndpoint(url, dns)
    }.getOrNull()
}

internal class ScopedIpv6Dns(
    private val targetHost: String,
    private val addressHost: String,
    private val zone: String,
    private val fallback: Dns,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        if (!hostname.equals(targetHost, ignoreCase = true)) return fallback.lookup(hostname)
        val unscoped = InetAddress.getByName(addressHost) as? Inet6Address
            ?: throw UnknownHostException("$addressHost is not an IPv6 address")
        val scoped = zone.toIntOrNull()?.let { scopeId ->
            if (scopeId <= 0) throw UnknownHostException("Invalid IPv6 scope id: $zone")
            Inet6Address.getByAddress(addressHost, unscoped.address, scopeId)
        } ?: run {
            val networkInterface = NetworkInterface.getByName(zone)
                ?: throw UnknownHostException("No network interface named $zone")
            Inet6Address.getByAddress(addressHost, unscoped.address, networkInterface)
        }
        return listOf(scoped)
    }
}

class CompanionClient(
    val connection: Connection,
    private val token: String?,
    baseClient: OkHttpClient = OkHttpClient(),
) {
    private val endpoint = connection.httpEndpoint(baseClient.dns)

    private val actionClient = baseClient.newBuilder()
        .dns(endpoint?.dns ?: baseClient.dns)
        .callTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    /**
     * Share uploads can be tens of MB. A wall-clock [callTimeout] would abort a
     * steady transfer; iOS uses an idle `timeoutInterval` that resets on bytes.
     * Connect/read/write idle limits, no overall call deadline.
     */
    private val uploadClient = baseClient.newBuilder()
        .dns(endpoint?.dns ?: baseClient.dns)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    private val streamingClient = baseClient.newBuilder()
        .dns(endpoint?.dns ?: baseClient.dns)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(STREAM_IDLE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(ACTION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    private val avatarGenerationClient = baseClient.newBuilder()
        .dns(endpoint?.dns ?: baseClient.dns)
        .callTimeout(AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .connectTimeout(AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(AVATAR_GENERATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    suspend fun health(): JsonObject = send(makeRequest("GET", "/api/health"))

    /** Wire support for P1-03; applying the snapshot to a live session is deliberately later. */
    suspend fun connectionMetadata(): CompanionConnectionMetadata =
        send(makeRequest("GET", "/api/companion/endpoints"))

    suspend fun fleet(messages: Int? = 50): Fleet = send(makeRequest(
        method = "GET",
        path = "/api/bots",
        query = messages?.let { listOf("messages" to it.toString()) }.orEmpty(),
    ))

    /**
     * ACTIVITY FEED SEAM (snapshot half): every lane's state, from
     * [ACTIVITY_FEED_SNAPSHOT_PATH]. A server without the route answers 404,
     * which is an empty feed rather than an error — the phone then shows what it
     * always did. Any other failure throws; the caller keeps the feed it has.
     */
    suspend fun activityFeed(): List<ActivityFeedEntry> = try {
        ActivityFeed.decodeSnapshot(send<JsonElement>(makeRequest("GET", ACTIVITY_FEED_SNAPSHOT_PATH)))
    } catch (error: APIError.Status) {
        if (error.code == 404) emptyList() else throw error
    }

    suspend fun messages(threadId: String, before: String? = null, limit: Int = 50): ThreadPage {
        val query = buildList {
            add("limit" to limit.toString())
            before?.let { add("before" to it) }
        }
        return send(makeRequest("GET", "/api/threads/${segment(threadId)}/messages", query))
    }

    suspend fun messagesAround(threadId: String, messageId: String, limit: Int = 50): ThreadPage = send(
        makeRequest(
            "GET",
            "/api/threads/${segment(threadId)}/messages",
            listOf("limit" to limit.toString(), "around" to messageId),
        ),
    )

    suspend fun search(query: String, limit: Int = 40): List<SearchHit> = send<SearchResponse>(
        makeRequest("GET", "/api/search", listOf("q" to query, "limit" to limit.toString())),
    ).hits

    suspend fun export(threadId: String, format: String): TranscriptExport {
        val raw = perform(makeRequest(
            "GET",
            "/api/threads/${segment(threadId)}/export",
            listOf("format" to format),
        ))
        check(raw)
        val fallback = "transcript.${if (format == "json") "json" else "md"}"
        val filename = raw.headers["Content-Disposition"]
            .orEmpty()
            .split(';')
            .map(String::trim)
            .firstOrNull { it.startsWith("filename=", ignoreCase = true) }
            ?.drop("filename=".length)
            ?.trim('"')
            ?: fallback
        return TranscriptExport(
            data = raw.data,
            filename = filename,
            contentType = raw.headers["Content-Type"] ?: "application/octet-stream",
        )
    }

    suspend fun instances(): List<Instance> = send<InstanceList>(
        makeRequest("GET", "/api/instances"),
    ).instances

    /** Missing capability data fails closed: image prompts must be readable by the selected model. */
    suspend fun imageCapableInstanceIds(): Set<String> = instances()
        .filter { it.capabilities?.images == true }
        .mapTo(mutableSetOf(), Instance::instanceId)

    suspend fun ackRing(ringId: String) = sendUnit(makeRequest("POST", "/api/voice/ring/${safeRouteId(ringId)}/ack", body = buildJsonObject {}))

    suspend fun sharedMe(): SharedMe {
        val me = send<SharedMe>(makeRequest("GET", "/api/multiplayer/me"))
        if (me.avatar != null) return me
        val config = try { send<JsonObject>(makeRequest("GET", "/api/config")) }
            catch (error: APIError.Status) { if (error.code in setOf(403, 404)) return me else throw error }
        val profile = config["profile"] as? JsonObject
        val avatar = (profile?.get("avatarUrl") as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.takeIf { it.isNotEmpty() }
        return me.copy(avatar = avatar)
    }
    /** Replace the server owner's photo, naming the one it replaces: the
     * server refuses a write without it, so no device can silently swap a
     * linked owner's photo for its own. */
    suspend fun setProfilePhoto(jpegBase64: String?) {
        val profile = send<JsonObject>(makeRequest("GET", "/api/config"))["profile"] as? JsonObject
        val expected = (profile?.get("avatarUrl") as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content.orEmpty()
        sendUnit(makeRequest("PUT", "/api/multiplayer/profile-photo", body = buildJsonObject {
            put("photo", jpegBase64?.let(::JsonPrimitive) ?: JsonNull)
            put("expected", JsonPrimitive(expected))
        }))
    }

    suspend fun voiceCall(botId: String, language: String?, callId: String? = null): JsonObject {
        if (!isSafeRouteId(botId)) throw APIError.BadUrl
        return send(makeRequest("POST", "/api/voice/call", body = buildJsonObject {
            put("botId", botId)
            language?.takeIf { it.isNotEmpty() }?.let { put("language", it) }
            callId?.let { put("callId", it) }
        }))
    }

    suspend fun reportVoiceCallUsage(callId: String, seconds: Int) {
        sendUnit(makeRequest("POST", "/api/voice/call/usage", body = buildJsonObject {
            put("callId", callId); put("seconds", maxOf(0, seconds))
        }))
    }

    suspend fun sendVoiceTask(botId: String, threadId: String, request: String, callId: String,
        sendId: String, job: String = request): SendReceipt {
        if (!isSafeRouteId(threadId) || !isSafeSendId(sendId)) throw APIError.BadUrl
        return sendForReceipt(makeRequest("POST", "/api/bots/${safeRouteId(botId)}/messages", body = buildJsonObject {
            put("text", request); put("threadId", threadId); put("sendId", sendId)
            put("origin", buildJsonObject {
                put("kind", "voice_call"); put("callId", callId)
                job.trim().takeIf { it.isNotEmpty() }?.let { put("job", it.take(2000)) }
            })
        }))
    }

    suspend fun logout() = sendUnit(makeRequest("POST", "/api/auth/logout"))

    suspend fun environment(): ServerEnvironment = send(makeRequest("GET", "/.well-known/openmausbot/environment"))

    suspend fun providerUsage(): ProviderUsageResponse = send(makeRequest("GET", "/api/provider-usage"))
    suspend fun updateStatus(): UpdateStatusResponse = send(makeRequest("GET", "/api/update/status"))
    suspend fun setThreadSettlement(days: Int): ConfigStatus {
        if (days !in 0..3650) throw APIError.BadUrl
        val current = config()
        return send(makeRequest("PATCH", "/api/config", body = buildJsonObject {
            put("threads", buildJsonObject {
                put("maxConcurrentPerBot", current.threads?.maxConcurrentPerBot ?: 3)
                put("autoSettleDays", days)
            })
        }))
    }

    suspend fun saveChatterboxServer(baseURL: String, model: String): ConfigStatus = send(makeRequest(
        "PATCH", "/api/config", body = buildJsonObject { put("tts", buildJsonObject {
            put("baseUrl", baseURL); put("model", model)
        }) }))

    suspend fun config(): ConfigStatus = send(makeRequest("GET", "/api/config"))

    /**
     * The engine is a setting, not a secret, so it rides the ordinary config
     * write — the same one `VoiceSettings.tsx` sends from its Voice engine
     * group. Only the provider field is written; keys and server addresses
     * stay on the computer.
     */
    suspend fun updateVoiceProvider(provider: VoiceProvider): ConfigStatus = send(
        makeRequest(
            "PUT",
            "/api/config",
            body = buildJsonObject {
                put("tts", buildJsonObject { put("provider", provider.wire) })
            },
        ),
    )

    suspend fun connectorCatalog(): ConnectorCatalog =
        send(makeRequest("GET", "/api/connectors/catalog"))

    suspend fun allConnectorStatuses(): ConnectorStatuses =
        send(makeRequest("GET", "/api/connectors/connected"))

    suspend fun image(threadId: String, messageId: String): ByteArray {
        val raw = perform(makeRequest("GET", "/api/threads/${segment(threadId)}/messages/${segment(messageId)}/image"))
        check(raw)
        return raw.data
    }

    /**
     * Fetch an app-owned file mentioned by one transcript message. The path
     * still names the file on the paired computer, so it is sent in an
     * authenticated JSON body rather than placed in the URL. The server
     * verifies both message provenance and its attachment roots.
     */
    suspend fun downloadFile(threadId: String, messageId: String, path: String): DownloadedFile {
        val link = LocalMessageLink.resolve(path) as? LocalMessageLink.DesktopFile ?: throw APIError.BadUrl
        val raw = perform(
            makeRequest(
                "POST",
                "/api/threads/${safeRouteId(threadId)}/messages/${safeRouteId(messageId)}/file",
                body = jsonBody("path" to link.path),
            ),
        )
        check(raw)
        val declared = raw.headers["Content-Length"]?.trim()?.toLongOrNull() ?: -1L
        if (declared > MAXIMUM_FILE_DOWNLOAD_BYTES || raw.data.size > MAXIMUM_FILE_DOWNLOAD_BYTES) {
            throw APIError.Transport("That file is larger than 25 MB.")
        }
        val rawContentType = raw.headers["Content-Type"].orEmpty()
        val contentType = if (AttachmentPolicy.validMime(rawContentType)) {
            AttachmentPolicy.normalizedMime(rawContentType)
        } else {
            "application/octet-stream"
        }
        return DownloadedFile(
            data = raw.data,
            filename = downloadFilename(raw.headers["Content-Disposition"], link.path),
            contentType = contentType,
        )
    }

    suspend fun avatar(path: String): ByteArray {
        if (!validAvatarPath(path)) throw APIError.BadUrl
        val raw = perform(makeRequest("GET", path))
        check(raw)
        return raw.data
    }

    suspend fun voices(): List<Voice> = send<VoiceListResponse>(
        makeRequest("GET", "/api/tts/voices"),
    ).voices

    suspend fun routines(): RoutinesResponse = send(makeRequest("GET", "/api/routines"))

    suspend fun overview(botId: String): BotOverview =
        send(makeRequest("GET", "/api/bots/${segment(botId)}/overview"))

    suspend fun sharedContacts(): List<SharedContact> = send<SharedContactsResponse>(makeRequest("GET", "/api/multiplayer/contacts")).contacts
    suspend fun sharedRooms(): List<SharedRoomSummary> = send<SharedRoomsResponse>(makeRequest("GET", "/api/multiplayer/rooms")).rooms
    suspend fun openSharedDM(targetId: String): SharedRoomSummary = send<SharedRoomResponse>(makeRequest("POST", "/api/multiplayer/dm", body = jsonBody("targetId" to targetId))).room
    suspend fun createSharedRoom(name: String, memberIds: List<String>): SharedRoomSummary = send<SharedRoomResponse>(makeRequest("POST", "/api/multiplayer/rooms", body = buildJsonObject {
        put("name", name); put("memberIds", CompanionJson.encodeToJsonElement(memberIds))
    })).room
    suspend fun sharedBots(roomId: String): List<SharedEligibleBot> = send<SharedEligibleBotsResponse>(makeRequest("GET", "/api/multiplayer/rooms/${safeRouteId(roomId)}/bots")).bots
    suspend fun updateSharedRoom(id: String, revision: Int, name: String? = null, memberIds: List<String>? = null): SharedRoomSummary {
        if (revision < 0) throw APIError.BadUrl
        return send<SharedRoomResponse>(makeRequest("PATCH", "/api/multiplayer/rooms/${safeRouteId(id)}", body = buildJsonObject {
            put("revision", revision); name?.let { put("name", it) }; memberIds?.let { put("memberIds", CompanionJson.encodeToJsonElement(it)) }
        })).room
    }
    suspend fun leaveSharedRoom(id: String, revision: Int) = sendUnit(makeRequest("POST", "/api/multiplayer/rooms/${safeRouteId(id)}/leave", body = buildJsonObject { put("revision", revision) }))
    suspend fun deleteSharedRoom(id: String, revision: Int) = sendUnit(makeRequest("DELETE", "/api/multiplayer/rooms/${safeRouteId(id)}", body = buildJsonObject { put("revision", revision) }))
    suspend fun removeRemoteBot(id: String) = sendUnit(makeRequest("DELETE", "/api/bots/${safeRouteId(id)}"))
    suspend fun sharedMessagePage(roomId: String, after: Int = 0, version: Int = 0, before: Int? = null, latest: Boolean = false): SharedMessagesResponse {
        if (after < 0 || version < 0 || (before != null && before < 1)) throw APIError.BadUrl
        return send(makeRequest("GET", "/api/multiplayer/rooms/${safeRouteId(roomId)}/messages", query = buildList {
            add("after" to after.toString()); add("version" to version.toString()); add("limit" to "200")
            before?.let { add("before" to it.toString()) }; if (latest) add("latest" to "1")
        }))
    }
    suspend fun sharedMessages(roomId: String, after: Int): List<SharedChatMessage> = sharedMessagePage(roomId, after).messages
    suspend fun sendSharedMessage(roomId: String, text: String, sendId: String, attachments: List<SharedAttachment> = emptyList(), replyTo: String? = null) {
        if (!isSafeSendId(sendId) || (replyTo != null && !isSafeRouteId(replyTo))) throw APIError.BadUrl
        SharedAttachmentPolicy.validate(attachments)
        sendUnit(makeRequest("POST", "/api/multiplayer/rooms/${safeRouteId(roomId)}/messages", body = buildJsonObject {
            put("text", text); put("sendId", sendId); put("attachments", CompanionJson.encodeToJsonElement(attachments)); replyTo?.let { put("replyTo", it) }
        }))
    }
    suspend fun editSharedMessage(roomId: String, messageId: String, text: String?): SharedChatMessage = send<SharedMessageResponse>(makeRequest(
        if (text == null) "DELETE" else "PATCH", "/api/multiplayer/rooms/${safeRouteId(roomId)}/messages/${safeRouteId(messageId)}",
        body = text?.let { jsonBody("text" to it) })).message
    suspend fun annotateSharedMessage(roomId: String, messageId: String, reaction: String? = null, active: Boolean? = null, pinned: Boolean? = null): SharedChatMessage = send<SharedMessageResponse>(makeRequest(
        "PATCH", "/api/multiplayer/rooms/${safeRouteId(roomId)}/messages/${safeRouteId(messageId)}", body = buildJsonObject {
            reaction?.let { put("reaction", it) }; active?.let { put("active", it) }; pinned?.let { put("pinned", it) }
        })).message
    suspend fun sharedTyping(roomId: String, active: Boolean) {
        send<SharedConversationPreferences>(makeRequest("PATCH", "/api/multiplayer/rooms/${safeRouteId(roomId)}/preferences", body = buildJsonObject { put("typing", active) }))
    }
    suspend fun sharedPreferences(roomId: String, readSequence: Int? = null, notifications: String? = null, replyMode: String? = null, replyBotId: String? = null): SharedConversationPreferences {
        val body = buildJsonObject {
            readSequence?.let { put("readSequence", it) }; notifications?.let { put("notifications", it) }; replyMode?.let { put("replyMode", it) }
            replyBotId?.let { put("replyBotId", if (it.isEmpty()) JsonNull else JsonPrimitive(it)) }
        }
        return send(makeRequest(if (body.isEmpty()) "GET" else "PATCH", "/api/multiplayer/rooms/${safeRouteId(roomId)}/preferences", body = body.takeIf { it.isNotEmpty() }))
    }
    suspend fun uploadSharedAttachment(roomId: String, name: String, mime: String, data: ByteArray): SharedAttachment {
        val normalized = AttachmentPolicy.normalizedMime(mime)
        val limit = SharedAttachmentPolicy.limit(normalized)
        if (data.isEmpty() || data.size > limit || normalized !in SharedAttachmentPolicy.supportedMimes || !SharedAttachmentPolicy.validName(name)) {
            throw APIError.Transport("Choose a supported shared file under ${limit / 1024 / 1024} MB.")
        }
        return send<SharedAttachmentResponse>(makeRequest("POST", "/api/multiplayer/rooms/${safeRouteId(roomId)}/attachments", body = buildJsonObject {
            put("name", name); put("mime", normalized); put("data", java.util.Base64.getEncoder().encodeToString(data))
        })).attachment
    }
    suspend fun sharedAttachment(roomId: String, attachmentId: String): SharedAttachmentData {
        val value = send<SharedAttachmentData>(makeRequest("GET", "/api/multiplayer/rooms/${safeRouteId(roomId)}/attachments/${safeRouteId(attachmentId)}"))
        if (value.attachment.id != attachmentId) throw APIError.Transport("The shared attachment did not match this request.")
        return value
    }
    suspend fun searchSharedMessages(roomId: String, text: String, kind: String = "all", author: String = "", before: Int? = null): SharedSearchResponse = send(makeRequest(
        "GET", "/api/multiplayer/rooms/${safeRouteId(roomId)}/search", query = buildList {
            add("q" to text); add("kind" to kind); add("author" to author); add("limit" to "20"); before?.let { add("before" to it.toString()) }
        }))
    suspend fun sharedFiles(roomId: String, before: Int? = null): SharedFilesResponse = send(makeRequest("GET", "/api/multiplayer/rooms/${safeRouteId(roomId)}/files", query = buildList {
        add("limit" to "30"); before?.let { add("before" to it.toString()) }
    }))
    suspend fun sharedRequests(roomId: String, before: Int? = null): SharedRequestsResponse = send(makeRequest("GET", "/api/multiplayer/rooms/${safeRouteId(roomId)}/requests", query = buildList {
        add("limit" to "20"); before?.let { add("before" to it.toString()) }
    }))
    suspend fun cancelSharedRequest(roomId: String, requestId: String): SharedBotRequest = send<SharedRequestResponse>(makeRequest(
        "POST", "/api/multiplayer/rooms/${safeRouteId(roomId)}/requests/${safeRouteId(requestId)}/cancel")).request

    suspend fun updateRoomSettings(roomId: String, patch: JsonObject): Room {
        if (patch.keys.any { it !in setOf("name", "avatarUrl", "memberReplyModes", "notifications", "memberIds") }) throw APIError.BadUrl
        return send<CreatedRoom>(makeRequest("PATCH", "/api/groups/${safeRouteId(roomId)}", body = patch)).group
    }
    suspend fun addRoomPerson(roomId: String, personId: String): Room = send<CreatedRoom>(makeRequest(
        "POST", "/api/groups/${safeRouteId(roomId)}/people", body = jsonBody("personId" to personId))).group
    suspend fun removeRoomPerson(roomId: String, personId: String): Room = send<CreatedRoom>(makeRequest(
        "DELETE", "/api/groups/${safeRouteId(roomId)}/people/${segment(personId)}")).group
    suspend fun createRoomInvite(roomIds: List<String>): RoomInvite = send(makeRequest("POST", "/api/multiplayer/invites", body = buildJsonObject {
        put("roomIds", CompanionJson.encodeToJsonElement(roomIds))
    }))
    suspend fun roomBotGrants(roomId: String): List<String> = send<RoomBotGrants>(makeRequest(
        "GET", "/api/multiplayer/rooms/${safeRouteId(roomId)}/bot-grants")).botIds
    suspend fun setRoomBotGrants(roomId: String, botIds: List<String>): List<String> = send<RoomBotGrants>(makeRequest(
        "PUT", "/api/multiplayer/rooms/${safeRouteId(roomId)}/bot-grants", body = buildJsonObject {
            put("botIds", CompanionJson.encodeToJsonElement(botIds))
        })).botIds

    suspend fun createBot(): Bot = send<CreatedBot>(makeRequest("POST", "/api/bots")).bot

    /**
     * Atomically file visible bots under one shared sidebar heading. This is
     * narrower than the desktop's general bot patch: pairing a phone grants
     * organization, never execution-policy edits.
     */
    suspend fun assignSection(name: String, botIds: List<String>): List<Bot> = send<SidebarSectionResponse>(
        makeRequest(
            "POST",
            "/api/sidebar-sections",
            body = buildJsonObject {
                put("name", name)
                put("botIds", JsonArray(botIds.map(::JsonPrimitive)))
            },
        ),
    ).bots

    suspend fun updateProfile(botId: String, patch: BotProfilePatch): Bot {
        val body = CompanionJson.encodeToJsonElement(BotProfilePatch.serializer(), patch).jsonObject
        return send<BotResponse>(
            makeRequest("PATCH", "/api/bots/${segment(botId)}/profile", body = body),
        ).bot
    }

    /**
     * A captured task changes only that task's model. The optional legacy form
     * retains the narrow profile/default model route for older callers.
     */
    suspend fun updateModel(botId: String, selection: ModelSelection, threadId: String? = null, resetApprovalToAsk: Boolean = false): Bot {
        val model = CompanionJson.encodeToJsonElement(ModelSelection.serializer(), selection).jsonObject
        val path = if (threadId == null) "/api/bots/${segment(botId)}/model"
            else "/api/bots/${segment(botId)}/tasks/${segment(threadId)}"
        val body = if (threadId == null) model else buildJsonObject {
            put("modelSelection", model)
            put("requireAvailableModel", true)
            if (resetApprovalToAsk) put("resetApprovalToAsk", true)
        }
        return send<BotResponse>(
            makeRequest("PATCH", path, body = body),
        ).bot
    }

    /** Upload a shared image as raw bytes; [uploadId] makes an interrupted retry idempotent. */
    suspend fun uploadImage(data: ByteArray, mime: String, uploadId: String? = null): String {
        if (!validUploadId(uploadId)) throw APIError.BadUrl
        val normalized = mime.lowercase()
        if (normalized !in AVATAR_MIME_TYPES || data.size > AVATAR_MAX_BYTES) {
            throw APIError.Transport("Choose a PNG, JPEG, GIF, or WebP image up to 10 MB.")
        }
        val saved = send<AttachmentResponse>(
            makeRequest(
                "POST",
                "/api/attachments",
                query = uploadId?.let { listOf("uploadId" to it) }.orEmpty(),
                rawBody = data.toRequestBody(normalized.toMediaType()),
            ),
            uploadClient,
        )
        if (!validUploadedPath(saved.path)) {
            throw APIError.Transport("The uploaded image could not be used.")
        }
        return saved.path
    }

    suspend fun uploadAvatar(data: ByteArray, mime: String): String {
        val path = uploadImage(data, mime)
        val name = path.substringAfterLast('/')
        if (name.isEmpty() || '/' in name) throw APIError.Transport("The uploaded image could not be used.")
        return "/api/attachments/$name"
    }

    /** Upload a supported document. The server picks its storage path; [name] is display metadata. */
    suspend fun uploadFile(data: ByteArray, name: String, mime: String, uploadId: String? = null): UploadedFile {
        if (!validUploadId(uploadId)) throw APIError.BadUrl
        val displayName = name.substringAfterLast('/').substringAfterLast('\\').trim()
        val normalized = mime.lowercase()
        if (
            displayName.isEmpty() || displayName.toByteArray().size > 255 ||
            !validUploadMime(normalized) || data.size > SHARE_FILE_MAX_BYTES
        ) throw APIError.Transport("Choose a file up to 25 MB with a valid filename.")
        val saved = send<FileUploadResponse>(
            makeRequest(
                "POST",
                "/api/files",
                query = buildList {
                    add("name" to displayName)
                    uploadId?.let { add("uploadId" to it) }
                },
                rawBody = data.toRequestBody(normalized.toMediaType()),
            ),
            uploadClient,
        )
        val returnedName = saved.name.trim()
        if (!validUploadedPath(saved.path) || !validUploadedName(returnedName)) {
            throw APIError.Transport("The uploaded file could not be used.")
        }
        return UploadedFile(saved.path, returnedName)
    }

    /** Streams app-owned files without buffering their full contents. */
    suspend fun uploadFile(file: File, name: String, mime: String, uploadId: String? = null): UploadedFile {
        if (!validUploadId(uploadId)) throw APIError.BadUrl
        val normalized = AttachmentPolicy.normalizedMime(mime)
        val displayName = name.substringAfterLast('/').substringAfterLast('\\').trim()
        if (!file.isFile || !file.canRead() || file.length() > AttachmentPolicy.MAXIMUM_FILE_BYTES ||
            !validUploadedName(displayName) || !validUploadMime(normalized)) {
            throw APIError.Transport("Choose an available file up to 90 MB with a valid filename.")
        }
        val saved = send<FileUploadResponse>(makeRequest("POST", "/api/files",
            query = buildList { add("name" to displayName); uploadId?.let { add("uploadId" to it) } },
            rawBody = file.asRequestBody(normalized.toMediaType())), uploadClient)
        if (!validUploadedPath(saved.path) || !validUploadedName(saved.name.trim())) {
            throw APIError.Transport("The uploaded file could not be used.")
        }
        return UploadedFile(saved.path, saved.name.trim())
    }

    suspend fun generateAvatar(botId: String, prompt: String): Bot =
        send<GeneratedAvatarResponse>(
            makeRequest(
                "POST",
                "/api/bots/${segment(botId)}/avatar/generate",
                body = jsonBody("prompt" to prompt.take(400)),
            ),
            avatarGenerationClient,
        ).bot

    suspend fun previewVoice(text: String, voiceId: String): ByteArray {
        val raw = perform(makeRequest(
            "POST",
            "/api/tts/speak",
            body = jsonBody("text" to text.take(500), "voiceId" to voiceId),
        ))
        check(raw)
        return raw.data
    }

    suspend fun createRoutine(input: RoutineInput): Routine {
        requireSupported(input.schedule)
        requireValidTimeout(input.timeoutMinutes)
        return send<RoutineResponse>(
            makeRequest("POST", "/api/routines", body = routineBody(input)),
        ).routine
    }

    suspend fun updateRoutine(id: String, input: RoutineInput): Routine {
        requireSupported(input.schedule)
        requireValidTimeout(input.timeoutMinutes)
        return send<RoutineResponse>(
            makeRequest("PATCH", "/api/routines/${segment(id)}", body = routineBody(input)),
        ).routine
    }

    suspend fun setRoutineEnabled(id: String, enabled: Boolean): Routine =
        send<RoutineResponse>(
            makeRequest("PATCH", "/api/routines/${segment(id)}", body = buildJsonObject { put("enabled", enabled) }),
        ).routine

    suspend fun runRoutine(id: String): RoutineRun = send<RoutineRunResponse>(
        makeRequest("POST", "/api/routines/${segment(id)}/run"),
    ).run

    suspend fun deleteRoutine(id: String) {
        sendUnit(makeRequest("DELETE", "/api/routines/${segment(id)}"))
    }

    suspend fun createRoom(name: String?, memberIds: List<String>): Room {
        val body = buildJsonObject {
            put("memberIds", JsonArray(memberIds.map(::JsonPrimitive)))
            name?.let { value ->
                val trimmed = value.trim { character ->
                    character == '\t' || character.category == CharCategory.SPACE_SEPARATOR
                }
                if (trimmed.isNotEmpty()) put("name", value)
            }
        }
        return send<CreatedRoom>(makeRequest("POST", "/api/groups", body = body)).group
    }

    suspend fun sendToBot(botId: String, text: String, threadId: String? = null): SendReceipt =
        sendForReceipt(
            makeRequest("POST", "/api/bots/${segment(botId)}/messages", body = jsonBody("text" to text, "threadId" to threadId)),
        )

    suspend fun sendToRoom(groupId: String, text: String, threadId: String? = null): SendReceipt =
        sendForReceipt(
            makeRequest("POST", "/api/groups/${segment(groupId)}/messages", body = jsonBody("text" to text, "threadId" to threadId)),
        )

    /**
     * Drop a message the harness is still holding, before the turn it is
     * waiting behind settles.
     *
     * An entry that drained a moment ago is not an error worth showing — that
     * is the outcome the caller wanted. But that is matched positively on the
     * harness's own wording and never on the status alone: the sidecar answers
     * 404 "no route" for a route it does not allow, so a computer too old to
     * have this route looks identical to a drained entry. Reading those as the
     * same thing takes the message off the phone while it is still queued on
     * the computer, and it then arrives anyway.
     */
    suspend fun cancelQueued(queueId: String, to: MessageDestination) {
        if (!isSafeRouteId(queueId)) throw APIError.BadUrl
        val route = when (to) {
            is MessageDestination.Bot -> "/api/bots/${safeRouteId(to.id)}/queue/$queueId"
            is MessageDestination.Room -> "/api/groups/${safeRouteId(to.id)}/queue/$queueId"
        }
        try {
            sendUnit(makeRequest("DELETE", route, body = jsonBody("threadId" to to.threadId)))
        } catch (error: APIError.Status) {
            if (error.code != 404) throw error
            // The harness's own words, not Throwable.message, which falls
            // back to generic text for a 404 and would swallow everything.
            if (error.serverMessage?.contains(ALREADY_DRAINED, ignoreCase = true) == true) return
            throw APIError.Status(
                404,
                "This computer is too old to take back a queued message. Update BOS Bot on it.",
            )
        }
    }

    /** Retry-safe send: [threadId] is fixed at destination selection, never inferred on retry. */
    suspend fun send(text: String, to: MessageDestination, sendId: String, replyToId: String? = null, priority: MessagePriority = MessagePriority.QUEUE): SendReceipt {
        val route = when (to) {
            is MessageDestination.Bot -> "/api/bots/${safeRouteId(to.id)}/messages"
            is MessageDestination.Room -> "/api/groups/${safeRouteId(to.id)}/messages"
        }
        if (!isSafeRouteId(to.threadId) || !isSafeSendId(sendId) || (replyToId != null && !isSafeRouteId(replyToId))) throw APIError.BadUrl
        return sendForReceipt(makeRequest(
            "POST",
            route,
            body = buildJsonObject {
                put("text", text)
                put("threadId", to.threadId)
                put("sendId", sendId)
                replyToId?.let { put("replyToId", it) }
                if (priority == MessagePriority.BLOCK) put("priority", "block")
            },
        ))
    }

    suspend fun editQueued(queueId: String, to: MessageDestination, expectedText: String, text: String) {
        val root = when (to) { is MessageDestination.Bot -> "bots"; is MessageDestination.Room -> "groups" }
        val route = "/api/$root/${safeRouteId(to.id)}/queue/${safeRouteId(queueId)}"
        if (!isSafeRouteId(to.threadId)) throw APIError.BadUrl
        val receipt = send<JsonObject>(makeRequest("PATCH", route, body = jsonBody(
            "threadId" to to.threadId, "expectedText" to expectedText, "text" to text)))
        if (receipt["ok"] != JsonPrimitive(true) || receipt["queueId"] != JsonPrimitive(queueId) ||
            receipt["threadId"] != JsonPrimitive(to.threadId) || receipt["text"] != JsonPrimitive(text)) {
            throw APIError.Status(409, "The queued edit receipt did not match. Your edits are still here.")
        }
    }

    suspend fun steerQueued(queueId: String, to: MessageDestination, botId: String? = null): SteerReceipt {
        val root = when (to) { is MessageDestination.Bot -> "bots"; is MessageDestination.Room -> "groups" }
        if (!isSafeRouteId(to.threadId) || (botId != null && !isSafeRouteId(botId))) throw APIError.BadUrl
        return send(makeRequest("POST", "/api/$root/${safeRouteId(to.id)}/queue/${safeRouteId(queueId)}/steer",
            body = buildJsonObject {
                put("threadId", to.threadId)
                if (to is MessageDestination.Bot) put("interrupt", true)
                if (to is MessageDestination.Room) botId?.let { put("botId", it) }
            }))
    }

    suspend fun respond(
        threadId: String,
        requestId: String,
        behavior: String,
        message: String? = null,
        reviewedSha256: String? = null,
    ) {
        val body = buildJsonObject {
            put("requestId", requestId)
            put("behavior", behavior)
            message?.let { put("message", it) }
            reviewedSha256?.let { put("reviewedSha256", it) }
        }
        sendUnit(makeRequest("POST", "/api/threads/${segment(threadId)}/respond", body = body))
    }

    suspend fun alwaysAllow(botId: String, key: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/bots/${segment(botId)}/always-allow", body = jsonBody("allowKey" to key, "threadId" to threadId)))
    }

    suspend fun authorizeConnector(slug: String, alias: String?): URI {
        if (!validConnectorSlug(slug)) throw APIError.BadUrl
        val body = ConnectedAppsRules.trimmedAlias(alias)?.let { jsonBody("alias" to it) }
        val response = send<ConnectorAuthorizationResponse>(makeRequest(
            "POST",
            "/api/connectors/$slug/authorize",
            body = body,
        ))
        val url = runCatching { URI(response.url) }.getOrNull()
        if (url == null || !url.scheme.equals("https", ignoreCase = true) || url.host.isNullOrEmpty()) {
            throw APIError.BadUrl
        }
        return url
    }

    suspend fun toggleReaction(threadId: String, messageId: String, emoji: String): Message =
        send<MessageResponse>(makeRequest(
            "POST",
            "/api/threads/${segment(threadId)}/messages/${segment(messageId)}/reactions",
            body = jsonBody("emoji" to emoji),
        )).message

    suspend fun edit(botId: String, messageId: String, text: String, threadId: String? = null) {
        sendUnit(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/messages/${segment(messageId)}/edit",
            body = jsonBody("text" to text, "threadId" to threadId),
        ))
    }

    suspend fun setActiveBranch(botId: String, messageId: String, threadId: String? = null): String =
        send<ActiveBranchResponse>(makeRequest(
            "POST",
            "/api/bots/${segment(botId)}/active-branch",
            body = jsonBody("messageId" to messageId, "threadId" to threadId),
        )).activeLeafId

    suspend fun createTask(botId: String, title: String? = null): Bot {
        val body = buildJsonObject {
            title?.takeIf(String::isNotEmpty)?.let { put("title", it) }
        }
        return send<BotResponse>(makeRequest("POST", "/api/bots/${segment(botId)}/tasks", body = body)).bot
    }

    suspend fun switchTask(botId: String, threadId: String): Bot = send<BotResponse>(
        makeRequest("POST", "/api/bots/${segment(botId)}/tasks/${segment(threadId)}"),
    ).bot

    suspend fun renameTask(botId: String, threadId: String, title: String) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/bots/${segment(botId)}/tasks/${segment(threadId)}",
            body = jsonBody("title" to title),
        ))
    }

    /** The unarchive PATCH carries an explicit null, so jsonBody's skip-nulls
     * rule cannot be used here. Stamps are whole milliseconds: a Double would
     * serialize large ones in scientific notation. */
    suspend fun setTaskArchived(botId: String, threadId: String, archivedAt: Double?) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/bots/${segment(botId)}/tasks/${segment(threadId)}",
            body = buildJsonObject { put("archivedAt", JsonPrimitive(archivedAt?.toLong())) },
        ))
    }

    suspend fun deleteTask(botId: String, threadId: String): Bot = send<BotResponse>(
        makeRequest("DELETE", "/api/bots/${segment(botId)}/tasks/${segment(threadId)}"),
    ).bot

    suspend fun createRoomTask(groupId: String, title: String? = null): Room {
        val body = buildJsonObject {
            title?.takeIf(String::isNotEmpty)?.let { put("title", it) }
        }
        return send<RoomResponse>(
            makeRequest("POST", "/api/groups/${segment(groupId)}/tasks", body = body),
        ).group
    }

    suspend fun switchRoomTask(groupId: String, threadId: String): Room = send<RoomResponse>(
        makeRequest("POST", "/api/groups/${segment(groupId)}/tasks/${segment(threadId)}"),
    ).group

    suspend fun renameRoomTask(groupId: String, threadId: String, title: String) {
        sendUnit(makeRequest(
            "PATCH",
            "/api/groups/${segment(groupId)}/tasks/${segment(threadId)}",
            body = jsonBody("title" to title),
        ))
    }

    suspend fun deleteRoomTask(groupId: String, threadId: String): Room = send<RoomResponse>(
        makeRequest("DELETE", "/api/groups/${segment(groupId)}/tasks/${segment(threadId)}"),
    ).group

    suspend fun interrupt(botId: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/bots/${segment(botId)}/interrupt", body = jsonBody("threadId" to threadId)))
    }

    suspend fun cloudDesktop(botId: String): CloudDesktopSession = send(
        makeRequest("POST", "/api/bots/${segment(botId)}/computer/join"),
    )

    suspend fun markBotRead(botId: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/bots/${segment(botId)}/read", body = jsonBody("threadId" to threadId)))
    }

    suspend fun markRoomRead(roomId: String, threadId: String? = null) {
        sendUnit(makeRequest("POST", "/api/groups/${segment(roomId)}/read", body = jsonBody("threadId" to threadId)))
    }

    fun roomEvents(groupId: String): Flow<StreamFrame> = eventStream(
        makeRequest("GET", "/api/groups/${safeRouteId(groupId)}/events").newBuilder()
            .header("Accept", "text/event-stream").build(), streamingClient)

    fun browserEvents(botId: String): Flow<BrowserViewerEvent> = browserViewerStream(
        makeRequest("GET", "/api/bots/${safeRouteId(botId)}/browser/live").newBuilder()
            .header("Accept", "text/event-stream").build(), streamingClient)

    suspend fun browserAction(botId: String, viewerId: String, action: BrowserViewerAction) {
        sendUnit(makeRequest("POST", "/api/bots/${safeRouteId(botId)}/browser/action", body = buildJsonObject {
            action.body().forEach { (key, value) -> put(key, value) }
            put("viewerId", viewerId)
        }))
    }

    fun events(since: String?, screens: Boolean = false): Flow<StreamFrame> {
        val query = buildList {
            add("taskDeltas" to "1")
            add("screens" to if (screens) "on" else "off")
            since?.let { add("since" to it) }
        }
        val request = makeRequest("GET", "/api/events", query).newBuilder()
            .header("Accept", "text/event-stream")
            .build()
        return eventStream(request, streamingClient)
    }

    private fun makeRequest(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: JsonObject? = null,
        rawBody: RequestBody? = null,
    ): Request {
        require(body == null || rawBody == null)
        val base = endpoint?.baseUrl ?: throw APIError.BadUrl
        val url = base.newBuilder().encodedPath(path).apply {
            query.forEach { (name, value) -> addQueryParameter(name, value) }
        }.build()
        val requestBody = when {
            rawBody != null -> rawBody
            body != null -> CompanionJson.encodeToString(JsonObject.serializer(), body)
                .toRequestBody(JSON_MEDIA_TYPE)
            method == "POST" || method == "PATCH" -> EMPTY_BODY
            else -> null
        }
        return Request.Builder()
            .url(url)
            .method(method, requestBody)
            .apply { token?.let { header("Authorization", "Bearer $it") } }
            .build()
    }

    private suspend inline fun <reified T> send(
        request: Request,
        requestClient: OkHttpClient = actionClient,
    ): T {
        val raw = perform(request, requestClient)
        check(raw)
        return try {
            CompanionJson.decodeFromString(raw.data.toString(Charsets.UTF_8))
        } catch (error: SerializationException) {
            throw APIError.Transport("The computer sent something this app couldn't read.", error)
        }
    }

    private suspend fun sendUnit(request: Request) {
        val raw = perform(request)
        check(raw)
    }

    /**
     * A send, and what the harness did with it. Unlike [send] an unreadable
     * body is not an error here: the request succeeded, and an older harness
     * answering with a shape this build has never seen still made a plain
     * send. Only the extra mid-turn detail is lost.
     */
    private suspend fun sendForReceipt(request: Request): SendReceipt {
        val raw = perform(request)
        check(raw)
        return try {
            CompanionJson
                .decodeFromString<SendReceiptBody>(raw.data.toString(Charsets.UTF_8))
                .receipt()
        } catch (_: SerializationException) {
            SendReceipt.Sent(threadId = null, steered = false)
        }
    }

    private suspend fun perform(
        request: Request,
        requestClient: OkHttpClient = actionClient,
    ): RawResponse = suspendCancellableCoroutine { continuation ->
        val call = requestClient.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) {
                    continuation.resumeWithException(
                        APIError.Transport(e.message ?: "Could not reach the computer.", e),
                    )
                }
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    response.use {
                        val result = RawResponse(
                            code = response.code,
                            headers = response.headers,
                            data = response.body?.bytes() ?: ByteArray(0),
                        )
                        if (continuation.isActive) continuation.resume(result)
                    }
                } catch (error: IOException) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(
                            APIError.Transport(error.message ?: "Could not reach the computer.", error),
                        )
                    }
                }
            }
        })
    }

    private fun check(response: RawResponse) {
        if (response.code in 200..299) return
        val message = runCatching {
            CompanionJson.decodeFromString<APIErrorBody>(response.data.toString(Charsets.UTF_8)).error
        }.getOrNull()
        throw APIError.Status(response.code, message)
    }

    private data class RawResponse(val code: Int, val headers: Headers, val data: ByteArray)

    companion object {
        /**
         * The harness's own answer when the entry is not in its queue.
         * Matched positively, never by status alone — see [cancelQueued].
         */
        const val ALREADY_DRAINED = "no such queued message"

        private const val ACTION_TIMEOUT_SECONDS = 20L
        private const val AVATAR_GENERATION_TIMEOUT_SECONDS = 150L
        private const val STREAM_IDLE_TIMEOUT_SECONDS = 90L
        private const val AVATAR_MAX_BYTES = 10 * 1_024 * 1_024
        const val SHARE_FILE_MAX_BYTES = 25 * 1_024 * 1_024
        const val MAXIMUM_FILE_DOWNLOAD_BYTES = AttachmentPolicy.MAXIMUM_FILE_BYTES

        /**
         * The name to show a downloaded file under: `filename*=` first, then
         * `filename=`, then the last segment of the requested path — reduced to
         * a basename, with control and bidi-override characters blanked so a
         * server-chosen name cannot disguise itself.
         */
        internal fun downloadFilename(disposition: String?, fallbackPath: String): String {
            val parameters = disposition.orEmpty().split(';').map(String::trim)
            val encoded = parameters.firstOrNull { it.startsWith("filename*=", ignoreCase = true) }
                ?.drop("filename*=".length)
            val ordinary = parameters.firstOrNull { it.startsWith("filename=", ignoreCase = true) }
                ?.drop("filename=".length)
            val decodedEncoded = encoded?.let { value ->
                val unquoted = value.trim('"')
                val payload = unquoted.split('\'', limit = 3)
                val encodedValue = if (payload.size == 3) payload[2] else unquoted
                runCatching { java.net.URLDecoder.decode(encodedValue.replace("+", "%2B"), "UTF-8") }.getOrNull()
            }
            val candidate = decodedEncoded
                ?: ordinary?.trim('"')
                ?: fallbackPath.split('/', '\\').lastOrNull { it.isNotEmpty() }
                ?: "file"
            return sanitisePortableFilename(candidate, "file")
        }
        private val AVATAR_MIME_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
        private val EMPTY_BODY: RequestBody = ByteArray(0).toRequestBody(null)
        private const val HEX_DIGITS = "0123456789ABCDEF"

        /**
         * Escape one opaque id so it can only ever be a single path segment.
         *
         * [makeRequest] hands the finished string to `encodedPath`, which reads
         * it as already-encoded path syntax: an id holding `/` splits into extra
         * segments, and an id that is `.` or `..` is resolved away against the
         * segments before it. Percent-escaping alone cannot save a dot segment —
         * OkHttp resolves `%2e` and `%2e%2e` the same way — so those two ids are
         * refused outright, as is the empty id that would collapse the route.
         * Ids the sidecar issues carry no path syntax, so nothing valid changes.
         */
        private fun segment(value: String): String {
            if (value.isEmpty() || value == "." || value == "..") throw APIError.BadUrl
            val escaped = StringBuilder(value.length)
            for (byte in value.toByteArray(Charsets.UTF_8)) {
                val code = byte.toInt() and 0xFF
                val character = code.toChar()
                val unreserved = character in '0'..'9' ||
                    character in 'A'..'Z' ||
                    character in 'a'..'z' ||
                    character == '-' ||
                    character == '.' ||
                    character == '_' ||
                    character == '~'
                if (unreserved) {
                    escaped.append(character)
                } else {
                    escaped.append('%')
                        .append(HEX_DIGITS[code shr 4])
                        .append(HEX_DIGITS[code and 0x0F])
                }
            }
            return escaped.toString()
        }

        private fun validAvatarPath(path: String): Boolean {
            val prefix = "/api/attachments/"
            if (!path.startsWith(prefix)) return false
            val name = path.removePrefix(prefix)
            val dot = name.lastIndexOf('.')
            if (dot <= 0) return false
            val stem = name.substring(0, dot)
            val extension = name.substring(dot + 1)
            return stem.all { it in '0'..'9' || it in 'A'..'Z' || it in 'a'..'z' || it == '-' } &&
                extension in setOf("png", "jpg", "gif", "webp")
        }

        private fun validUploadMime(value: String): Boolean =
            value.isNotEmpty() && value.toByteArray().size <= 127 && '/' in value && value.all {
                it.isLetterOrDigit() || it in "!#$&+-. /^_".filterNot(Char::isWhitespace)
            }

        private fun validUploadId(value: String?): Boolean = value == null || runCatching {
            UUID.fromString(value).toString().equals(value, ignoreCase = true)
        }.getOrDefault(false)

        private fun validUploadedPath(value: String): Boolean =
            value.isNotEmpty() && value.toByteArray().size <= 4_096 && '\u0000' !in value

        private fun validUploadedName(value: String): Boolean =
            value.isNotEmpty() && value.toByteArray().size <= 255 && '/' !in value && '\\' !in value &&
                value.none(Char::isISOControl)

        private fun isSafeRouteId(value: String): Boolean =
            value.isNotEmpty() && value.all { it.isLetterOrDigit() || it == '-' || it == '_' }

        private fun safeRouteId(value: String): String = if (isSafeRouteId(value)) value else throw APIError.BadUrl

        private fun isSafeSendId(value: String): Boolean = value.length in 16..80 && isSafeRouteId(value)

        private fun validConnectorSlug(value: String): Boolean =
            value.isNotEmpty() && value.all {
                it in '0'..'9' || it in 'A'..'Z' || it in 'a'..'z' || it == '_' || it == '-'
            }

        private fun requireSupported(schedule: RoutineSchedule) {
            if (schedule.type == RoutineSchedule.Kind.UNKNOWN) {
                throw APIError.Transport("Choose a supported schedule before saving this routine.")
            }
            if (
                schedule.type == RoutineSchedule.Kind.INTERVAL &&
                ((schedule.everyMinutes ?: 0) !in 5..1_440 || schedule.anchorAt == null)
            ) {
                throw APIError.Transport(
                    "Choose an interval from 5 to 1,440 minutes and an alignment time.",
                )
            }
        }

        private fun requireValidTimeout(timeoutMinutes: Int?) {
            if (timeoutMinutes != null && timeoutMinutes !in 5..240) {
                throw APIError.Transport("Choose no timeout or a whole number from 5 to 240 minutes.")
            }
        }

        private fun routineBody(input: RoutineInput): JsonObject = buildJsonObject {
            put("name", input.name)
            put("prompt", input.prompt)
            put("botId", input.botId)
            put("runOn", input.runOn)
            input.enabled?.let { put("enabled", it) }
            put("schedule", buildJsonObject {
                put("type", input.schedule.type.name.lowercase())
                input.schedule.at?.let { put("at", it) }
                input.schedule.time?.let { put("time", it) }
                input.schedule.weekdays?.let { days ->
                    put("weekdays", JsonArray(days.map(::JsonPrimitive)))
                }
                input.schedule.everyMinutes?.let { put("everyMinutes", it) }
                input.schedule.anchorAt?.let { put("anchorAt", it) }
            })
            put("durationMinutes", input.durationMinutes)
            if (input.timeoutMinutes != null) put("timeoutMinutes", input.timeoutMinutes)
            else if (input.clearTimeout) put("timeoutMinutes", JsonNull)
        }

        suspend fun pair(
            connection: Connection,
            credential: String,
            deviceName: String,
            pairRequestId: String? = null,
            client: OkHttpClient = OkHttpClient(),
        ): PairResponse {
            val field = if (credential.length == 6 && credential.all { it in '0'..'9' }) {
                "code"
            } else {
                "credential"
            }
            val companion = CompanionClient(connection, token = null, baseClient = client)
            val body = buildList {
                add(field to credential)
                add("deviceName" to deviceName)
                pairRequestId?.let { add("pairRequestId" to it) }
            }
            val pairClient = client.newBuilder()
                .dns(companion.endpoint?.dns ?: client.dns)
                .callTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .connectTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .readTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .writeTimeout(PAIR_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .build()
            return companion.send(companion.makeRequest(
                "POST",
                "/api/pair",
                body = jsonBody(*body.toTypedArray()),
            ), pairClient)
        }

        /**
         * Source-compatible entry point for callers written before request ids existed.
         *
         * This overload sends the credential directly to [connection], without a health/identity
         * preflight or request id. It is not safe for new multi-route pairing invitations; those
         * callers must use [pairFirstReachable].
         */
        suspend fun pair(
            connection: Connection,
            credential: String,
            deviceName: String,
            client: OkHttpClient,
        ): PairResponse = pair(
            connection,
            credential,
            deviceName,
            pairRequestId = null,
            client = client,
        )

        /**
         * Identify every automatically permitted route before presenting the one-time credential.
         * Probes run together, but the advertised order wins rather than response speed.
         */
        suspend fun pairFirstReachable(
            connection: Connection,
            credential: String,
            deviceName: String,
            pairRequestId: String = UUID.randomUUID().toString(),
            client: OkHttpClient = OkHttpClient(),
        ): PairingOutcome {
            normalizedServerCode(credential)?.let { code ->
                val probe = CompanionClient(connection, token = null, baseClient = client)
                val environment = try { probe.environment() } catch (error: APIError.Status) {
                    if (error.code == 404) throw APIError.Transport("${connection.displayAddress} isn't a BOS server. Check the address and try again.")
                    throw error
                }
                val response = pairWithServer(connection, code, deviceName, pairRequestId, client)
                if (response.environment.environmentId != environment.environmentId) {
                    throw APIError.Transport("The server changed during pairing. Start pairing again.")
                }
                return PairingOutcome(PairResponse(response.token,
                    PairedDevice(response.session.id, response.session.label, 0.0, 0.0), response.environment.label),
                    connection, response)
            }
            val endpoints = connection.automaticEndpoints
            val attemptedRoutes = endpoints.map(CompanionEndpoint::url)
            val remaining = endpoints.map(connection::dialing).toMutableList()

            while (remaining.isNotEmpty()) {
                val winnerIndex = firstHealthy(remaining, client)
                    ?: throw PairingRouteError(attemptedRoutes)
                val winner = remaining.removeAt(winnerIndex)
                try {
                    val response = pair(
                        connection = winner,
                        credential = credential,
                        deviceName = deviceName,
                        pairRequestId = pairRequestId,
                        client = client,
                    )
                    return PairingOutcome(response, winner)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: APIError) {
                    if (ConnectionAdvice.shouldRetryPairingOnAnotherRoute(error)) continue
                    throw error
                } catch (_: Exception) {
                    // An unreadable/lost response is ambiguous. A newer sidecar replays the
                    // result for this exact request id through the next verified route.
                    continue
                }
            }
            throw PairingRouteError(attemptedRoutes)
        }

        fun normalizedServerCode(raw: String): String? {
            val code = raw.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }
                .replace('0', 'O').replace('1', 'I')
            return code.takeIf { it.length == 12 && it.all { symbol -> symbol in "23456789ABCDEFGHJKLMNPQRSTUVWXYZ" } }
        }

        suspend fun pairWithServer(connection: Connection, code: String, label: String,
            attemptId: String = UUID.randomUUID().toString(), client: OkHttpClient = OkHttpClient()): ServerPairResponse {
            val normalized = normalizedServerCode(code) ?: throw APIError.BadUrl
            val companion = CompanionClient(connection, token = null, baseClient = client)
            val pairClient = client.newBuilder().dns(companion.endpoint?.dns ?: client.dns)
                .callTimeout(8, TimeUnit.SECONDS).build()
            return companion.send(companion.makeRequest("POST", "/api/auth/pair", body = jsonBody(
                "code" to normalized, "label" to label, "attemptId" to attemptId)), pairClient)
        }

        private suspend fun firstHealthy(
            candidates: List<Connection>,
            client: OkHttpClient,
        ): Int? = coroutineScope {
            val probes = candidates.map { candidate ->
                async { healthy(candidate, client) }
            }
            try {
                for (index in probes.indices) {
                    if (probes[index].await()) {
                        probes.forEachIndexed { offset, probe ->
                            if (offset != index) probe.cancel()
                        }
                        return@coroutineScope index
                    }
                }
                null
            } finally {
                probes.forEach { it.cancel() }
            }
        }

        private suspend fun healthy(connection: Connection, client: OkHttpClient): Boolean {
            val companion = CompanionClient(connection, token = null, baseClient = client)
            val probeClient = client.newBuilder()
                .dns(companion.endpoint?.dns ?: client.dns)
                .callTimeout(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .connectTimeout(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .readTimeout(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .writeTimeout(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
                .build()
            return try {
                val identity = companion.send<HealthIdentity>(
                    companion.makeRequest("GET", "/api/health"),
                    probeClient,
                )
                identity.app == "openmausbot"
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                false
            }
        }

        @Serializable
        private data class HealthIdentity(val app: String)

        private fun jsonBody(vararg values: Pair<String, String?>): JsonObject = buildJsonObject {
            values.forEach { (name, value) -> value?.let { put(name, it) } }
        }

        private const val PROBE_TIMEOUT_SECONDS = 4L
        private const val PAIR_TIMEOUT_SECONDS = 8L
    }
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; health: legacy app health identity is checked by old clients and updater preflight
