package com.openmausbot.companion.ui

import androidx.activity.compose.BackHandler
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Info
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.Card
import androidx.compose.material3.ListItem
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import com.openmausbot.companion.core.UpdateStatusResponse
import kotlinx.coroutines.CancellationException
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openmausbot.companion.R
import com.openmausbot.companion.core.ActivityDetail
import com.openmausbot.companion.core.Connection
import com.openmausbot.companion.core.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Status-first settings; security and connection controls live one level deeper. */
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenRoutines: (() -> Unit)? = null,
    onOpenConnectedApps: (() -> Unit)? = null,
    /** Offered instead of the computer's details when there is no pairing. */
    onConnect: (() -> Unit)? = null,
) {
    val environment = LocalCompanion.current
    val session = environment.session
    val connection by session.connection.collectAsState()
    val connections by session.connections.collectAsState()
    val status by session.status.collectAsState()
    val notifications by environment.notifications.access.collectAsState()
    val activityDetail by environment.chatPreferences.activityDetail.collectAsState()
    val scope = rememberCoroutineScope()
    val uriHandler = androidx.compose.ui.platform.LocalUriHandler.current
    val clipboard = LocalClipboard.current
    val haptics = rememberHaptics()

    var editingAddress by remember { mutableStateOf(false) }
    var addressText by remember { mutableStateOf("") }
    var addressError by remember { mutableStateOf<String?>(null) }
    var showingFullAddress by remember { mutableStateOf(false) }
    var addressCopied by remember { mutableStateOf(false) }
    var reconnecting by remember { mutableStateOf(false) }
    var confirmingUnpair by remember { mutableStateOf(false) }
    var pendingComputerRemoval by remember { mutableStateOf<Connection?>(null) }
    var choosingActivity by remember { mutableStateOf(false) }
    var editingQuickReplies by remember { mutableStateOf(false) }
    var showingComputerDetails by remember { mutableStateOf(false) }
    var showingComputerSecurity by remember { mutableStateOf(false) }
    var showingAppearance by remember { mutableStateOf(false) }
    var showingProviderUsage by remember { mutableStateOf(false) }
    var showingSettlement by remember { mutableStateOf(false) }
    var choosingIntro by remember { mutableStateOf(false) }
    var choosingLanguage by remember { mutableStateOf(false) }
    val intro by environment.chatPreferences.introAnimationPolicy.collectAsState()
    val brightness by environment.chatPreferences.brightness.collectAsState()
    val language by environment.chatPreferences.language.collectAsState()
    val context = LocalContext.current
    var feedbackError by remember { mutableStateOf<String?>(null) }
    var updateStatus by remember(connection?.id) { mutableStateOf<UpdateStatusResponse?>(null) }
    var updateLoaded by remember(connection?.id) { mutableStateOf(false) }

    BackHandler(enabled = showingAppearance || showingProviderUsage || showingSettlement || showingComputerDetails) {
        when { showingAppearance -> showingAppearance = false; showingProviderUsage -> showingProviderUsage = false; showingSettlement -> showingSettlement = false; showingComputerSecurity -> showingComputerSecurity = false; else -> showingComputerDetails = false }
    }
    if (showingAppearance) { AppearanceScreen(onBack = { showingAppearance = false }); return }
    if (showingProviderUsage) { ProviderUsageScreen(onBack = { showingProviderUsage = false }); return }
    if (showingSettlement) { InboxSettlementScreen(onBack = { showingSettlement = false }); return }
    LaunchedEffect(connection?.id, showingComputerDetails) {
        if (connection == null || showingComputerDetails) return@LaunchedEffect
        while (true) {
            updateStatus = session.loadUpdateStatus()
            updateLoaded = true
            delay(if (updateStatus?.isRunning == true) 2_000 else 30_000)
        }
    }



    Column(modifier = Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            HeaderBackButton(onBack = { if (showingComputerSecurity) showingComputerSecurity = false else if (showingComputerDetails) showingComputerDetails = false else onBack() })
            Text(if (showingComputerSecurity) "Connection security" else if (showingComputerDetails) "Connected computers" else "Settings", fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        }
        HorizontalDivider()
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            if (showingComputerDetails) {
                SettingsSection("Current computer") {
                    connection?.let { bound ->
                        if (!showingComputerSecurity) SettingsLink(bound.name, SettingsPolicy.statusText(status)) { showingComputerSecurity = true }
                        else {
                        SettingsRow("Name", bound.name)
                        SettingsRow("Connection", SettingsPolicy.statusText(status))
                        val address = SettingsPolicy.addressText(bound)
                        AddressRow(address, showingFullAddress, addressCopied, { showingFullAddress = !showingFullAddress }, {
                            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(ADDRESS_CLIP_LABEL, address))); addressCopied = true; delay(COPIED_LABEL_MILLIS); addressCopied = false }
                        })
                        SettingsButton("Edit address") { addressText = address; addressError = null; editingAddress = true }
                        }
                    }
                }
                val otherComputers = connections.filter { it.id != connection?.id }
                if (!showingComputerSecurity && otherComputers.isNotEmpty()) SettingsSection("Other computers") {
                    otherComputers.forEach { computer ->
                        SettingsButton("${computer.name} · Make main") { haptics.play(TactileAction.SWITCH_COMPUTER); session.switchComputer(computer.id) }
                        SettingsButton("Remove ${computer.name}", destructive = true) { pendingComputerRemoval = computer }
                    }
                }
                if (!showingComputerSecurity) SettingsSection(null) {
                    SettingsButton("Connect another computer") { haptics.play(TactileAction.CONNECT_ANOTHER_COMPUTER); session.beginPairing() }
                    Footnote("Every computer is paired separately. Switching the main computer keeps its own saved pairing.")
                }
                if (showingComputerSecurity) SettingsSection("Troubleshooting") {
                    Footnote(troubleshootingText(status))
                    SettingsButton("Try reconnecting", enabled = !reconnecting, trailing = { if (reconnecting) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) }) {
                        scope.launch { reconnecting = true; try { session.refresh() } finally { reconnecting = false } }
                    }
                }
                if (showingComputerSecurity && connection != null) SettingsSection(null) {
                    SettingsButton(if (connections.size > 1) "Remove this computer" else "Unpair this phone", destructive = true) { confirmingUnpair = true }
                    Footnote(SettingsPolicy.UNPAIR_FOOTER)
                }
            } else {
                SettingsSection("Computer") {
                    SettingsLink(connection?.name ?: "Connect a computer", SettingsPolicy.statusText(status), enabled = connection != null || onConnect != null) {
                        if (connection != null) showingComputerDetails = true else onConnect?.invoke()
                    }
                }
                SettingsSection("This phone") {
                    SettingsRow("BOS Android", remember(context) { @Suppress("DEPRECATION") context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "Unknown" })
                    SettingsButton("Download the latest Android app") { uriHandler.openUri("https://bos.aihlete.com/dl/BOS-Bot-android.apk") }
                }
                if (connection != null) {
                    SettingsSection("BOS updates") {
                        SettingsRow(updateStatus?.let { "BOS ${it.current.version}" } ?: "BOS", updateStatus?.summary ?: if (updateLoaded) "Unavailable on this computer" else "Checking…")
                        if (updateStatus?.isRunning == true) CircularProgressIndicator(Modifier.size(18.dp))
                        Footnote("Updates install on your computer from BOS → Settings → Updates. Working bots pause and pick up where they left off.")
                    }
                    SettingsSection("Subscription limits") { SettingsLink("Claude & Codex") { showingProviderUsage = true } }
                }
                SettingsSection(null) {
                    SettingsLink("Notifications", NotificationPermissionController.statusText(notifications), enabled = NotificationPermissionController.buttonEnabled(notifications)) { environment.notifications.act() }
                    Footnote("Alerts arrive while BOS is open or was recently in the background. Enable Background connection for closed-app delivery on Android.")
                }
                SettingsSection("Chat") {
                    SettingsLink("Activity", activityDetail.label) { choosingActivity = true }
                    SettingsLink("Intro animation", introLabel(intro)) { choosingIntro = true }
                    SettingsLink("Quick Replies") { editingQuickReplies = true }
                    Footnote(activityDetail.caption)
                }
                SettingsSection("Display") {
                    SettingsLink("Appearance", when (brightness) { "light" -> "Light"; "dark" -> "Dark"; else -> "Automatic" }) { showingAppearance = true }
                    SettingsLink("Language", languageLabel(language)) { choosingLanguage = true }
                    Footnote("Automatic appearance follows this device's display setting. Language changes inside BOS; Android buttons follow the device language.")
                }
                if (connection != null) SettingsSection("Workspace") {
                    SettingsLink("Inbox settlement") { showingSettlement = true }
                    onOpenRoutines?.let { SettingsLink("Threads & Routines", onClick = it) }
                    if (connection?.canAdminister == true) onOpenConnectedApps?.let { SettingsLink("Connected Apps", onClick = it) }
                }
                SettingsSection("Background connection") {
                    val alwaysOnEnabled by environment.alwaysOnEnabled.collectAsState()
                    SettingsLink("Status", if (alwaysOnEnabled) "Always on" else "Only while open", onClick = environment.onToggleAlwaysOn)
                    Footnote("Always on keeps a low-priority notification so routine results reach you with the app closed. It uses a little more battery.")
                }
                SettingsSection("Help & feedback") {
                    SettingsLink("Contact BOS", "ferazfhansurie@gmail.com") {
                        try { context.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:ferazfhansurie@gmail.com?subject=BOS%20alpha%20feedback"))); feedbackError = null }
                        catch (error: android.content.ActivityNotFoundException) { feedbackError = "No email app available. Contact ferazfhansurie@gmail.com." }
                    }
                    feedbackError?.let { Footnote(it) }
                    Footnote("For help, alpha feedback or privacy requests: ferazfhansurie@gmail.com")
                    Footnote("Include your app version and steps to reproduce. Please leave out passwords, keys and private conversations.")
                    val appVersion = remember(context) { @Suppress("DEPRECATION") val info = context.packageManager.getPackageInfo(context.packageName, 0); "BOS ${info.versionName} (${info.longVersionCode})" }
                    Footnote(appVersion)
                }
            }
        }
    }
    if (choosingIntro) SettingsChoiceDialog("Intro animation", intro, listOf("always" to "Always", "oncePerBot" to "First time per bot", "never" to "Never"), { environment.chatPreferences.setIntroAnimationPolicy(it); choosingIntro = false }, { choosingIntro = false })
    if (choosingLanguage) SettingsChoiceDialog("Language", language, listOf("system" to "Follow the system", "en" to "English", "pt-BR" to "Português (Brasil)"), { environment.chatPreferences.setLanguage(it); choosingLanguage = false }, { choosingLanguage = false })

    if (editingAddress) {
        AlertDialog(
            onDismissRequest = { editingAddress = false },
            title = { Text(localized("Edit address")) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(SettingsPolicy.EDIT_ADDRESS_MESSAGE, fontSize = 14.sp)
                    OutlinedTextField(
                        value = addressText,
                        onValueChange = {
                            addressText = it
                            addressError = null
                        },
                        placeholder = { Text(localized("https://mac.example or 192.168.1.42:8810")) },
                        singleLine = true,
                        isError = addressError != null,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    addressError?.let {
                        Text(it, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        // Session re-parses, re-dials and persists; the walk and
                        // promote semantics stay its job. The form only refuses
                        // what it can already tell is not an address.
                        if (session.updateAddress(addressText)) {
                            editingAddress = false
                        } else {
                            addressError = AddressEdit.INVALID
                        }
                    },
                ) { Text(localized("Save")) }
            },
            dismissButton = {
                TextButton(onClick = { editingAddress = false }) { Text(localized("Cancel")) }
            },
        )
    }

    if (confirmingUnpair) {
        AlertDialog(
            onDismissRequest = { confirmingUnpair = false },
            title = { Text(if (connections.size > 1) "Remove ${connection?.name}?" else SettingsPolicy.UNPAIR_CONFIRM_TITLE) },
            text = {
                Text(
                    if (connections.size > 1) {
                        "This removes the saved connection from this phone only. Another saved computer will stay available."
                    } else {
                        SettingsPolicy.UNPAIR_CONFIRM_MESSAGE
                    },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingUnpair = false
                        // Local token and connection only. Revoking the device
                        // itself is Settings → Phone on the computer (§6).
                        session.signOut()
                    },
                ) {
                    // With another computer saved this removes one of them; the
                    // phone stays paired, so "Unpair" would be the wrong promise.
                    Text(
                        text = if (connections.size > 1) "Remove" else "Unpair",
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingUnpair = false }) { Text(localized("Cancel")) }
            },
        )
    }

    pendingComputerRemoval?.let { computer ->
        AlertDialog(
            onDismissRequest = { pendingComputerRemoval = null },
            title = { Text(localized("Remove ${computer.name}?")) },
            text = { Text(localized("This removes the saved connection from this phone only.")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingComputerRemoval = null
                        session.forgetConnection(computer.id)
                    },
                ) { Text(localized("Remove"), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { pendingComputerRemoval = null }) { Text(localized("Cancel")) }
            },
        )
    }

    if (choosingActivity) {
        AlertDialog(
            onDismissRequest = { choosingActivity = false },
            title = { Text(localized("Activity detail")) },
            text = {
                // iOS draws a Picker (SettingsView.swift:67-78), which marks the
                // choice already in force; three plain buttons do not.
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    ActivityDetail.entries.forEach { detail ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = MIN_TOUCH_TARGET)
                                .selectable(
                                    selected = detail == activityDetail,
                                    role = Role.RadioButton,
                                    onClick = {
                                        environment.chatPreferences.setActivityDetail(detail)
                                        choosingActivity = false
                                    },
                                )
                                .padding(vertical = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = detail == activityDetail, onClick = null)
                            Column(modifier = Modifier.weight(1f)) {
                                Text(detail.label, textAlign = TextAlign.Start)
                                Text(detail.caption, fontSize = 12.sp, color = secondaryTint)
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosingActivity = false }) { Text(localized("Cancel")) } },
        )
    }

    if (editingQuickReplies) {
        QuickRepliesEditor(
            preferences = environment.chatPreferences,
            onDismiss = { editingQuickReplies = false },
        )
    }
}

