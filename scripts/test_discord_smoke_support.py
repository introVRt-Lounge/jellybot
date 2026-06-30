#!/usr/bin/env python3
"""Unit tests for discord_smoke_support log correlation."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from discord_smoke_support import (
    assess_quote_autocomplete_logs,
    assess_quote_series_autocomplete_logs,
    parse_json_log_events,
)


class QuoteAutocompleteLogAssessmentTests(unittest.TestCase):
    def test_passes_when_responded_follows_search(self) -> None:
        events = [
            {
                "event": "quote.autocomplete",
                "interactionId": "111",
                "query": "carrot",
                "resultCount": 25,
            },
            {
                "event": "quote.autocomplete.responded",
                "query": "carrot",
                "resultCount": 25,
                "responded": True,
            },
        ]
        result = assess_quote_autocomplete_logs("111", "carrot", events)
        self.assertTrue(result.ok)
        self.assertEqual(result.result_count, 25)

    def test_fails_when_respond_skipped_follows_search(self) -> None:
        events = [
            {
                "event": "quote.autocomplete",
                "interactionId": "222",
                "query": "carrot",
                "resultCount": 25,
            },
            {
                "event": "quote.autocomplete.respond_skipped",
                "query": "carrot",
                "resultCount": 25,
                "error": "Interaction has already been acknowledged.",
            },
        ]
        result = assess_quote_autocomplete_logs("222", "carrot", events)
        self.assertFalse(result.ok)
        self.assertIn("already been acknowledged", result.detail)

    def test_parses_json_log_lines(self) -> None:
        log_text = "\n".join(
            [
                "noise",
                json.dumps(
                    {
                        "event": "quote.autocomplete",
                        "interactionId": "333",
                        "query": "carrot",
                        "resultCount": 3,
                    }
                ),
                json.dumps({"event": "other.event"}),
            ]
        )
        events = parse_json_log_events(log_text, event_prefix="quote.autocomplete")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["interactionId"], "333")

    def test_series_passes_when_responded_follows_series_search(self) -> None:
        events = [
            {
                "event": "quote.series_autocomplete",
                "interactionId": "444",
                "query": "Red",
                "resultCount": 3,
            },
            {
                "event": "quote.autocomplete.responded",
                "query": "Red",
                "resultCount": 3,
                "responded": True,
            },
        ]
        result = assess_quote_series_autocomplete_logs("444", "Red", events)
        self.assertTrue(result.ok)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
