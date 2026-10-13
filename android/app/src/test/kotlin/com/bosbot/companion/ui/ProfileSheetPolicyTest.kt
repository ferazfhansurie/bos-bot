package com.openmausbot.companion.ui

import com.openmausbot.companion.core.AvatarCrop
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertFalse

class ProfileSheetPolicyTest {
    private val baseline = ProfileForm("bot", "builder", "builds", true, AvatarCrop.MASCOT, "", false)
    @Test fun `identity edits require a save or discard decision`() {
        assertFalse(ProfileSheetPolicy.hasUnsavedIdentity(baseline, baseline))
        listOf(baseline.copy(name = " bot"), baseline.copy(title = "new"), baseline.copy(description = "new"), baseline.copy(notifications = false)).forEach { assertTrue(ProfileSheetPolicy.hasUnsavedIdentity(it, baseline)) }
        assertFalse(ProfileSheetPolicy.hasUnsavedIdentity(baseline.copy(crop = AvatarCrop.CIRCLE, voice = "voice", speakReplies = true), baseline))
    }
    @Test fun `generated image uses server crop unless the picker moved during generation`() {
        assertEquals(AvatarCrop.CIRCLE, ProfileSheetPolicy.generatedCrop(AvatarCrop.MASCOT, AvatarCrop.MASCOT, AvatarCrop.CIRCLE))
        assertEquals(AvatarCrop.CIRCLE, ProfileSheetPolicy.generatedCrop(AvatarCrop.MASCOT, AvatarCrop.MASCOT, null))
        assertEquals(AvatarCrop.SQUARE, ProfileSheetPolicy.generatedCrop(AvatarCrop.MASCOT, AvatarCrop.SQUARE, AvatarCrop.CIRCLE))
        assertEquals(AvatarCrop.MASCOT, ProfileSheetPolicy.generatedCrop(AvatarCrop.CIRCLE, AvatarCrop.MASCOT, AvatarCrop.ROUNDED))
    }
    @Test fun `server addresses require an explicit http scheme`() {
        assertTrue(ProfileSheetPolicy.chatterboxAddressValid(" http://127.0.0.1:4123 "))
        assertTrue(ProfileSheetPolicy.chatterboxAddressValid("https://voice.example"))
        assertFalse(ProfileSheetPolicy.chatterboxAddressValid("127.0.0.1:4123"))
        assertFalse(ProfileSheetPolicy.chatterboxAddressValid("javascript:alert(1)"))
    }
}