@Composable
private fun SettingsSection(title: String?, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        title?.let {
            Text(
                text = it.uppercase(),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = secondaryTint,
            )
        }
        HorizontalDivider()
        content()
    }
}

@Composable
private fun SettingsRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(label, fontSize = 15.sp, color = secondaryTint)
        Text(
            text = value,
            fontSize = 15.sp,
            textAlign = TextAlign.End,
            modifier = Modifier
                .weight(1f)
                .padding(start = 12.dp),
        )
    }
}

/**
 * The address, short enough to read at a glance and long enough to copy — the
 * port of the connection details in `ios/App/SettingsView.swift:346-371`.
 */
@Composable
private fun AddressRow(
    address: String,
    expanded: Boolean,
    copied: Boolean,
    onToggle: () -> Unit,
    onCopy: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(localized("Address"), fontSize = 15.sp, color = secondaryTint)
        if (expanded) {
            // Selectable, because the reason to show it in full is to take it away.
            SelectionContainer {
                Text(
                    text = address,
                    fontSize = 13.sp,
                    fontFamily = FontFamily.Monospace,
                    color = secondaryTint,
                )
            }
        } else {
            Text(
                text = shortenedAddress(address),
                fontSize = 13.sp,
                fontFamily = FontFamily.Monospace,
                color = secondaryTint,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = onToggle) {
                Text(if (expanded) "Hide full address" else "Show full address")
            }
            TextButton(onClick = onCopy) {
                Text(if (copied) "Copied" else "Copy")
            }
        }
    }
}

