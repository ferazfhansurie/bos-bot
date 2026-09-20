package com.openmausbot.companion.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertSame
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The body catalog and the parser that turns it into geometry — the port of
 * `ios/Tests/CompanionCoreTests/MausBodiesTests.swift`.
 *
 * The silhouette used to be one hand-copied path. It is now ten generated ones,
 * so a body that parses to nothing, or lands outside the face box the face is
 * anchored in, has to fail here rather than on someone's phone.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MausBodiesTest {

    @Test
    fun `every body parses to a closed path inside the face box`() {
        for (id in MausBodies.order) {
            val path = MausSilhouette.inFaceBox(id)
            assertFalse(path.isEmpty, "$id parsed to nothing")
            val bounds = MausSilhouette.faceBoxBounds(id)
            assertTrue(bounds.width > 0f, "$id has no width")
            assertTrue(bounds.height > 0f, "$id has no height")
            assertTrue(bounds.left >= -1f, "$id overflows the face box to the left")
            assertTrue(bounds.top >= -1f, "$id overflows the face box above")
            assertTrue(bounds.right <= MausSilhouette.FACE_BOX + 1f, "$id overflows the face box to the right")
            assertTrue(bounds.bottom <= MausSilhouette.FACE_BOX + 1f, "$id overflows the face box below")
            // The catalog's tight bounds sit inside the parsed path's control hull,
            // which is what proves they describe this path and not another.
            val hull = path.getBounds()
            assertTrue(hull.left <= bounds.left + 0.5f && hull.right >= bounds.right - 0.5f, "$id bounds do not match its path")
            assertTrue(hull.top <= bounds.top + 0.5f && hull.bottom >= bounds.bottom - 0.5f, "$id bounds do not match its path")
        }
    }

    @Test
    fun `an unknown body falls back to the cursor`() {
        assertEquals("cursor", MausBodies.body("hexagram").id)
        assertEquals("cursor", MausBodies.body(null).id)
        assertEquals("cursor", MausBodies.body("").id)
        assertEquals(MausBodies.DEFAULT_ID, MausSilhouette.defaultBody)
    }

    /**
     * An unrecognised id must reach the *drawn* geometry as the cursor too, not
     * just as a catalog entry — the fallback is only useful if the paint path
     * honours it.
     */
    @Test
    fun `an unknown body draws the cursor`() {
        assertEquals(MausSilhouette.faceBoxBounds("cursor"), MausSilhouette.faceBoxBounds("hexagram"))
        assertEquals(MausSilhouette.faceBoxBounds("cursor"), MausSilhouette.faceBoxBounds(null))
        assertEquals(MausSilhouette.anchor("cursor"), MausSilhouette.anchor("hexagram"))
        assertSame(MausSilhouette.inFaceBox("cursor"), MausSilhouette.inFaceBox(null))
    }

    @Test
    fun `every anchor places a face inside its body`() {
        for (id in MausBodies.order) {
            val anchor = MausSilhouette.anchor(id)
            assertTrue(anchor.scale > 0f, "$id has no face")
            assertTrue(anchor.scale <= 1f, "$id inflates the face")
            val bounds = MausSilhouette.faceBoxBounds(id)
            assertTrue(anchor.x in bounds.left - 1f..bounds.right + 1f, "$id anchors its face outside its own body")
            assertTrue(anchor.y in bounds.top - 1f..bounds.bottom + 1f, "$id anchors its face outside its own body")
        }
    }

    @Test
    fun `every body wears the same size face`() {
        // The generator clamps the catalog to the smallest face any body can hold,
        // so the mascot reads as one character in different bodies.
        val scales = MausBodies.order.map { MausSilhouette.anchor(it).scale }.toSet()
        assertEquals(1, scales.size, "face scales differ across bodies: $scales")
    }

    @Test
    fun `the parser understands the catalog's path grammar`() {
        // A unit square drawn with degenerate curves: four `C` segments in one
        // command, the form the generated catalog actually emits.
        val square = MausSilhouette.parse(
            """
            M0 0 C0 0 10 0 10 0 C10 0 10 10 10 10
            C10 10 0 10 0 10 C0 10 0 0 0 0Z
            """,
        ).getBounds()
        assertEquals(0f, square.left, 0.0001f)
        assertEquals(0f, square.top, 0.0001f)
        assertEquals(10f, square.right, 0.0001f)
        assertEquals(10f, square.bottom, 0.0001f)
        // Negative numbers and exponents both appear in the cursor path.
        val negative = MausSilhouette.parse("M-2.5 0 C-2.5 0 1e1 -5 10 -5Z").getBounds()
        assertEquals(-2.5f, negative.left, 0.0001f)
        assertEquals(-5f, negative.top, 0.0001f)
    }

    /**
     * The cache exists because a roster redraws hundreds of avatars per frame and
     * the parser is a character scanner over a four-kilobyte string. The same
     * instance proves the second call did not re-parse; distinct instances
     * across ids prove it is per body.
     */
    @Test
    fun `each body is parsed once and cached separately`() {
        for (id in MausBodies.order) {
            assertSame(MausSilhouette.inFaceBox(id), MausSilhouette.inFaceBox(id), "$id was parsed twice")
        }
        assertNotSame(MausSilhouette.inFaceBox("cursor"), MausSilhouette.inFaceBox("star"))
    }
}
