package com.openmausbot.companion.ui

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class GlyphParityTest {
    @Test fun shippedGlyphTableIsByteIdenticalToCanonicalIOSAndDesktopSource() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val source = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "shared/glyph-faces.json") }.first { it.isFile }
        assertArrayEquals(source.readBytes(), context.assets.open("glyph-faces.json").use { it.readBytes() })
    }
    @Test fun unknownLegacyBodyFallsBackToFlatCircleAndAllFortyBodiesLoad() {
        val art = GlyphArtwork.load(ApplicationProvider.getApplicationContext())
        assertEquals("circle", art.bodyKey(null))
        assertEquals("circle", art.bodyKey("unshipped-future-body"))
        assertEquals("hexagon", art.bodyKey("shield"))
        assertEquals(40, art.bodies.size)
        assertEquals("#009957", art.palette.getString("green"))
    }
}