@Composable
private fun SettingsButton(
    text: String,
    enabled: Boolean = true,
    destructive: Boolean = false,
    icon: Int? = null,
    /** Drawn at the end of the row — a progress indicator while one is running. */
    trailing: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    val tint = if (destructive) {
        MaterialTheme.colorScheme.error
    } else {
        MaterialTheme.colorScheme.primary
    }
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH_TARGET),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            icon?.let {
                Icon(
                    painter = painterResource(it),
                    contentDescription = null,
                    tint = tint,
                    modifier = Modifier.size(20.dp),
                )
            }
            Text(
                text = text,
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Start,
                color = tint,
            )
            trailing?.invoke()
        }
    }
}

@Composable
private fun Footnote(text: String) {
    Text(text = text, fontSize = 13.sp, color = secondaryTint)
}

private const val ADDRESS_CLIP_LABEL = "BosBot computer address"

/** Long enough for "Copied" to be read, short enough not to linger (iOS `:363-367`). */
private const val COPIED_LABEL_MILLIS = 2_000L

/**
 * What the Troubleshooting section says before offering to reconnect — the port
 * of `ConnectionSecurityView.troubleshootingText` (`ios/App/SettingsView.swift:445-458`).
 */
internal fun troubleshootingText(status: Session.Status): String = when (status) {
    Session.Status.Live -> "This computer is connected and responding normally."
    Session.Status.Connecting -> "BOS Bot is trying the saved connection automatically."
    Session.Status.Unauthorized -> "This phone was removed from the computer. Pair it again to reconnect."
    Session.Status.Unpaired -> "This phone is not paired with a computer."
    is Session.Status.Offline -> status.message
}

