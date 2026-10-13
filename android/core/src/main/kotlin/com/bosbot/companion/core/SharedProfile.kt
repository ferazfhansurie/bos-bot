package com.openmausbot.companion.core
import kotlinx.serialization.Serializable
@Serializable data class SharedMe(val actorId: String? = null, val homeId: String, val name: String? = null,
    val role: String? = null, val avatar: String? = null)
