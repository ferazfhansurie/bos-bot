package com.openmausbot.companion.audio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Started exclusively by a visible user microphone action, before opening the microphone. */
class MicrophoneService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var generation: Long? = null
    private var startupFailed = false
    override fun onCreate() {
        super.onCreate()
        val notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(NotificationChannel(CHANNEL, "Voice and recordings", NotificationManager.IMPORTANCE_LOW))
        val open = packageManager.getLaunchIntentForPackage(packageName)
        val stop = PendingIntent.getService(this, 2, Intent(this, MicrophoneService::class.java).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("BOS microphone active").setContentText("Recording or voice call in progress")
            .setOngoing(true).addAction(Notification.Action.Builder(null, "Stop microphone", stop).build())
        if (open != null) builder.setContentIntent(PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(ID, builder.build())
            wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:audio").apply { acquire() }
            mutable.value = true
        } catch (_: Exception) {
            startupFailed = true
            stopSelf()
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            // The user explicitly stopped the microphone: all owners stop, including a replacement.
            synchronized(sessions) { currentGeneration++ }
            stopSessions(null)
            stopSelf()
            return START_NOT_STICKY
        }
        val requested = intent?.getLongExtra(GENERATION, -1L)?.takeIf { it >= 0 } ?: return START_NOT_STICKY
        if (generation == null) {
            generation = requested
            synchronized(sessions) { activeGeneration = requested; mutable.value = !startupFailed }
        }
        // An intent for a replacement belongs to the replacement service instance, never this retired one.
        if (generation != requested) return START_NOT_STICKY
        if (startupFailed) { stopSessions(requested); retireGeneration(); stopSelf() }
        return START_NOT_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        synchronized(sessions) { if (activeGeneration == generation) { activeGeneration = null; mutable.value = false } }
        wake?.let { if (it.isHeld) it.release() }; wake = null
        generation?.let { stopSessions(it) }
        retireGeneration()
        super.onDestroy()
    }
    private fun retireGeneration() {
        synchronized(sessions) {
            if (generation != null && currentGeneration == generation) currentGeneration++
        }
    }
    companion object {
        private const val CHANNEL = "bos-microphone"
        private const val ID = 8712
        private const val STOP = "bos.audio.stop"
        private val mutable = MutableStateFlow(false)
        val running = mutable.asStateFlow()
        private const val GENERATION = "bos.audio.generation"
        private data class Lease(val generation: Long, val stop: () -> Unit)
        private val sessions = linkedMapOf<String, Lease>()
        private var currentGeneration = 0L
        private var activeGeneration: Long? = null
        /** Android 14 while-in-use permissions forbid starting this from a background callback. */
        fun acquire(context: Context, owner: String, stop: () -> Unit) {
            check(ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                "Open the app and tap record or call to start the microphone"
            }
            val lease = synchronized(sessions) {
                check(sessions.isEmpty() || sessions.containsKey(owner)) { "Another recording or call already owns the microphone" }
                Lease(currentGeneration, stop).also { sessions[owner] = it }
            }
            try { ContextCompat.startForegroundService(context, Intent(context, MicrophoneService::class.java).putExtra(GENERATION, lease.generation)) }
            catch (failure: Exception) { synchronized(sessions) { if (sessions[owner] === lease) sessions.remove(owner) }; throw failure }
        }
        fun release(context: Context, owner: String) {
            val empty = synchronized(sessions) {
                val removed = sessions.remove(owner)
                if (removed != null && sessions.isEmpty()) {
                    // Retire before requesting asynchronous destruction, so a new acquire receives another generation.
                    if (currentGeneration == removed.generation) currentGeneration++
                    true
                } else false
            }
            if (empty) context.stopService(Intent(context, MicrophoneService::class.java))
        }
        private fun stopSessions(generation: Long?) {
            val callbacks = synchronized(sessions) {
                val stopping = sessions.filterValues { generation == null || it.generation == generation }
                stopping.keys.forEach { sessions.remove(it) }
                stopping.values.map { it.stop }
            }
            callbacks.forEach { runCatching(it) }
        }
    }
}
