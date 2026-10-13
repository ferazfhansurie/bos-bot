package com.openmausbot.companion.audio

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.openmausbot.companion.MainActivity

/** Notification clicks open the existing server-stamped ring; extras cannot start a call. */
object VoiceRingNotifications {
    fun cancel(context: Context, ringId: String) { context.getSystemService(NotificationManager::class.java).cancel(ringId.hashCode()) }
    fun post(context: Context, ring: IncomingVoiceCall) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("bos-calls", "Bot calls", NotificationManager.IMPORTANCE_HIGH))
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, ring.ringId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.notify(ring.ringId.hashCode(), NotificationCompat.Builder(context, "bos-calls")
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle("${ring.target.botName} is calling").setContentText(ring.reason)
            .setContentIntent(pending).setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true).setTimeoutAfter(30_000).build())
    }
}
