package com.openmausbot.companion.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.openmausbot.companion.avatar.AvatarImagePicker
import com.openmausbot.companion.avatar.PreparedAvatar
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

@Composable
internal fun PersonalProfileScreen(onClose: () -> Unit, onOpenSettings: () -> Unit, onPhotoChanged: (String) -> Unit) {
    val context = LocalContext.current
    val session = LocalCompanion.current.session
    val connection by session.connection.collectAsState()
    val preferences = remember(context.applicationContext) { context.getSharedPreferences("personal-profile", android.content.Context.MODE_PRIVATE) }
    var photo by remember(connection?.id) { mutableStateOf(preferences.getString("${connection?.id.orEmpty()}.photo", "").orEmpty()) }
    var pickerConnectionId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun save(encoded: String?) {
        val id = connection?.id
        busy = true; error = null
        try {
            session.setProfilePhoto(encoded, id)
            if (id != session.connection.value?.id) return
            photo = encoded.orEmpty(); preferences.edit().putString("$id.photo", photo).commit(); onPhotoChanged(photo)
        } catch (exception: CancellationException) { throw exception
        } catch (exception: Exception) { error = exception.message ?: "Couldn't save your photo. Try again." }
        finally { busy = false }
    }
    val picker = rememberLauncherForActivityResult(remember { AvatarImagePicker.contract() }) { uri ->
        if (uri != null && !busy) scope.launch {
            val pickedFor = pickerConnectionId
            if (pickedFor != session.connection.value?.id) { error = "The computer changed. Choose the photo again."; return@launch }
            busy = true; error = null
            try {
                val encoded = withContext(Dispatchers.IO) {
                    val prepared = AvatarImagePicker.read(context.contentResolver, uri)
                    require(prepared is PreparedAvatar.Ready) { (prepared as PreparedAvatar.Rejected).message }
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(prepared.data, 0, prepared.data.size, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "That photo couldn't be read. Try another one." }
                    val sample = BitmapFactory.Options().apply { inSampleSize = 1; while (maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > 512) inSampleSize *= 2 }
                    val decoded = requireNotNull(BitmapFactory.decodeByteArray(prepared.data, 0, prepared.data.size, sample))
                    val ratio = minOf(1f, 256f / decoded.width, 256f / decoded.height)
                    val thumbnail = Bitmap.createScaledBitmap(decoded, maxOf(1, (decoded.width * ratio).toInt()), maxOf(1, (decoded.height * ratio).toInt()), true)
                    val bytes = ByteArrayOutputStream().also { thumbnail.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()
                    if (thumbnail !== decoded) thumbnail.recycle(); decoded.recycle()
                    Base64.encodeToString(bytes, Base64.NO_WRAP)
                }
                if (pickedFor != session.connection.value?.id) throw IllegalStateException("The computer changed. Choose the photo again.")
                save(encoded)
            } catch (exception: CancellationException) { throw exception
            } catch (exception: Exception) { error = exception.message ?: "That photo couldn't be read. Try another one." }
            finally { busy = false }
        }
    }
    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) { Text(localized("Your profile"), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge); TextButton(enabled = !busy, onClick = onClose) { Text(localized("Done")) } }
        val bitmap = remember(photo) { personalPhotoBitmap(photo) }
        if (bitmap != null) Image(bitmap.asImageBitmap(), "Your profile photo", Modifier.size(64.dp).clip(CircleShape)) else ProfileAvatar(connection?.name ?: "You", 64.dp)
        TextButton(enabled = !busy && connection != null, onClick = { pickerConnectionId = connection?.id; picker.launch(AvatarImagePicker.request()) }) { Text(localized("Change profile photo")) }
        if (photo.isNotEmpty()) TextButton(enabled = !busy, onClick = { scope.launch { save(null) } }) { Text(localized("Remove photo"), color = MaterialTheme.colorScheme.error) }
        if (busy) CircularProgressIndicator(Modifier.size(20.dp))
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        HorizontalDivider()
        TextButton(onClick = onOpenSettings) { Text(localized("Settings & computers")) }
    }
}
internal fun personalPhotoBitmap(encoded: String): Bitmap? = if (encoded.length > 1024 * 1024) null else runCatching {
    val bytes = Base64.decode(encoded, Base64.DEFAULT)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth !in 1..512 || bounds.outHeight !in 1..512) null else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
}.getOrNull()