/**
 * The address with its middle taken out, so a long tailnet name still shows the
 * host and the port it ends in — `shortened` in `ios/App/SettingsView.swift:460-464`.
 */
internal fun shortenedAddress(address: String): String {
    if (address.length <= 14) return address
    val leading = minOf(20, maxOf(8, address.length - 8))
    return address.take(leading) + "…" + address.takeLast(6)
}
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data

@Composable
private fun SettingsLink(title: String, value: String? = null, enabled: Boolean = true, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick)) {
        ListItem(headlineContent = { Text(title) }, leadingContent = { SettingsGlyph(title) }, supportingContent = value?.let { { Text(it) } }, trailingContent = { Text(localized("›"), color = secondaryTint) })
    }
}
@Composable
private fun SettingsChoiceDialog(title: String, selected: String, choices: List<Pair<String, String>>, onChoose: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title) }, text = { Column {
        choices.forEach { (value, label) -> Row(Modifier.fillMaxWidth().heightIn(min = MIN_TOUCH_TARGET).selectable(selected = value == selected, role = Role.RadioButton, onClick = { onChoose(value) }), verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected = value == selected, onClick = null); Text(label)
        } }
    } }, confirmButton = {}, dismissButton = { TextButton(onClick = onDismiss) { Text(localized("Cancel")) } })
}
private fun introLabel(value: String) = when(value) { "always" -> "Always"; "never" -> "Never"; else -> "First time per bot" }
private fun languageLabel(value: String) = when(value) { "en" -> "English"; "pt-BR" -> "Português (Brasil)"; else -> "Follow the system" }

