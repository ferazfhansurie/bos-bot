package com.openmausbot.companion.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ThemeBubbleParityTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @Test fun sakuraColoursTheComposerAndBothBubbleFillsLikeIOS() {
        var mine = Color.Unspecified; var theirs = Color.Unspecified
        compose.setContent { CompanionTheme(darkTheme = false, theme = "pink") {
            val myFill = BubbleColor.mine; val botFill = BubbleColor.theirs
            SideEffect { mine = myFill; theirs = botFill }
        } }
        compose.runOnIdle { assertEquals(0xFFC2185B.toInt(), mine.toArgb()); assertEquals(0xFFF2DDE5.toInt(), theirs.toArgb()) }
    }
    @Test fun classicKeepsItsBlueAndDarkGrey() {
        var mine = Color.Unspecified; var theirs = Color.Unspecified
        compose.setContent { CompanionTheme(darkTheme = true) {
            val myFill = BubbleColor.mine; val botFill = BubbleColor.theirs
            SideEffect { mine = myFill; theirs = botFill }
        } }
        compose.runOnIdle { assertEquals(0xFF377FE6.toInt(), mine.toArgb()); assertEquals(0xFF262629.toInt(), theirs.toArgb()) }
    }
}
