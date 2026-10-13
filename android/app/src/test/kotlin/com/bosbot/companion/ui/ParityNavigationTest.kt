package com.openmausbot.companion.ui

import com.openmausbot.companion.audio.VoiceCallTarget
import com.openmausbot.companion.core.ChatTarget
import org.junit.Assert.*
import org.junit.Test

class ParityNavigationTest {
    @Test fun voiceAuthorizationCannotBeRestoredWithNavigation() {
        val stack = listOf(Destination.Roster, Destination.VoiceCall(VoiceCallTarget("home", "bot", "thread", "bos")))
        assertEquals(listOf(Destination.Roster), CompanionNavigator.decode(CompanionNavigator.encode(stack)))
        assertEquals(listOf(Destination.Roster), CompanionNavigator.decode(listOf("roster", "voice:4:homeold")))
    }
    @Test fun duplicateBotIdsRetainTheirExplicitHomeAcrossRestoration() {
        val a = Destination.HomeChat("home:a", ChatTarget.Bot("bot:1", "thread:2"))
        val b = Destination.HomeChat("home:b", ChatTarget.Bot("bot:1", "thread:2"))
        val restored = CompanionNavigator.decode(CompanionNavigator.encode(listOf(Destination.Roster, a, b)))
        assertEquals(listOf(Destination.Roster, a, b), restored)
    }
    @Test fun browserOverlayKeepsTheExactOriginatingThreadAndHome() {
        val main = ChatTarget.Bot("same", "primary-thread")
        val secondary = ChatTarget.Bot("same", "secondary-thread")
        val navigator = CompanionNavigator(listOf(Destination.Roster, Destination.Chat(main), Destination.HomeChat("secondary", secondary)))
        assertEquals(secondary, navigator.browserChatTarget("same", "secondary"))
        assertEquals(main, navigator.browserChatTarget("same", null))
        assertNull(navigator.browserChatTarget("same", "unpaired"))
    }
    @Test fun browserAddressRetainsExactComputerWithoutFallback() {
        val source = listOf(Destination.Roster, Destination.Browser("bot", "home:two"))
        assertEquals(source, CompanionNavigator.decode(CompanionNavigator.encode(source)))
    }
}