@Composable
private fun SettingsGlyph(title: String) {
    val color = Color(when(title) {
        "Notifications" -> 0xFFE54B4B; "Activity" -> 0xFF9C67D9; "Intro animation" -> 0xFFE272AA
        "Quick Replies" -> 0xFFE1B846; "Appearance" -> 0xFF677DDB; "Language" -> 0xFF49AFA9
        "Claude & Codex" -> 0xFF4BAD72; "Threads & Routines" -> 0xFFE29B45
        "Inbox settlement" -> 0xFF888D98; else -> 0xFF5B93DB
    })
    Box(Modifier.size(30.dp).background(color, RoundedCornerShape(7.dp)), contentAlignment = Alignment.Center) {
        val vector = when(title) { "Notifications" -> Icons.Filled.Notifications; "Activity" -> Icons.Filled.Build; "Contact BOS" -> Icons.Filled.Email; "Appearance" -> Icons.Filled.Settings; "Language" -> Icons.Filled.Info; else -> null }
        if (vector != null) Icon(vector, null, tint = Color.White, modifier = Modifier.size(18.dp))
        else Icon(painterResource(when(title) { "Intro animation" -> R.drawable.ic_sparkles; "Quick Replies" -> R.drawable.ic_chat_bubbles; "Threads & Routines", "Claude & Codex" -> R.drawable.ic_schedule; "Connected Apps" -> R.drawable.ic_hub; "Inbox settlement" -> R.drawable.ic_chat_bubbles; else -> R.drawable.ic_display }), null, tint = Color.White, modifier = Modifier.size(18.dp))
    }
}
