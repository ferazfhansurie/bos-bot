package com.openmausbot.companion.core

import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

@Serializable
data class AndroidUpdateManifest(val version: String, val versionCode: Long, val url: String, val sha256: String) {
    fun validate() {
        require(version.isNotBlank() && versionCode > 0) { "Invalid update version" }
        require(AndroidAppUpdates.secureUrl(url)) { "Update downloads require HTTPS" }
        require(sha256.matches(Regex("[a-fA-F0-9]{64}"))) { "Invalid update checksum" }
    }
    fun isNewerThan(installedCode: Long): Boolean {
        validate()
        return versionCode > installedCode
    }
}

/** No companion credentials are sent to the public update host. */
class AndroidAppUpdates(private val fetch: (suspend (String) -> ByteArray)? = null) {
    suspend fun manifest(url: String = MANIFEST_URL): AndroidUpdateManifest {
        require(secureUrl(url))
        val bytes = fetch?.invoke(url) ?: fetchUpdateBytes(url)
        require(bytes.size <= 64 * 1024) { "Update manifest is too large" }
        return CompanionJson.decodeFromString<AndroidUpdateManifest>(bytes.decodeToString()).also { it.validate() }
    }

    suspend fun download(manifest: AndroidUpdateManifest, directory: File): File = withContext(Dispatchers.IO) {
        manifest.validate()
        directory.mkdirs()
        val partial = File(directory, "bos-update.part")
        val ready = File(directory, "bos-update.apk")
        // A failed replacement must never leave an older APK looking ready.
        ready.delete()
        try {
            if (fetch != null) {
                val bytes = fetch.invoke(manifest.url)
                require(bytes.isNotEmpty() && bytes.size <= MAX_APK_BYTES) { "Invalid APK size" }
                partial.writeBytes(bytes)
            } else {
                partial.outputStream().use { copyUpdateResponse(manifest.url, MAX_APK_BYTES, it) }
            }
            require(verified(partial, manifest)) { "Update checksum did not match" }
            check(partial.renameTo(ready)) { "Couldn't prepare the update" }
            ready
        } finally { partial.delete() }
    }

    companion object {
        const val MANIFEST_URL = "https://bosbot.my/updates/android.json"
        const val MAX_APK_BYTES = 128 * 1024 * 1024
        fun checkDue(lastAttempt: Long?, now: Long): Boolean =
            lastAttempt == null || (now >= lastAttempt && now - lastAttempt >= 86_400_000)
        fun secureUrl(value: String): Boolean = value.toHttpUrlOrNull()?.let {
            it.isHttps && it.username.isEmpty() && it.password.isEmpty()
        } == true
        fun verified(file: File, manifest: AndroidUpdateManifest): Boolean {
            if (!file.isFile || file.length() !in 1..MAX_APK_BYTES.toLong()) return false
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }.equals(manifest.sha256, ignoreCase = true)
        }
    }
}

private val updateHttpClient = OkHttpClient.Builder().followSslRedirects(false)
    .callTimeout(5, TimeUnit.MINUTES).build()

private suspend fun fetchUpdateBytes(url: String): ByteArray = withContext(Dispatchers.IO) {
    val output = java.io.ByteArrayOutputStream()
    copyUpdateResponse(url, 64 * 1024, output)
    output.toByteArray()
}

private fun copyUpdateResponse(url: String, limit: Int, output: java.io.OutputStream) {
    require(AndroidAppUpdates.secureUrl(url))
    updateHttpClient.newCall(Request.Builder().url(url).build()).execute().use { response ->
        check(response.isSuccessful) { "Update download unavailable" }
        val body = requireNotNull(response.body)
        require(body.contentLength() <= limit) { "Update download too large" }
        body.byteStream().use { input -> copyBoundedUpdate(input, output, limit) }
    }
}

internal fun copyBoundedUpdate(input: java.io.InputStream, output: java.io.OutputStream, limit: Int) {
    val buffer = ByteArray(32 * 1024)
    var written = 0L
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        require(written + count <= limit) { "Update download too large" }
        output.write(buffer, 0, count)
        written += count
    }
}

class PhoneUpdateRequired(val minimumVersion: String, val url: String) : Exception("Update the app to continue")

object PhoneCompatibility {
    private fun compareVersions(currentVersion: String, minimumVersion: String): Int? {
        fun parts(version: String): List<Int>? {
            val numbers = version.split('.').map { it.toIntOrNull() ?: return null }
            return numbers.takeIf { it.size == 3 && it.all { part -> part >= 0 } }
        }
        val current = parts(currentVersion) ?: return null
        val minimum = parts(minimumVersion) ?: return null
        val different = current.zip(minimum).firstOrNull { it.first != it.second } ?: return 0
        return different.first.compareTo(different.second)
    }

    fun isAtLeast(version: String, minimum: String): Boolean {
        return (compareVersions(version, minimum) ?: return false) >= 0
    }

    fun requiredUpdate(raw: JsonElement, currentVersion: String): PhoneUpdateRequired? {
        val environment = raw as? JsonObject ?: return null
        val minimum = (environment["minPhoneVersion"] as? JsonPrimitive)?.contentOrNull ?: return null
        if ((compareVersions(currentVersion, minimum) ?: return null) >= 0) return null
        val links = environment["phoneUpdateUrls"] as? JsonObject
        val url = (links?.get("android") as? JsonPrimitive)?.contentOrNull
            ?.takeIf { AndroidAppUpdates.secureUrl(it) } ?: AndroidAppUpdates.MANIFEST_URL
        return PhoneUpdateRequired(minimum, url)
    }
}
