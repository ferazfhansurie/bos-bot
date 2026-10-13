package com.openmausbot.companion.storage

import android.content.Context
import com.openmausbot.companion.core.AttachmentPolicy
import com.openmausbot.companion.core.PendingMessageAttachment
import java.io.File
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** Durable private media drafts; transport UUIDs survive a process restart. No tokens are stored. */
class ComposerDraftStore(context: Context) {
    private val root = File(context.filesDir, "composer-drafts").apply { mkdirs() }
    private val imports = File(context.filesDir, "composer-attachments")
    data class Draft(val typed: String, val sendId: String?, val attachments: List<PendingMessageAttachment>, val payload: String? = null)
    private fun folder(key: String) = File(root, MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) })

    @Synchronized
    fun save(key: String, typed: String, sendId: String?, attachments: List<PendingMessageAttachment>, payload: String? = null) {
        if (typed.isEmpty() && attachments.isEmpty()) { clear(key); return }
        AttachmentPolicy.validate(attachments)
        val dir = folder(key).apply { mkdirs() }
        val rows = JSONArray()
        for (item in attachments) {
            require(item.id.matches(Regex("[a-zA-Z0-9_-]{1,128}")))
            val destination = File(dir, item.id + ".media")
            if (!destination.exists()) {
                val temporary = File(dir, item.id + ".tmp")
                val sourceFile = item.file
                if (sourceFile != null) sourceFile.inputStream().use { input -> temporary.outputStream().use { output -> input.copyTo(output) } }
                else temporary.writeBytes(item.data)
                check(temporary.renameTo(destination)) { "The draft could not be saved." }
            }
            rows.put(JSONObject().put("id", item.id).put("name", item.name).put("mime", item.mime).put("kind", item.kind.name))
        }
        val manifest = JSONObject().put("typed", typed).put("items", rows)
        if (sendId != null) manifest.put("sendId", sendId)
        if (payload != null) manifest.put("payload", payload)
        val temporary = File(dir, "draft.tmp").apply { writeText(manifest.toString()) }
        check(temporary.renameTo(File(dir, "draft.json"))) { "The draft could not be saved." }
        val keep = attachments.mapTo(mutableSetOf()) { it.id + ".media" } + "draft.json"
        dir.listFiles()?.filter { it.name !in keep }?.forEach(File::delete)
    }

    @Synchronized
    fun restore(key: String): Draft? {
        val dir = folder(key)
        val manifest = File(dir, "draft.json")
        if (!manifest.isFile || manifest.length() > 4 * 1024 * 1024) return null
        return runCatching {
            val data = JSONObject(manifest.readText())
            val rows = data.getJSONArray("items")
            require(rows.length() <= AttachmentPolicy.MAXIMUM_ITEMS)
            var totalBytes = 0L
            var bufferedBytes = 0L
            val attachments = (0 until rows.length()).map { index ->
                val item = rows.getJSONObject(index)
                val id = item.getString("id")
                require(id.matches(Regex("[a-zA-Z0-9_-]{1,128}")))
                val kind = PendingMessageAttachment.Kind.valueOf(item.getString("kind"))
                val file = File(dir, id + ".media")
                require(file.isFile && file.length() in 1..(90L * 1024 * 1024))
                totalBytes += file.length()
                require(totalBytes <= AttachmentPolicy.MAXIMUM_TOTAL_BYTES)
                if (kind == PendingMessageAttachment.Kind.IMAGE) {
                    bufferedBytes += file.length()
                    require(bufferedBytes <= AttachmentPolicy.MAXIMUM_IN_MEMORY_BYTES)
                    require(file.length() <= AttachmentPolicy.MAXIMUM_IMAGE_BYTES)
                    PendingMessageAttachment(id, file.readBytes(), item.getString("name"), item.getString("mime"), kind)
                } else PendingMessageAttachment(id = id, name = item.getString("name"), mime = item.getString("mime"), kind = kind, file = file)
            }
            AttachmentPolicy.validate(attachments)
            Draft(data.optString("typed"), data.optString("sendId").takeIf(String::isNotBlank), attachments, data.optString("payload").takeIf(String::isNotBlank))
        }.getOrNull()
    }

    @Synchronized
    fun clear(key: String) { folder(key).deleteRecursively() }

    /** Delete only app-owned imports, never an arbitrary source/picked file. */
    fun dispose(item: PendingMessageAttachment) {
        val file = item.file ?: return
        val canonical = runCatching { file.canonicalFile }.getOrNull() ?: return
        val parent = canonical.parentFile ?: return
        if (parent == imports.canonicalFile && canonical.name.startsWith("attachment-")) canonical.delete()
        else if (parent.parentFile == root.canonicalFile && parent.name.matches(Regex("[a-f0-9]{64}")) && canonical.extension == "media") canonical.delete()
    }

    /** Process death may leave an unfinished copy; saved drafts are retained. */
    @Synchronized
    fun cleanOrphans() {
        imports.listFiles()?.forEach(File::delete)
        root.listFiles()?.filter(File::isDirectory)?.forEach { dir ->
            if (!File(dir, "draft.json").isFile && dir.lastModified() < System.currentTimeMillis() - 24 * 60 * 60 * 1000L) dir.deleteRecursively()
            else dir.listFiles()?.filter { it.extension == "tmp" }?.forEach(File::delete)
        }
    }
}
