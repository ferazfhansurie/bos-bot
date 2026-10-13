package com.openmausbot.companion.ui

import com.openmausbot.companion.core.AvatarCrop

internal object ProfileSheetPolicy {
    fun hasUnsavedIdentity(form: ProfileForm, baseline: ProfileForm): Boolean =
        form.name != baseline.name || form.title != baseline.title || form.description != baseline.description || form.notifications != baseline.notifications
    fun generatedCrop(start: AvatarCrop, latest: AvatarCrop, server: AvatarCrop?): AvatarCrop =
        if (start != latest) latest else server ?: AvatarCrop.CIRCLE
    fun chatterboxAddressValid(value: String): Boolean = value.trim().let { it.startsWith("http://") || it.startsWith("https://") }
}
