package com.sene.patron

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StrictIsoDateTest {
    @Test fun acceptsValidCalendarDates() {
        assertTrue(isStrictIsoDate("2026-11-13"))
        assertTrue(isStrictIsoDate("2024-02-29"))
        assertTrue(isStrictIsoDate("2000-02-29"))
    }

    @Test fun rejectsImpossibleCalendarDates() {
        assertFalse(isStrictIsoDate("2025-02-29"))
        assertFalse(isStrictIsoDate("2026-02-30"))
        assertFalse(isStrictIsoDate("2026-13-01"))
        assertFalse(isStrictIsoDate("2026-00-10"))
    }

    @Test fun rejectsNonIsoAndMalformedValues() {
        assertFalse(isStrictIsoDate("13-11-2026"))
        assertFalse(isStrictIsoDate("2026/11/13"))
        assertFalse(isStrictIsoDate("2026-1-03"))
        assertFalse(isStrictIsoDate(""))
        assertFalse(isStrictIsoDate("0000-01-01"))
    }
}