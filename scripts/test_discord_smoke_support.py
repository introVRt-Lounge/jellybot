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
    assess_quote_debounce_supersede_logs,
    assess_quote_min_length_cancel_logs,
    assess_quote_series_autocomplete_logs,
    assess_quote_shaping_logs,
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

    def test_debounce_fails_when_prefix_serves_stale_choices(self) -> None:
        events = [
            {"event": "quote.autocomplete", "query": "arrest", "resultCount": 25},
            {
                "event": "quote.autocomplete.responded",
                "query": "arrest",
                "resultCount": 25,
                "responded": True,
            },
            {"event": "quote.autocomplete", "query": "arrested", "resultCount": 25},
            {
                "event": "quote.autocomplete.responded",
                "query": "arrested",
                "resultCount": 25,
                "responded": True,
            },
        ]
        result = assess_quote_debounce_supersede_logs(events, "arrest", "arrested")
        self.assertFalse(result.ok)
        self.assertIn("stale", result.detail)

    def test_debounce_passes_when_only_final_serves_choices(self) -> None:
        events = [
            {"event": "quote.autocomplete", "query": "arrest", "resultCount": 0},
            {
                "event": "quote.autocomplete.responded",
                "query": "arrest",
                "resultCount": 0,
                "responded": True,
            },
            {"event": "quote.autocomplete", "query": "arrested", "resultCount": 25},
            {
                "event": "quote.autocomplete.responded",
                "query": "arrested",
                "resultCount": 25,
                "responded": True,
            },
        ]
        result = assess_quote_debounce_supersede_logs(events, "arrest", "arrested")
        self.assertTrue(result.ok)

    def test_debounce_passes_when_prefix_never_logs(self) -> None:
        # Typical 80ms burst under 100ms debounce: prefix aborted before FTS.
        events = [
            {"event": "quote.autocomplete", "query": "arrested", "resultCount": 25},
            {
                "event": "quote.autocomplete.responded",
                "query": "arrested",
                "resultCount": 25,
                "responded": True,
            },
        ]
        result = assess_quote_debounce_supersede_logs(events, "arrest", "arrested")
        self.assertTrue(result.ok)

    def test_shaping_requires_search_query_distinct_from_raw_query(self) -> None:
        query = "that's it baby if you've got it flaunt it"
        events = [
            {
                "event": "quote.autocomplete",
                "query": query,
                "searchQuery": "that baby flaunt",
                "resultCount": 10,
            },
            {
                "event": "quote.autocomplete.responded",
                "query": query,
                "resultCount": 10,
                "responded": True,
            },
        ]
        result = assess_quote_shaping_logs(events, query)
        self.assertTrue(result.ok)
        self.assertIn("that baby flaunt", result.detail)

    def test_min_length_cancel_fails_when_valid_query_still_serves(self) -> None:
        events = [
            {"event": "quote.autocomplete", "query": "arrested", "resultCount": 25},
            {
                "event": "quote.autocomplete.responded",
                "query": "arrested",
                "resultCount": 25,
                "responded": True,
            },
            # Below-min path never emits quote.autocomplete — only responded.
            {
                "event": "quote.autocomplete.responded",
                "query": "ab",
                "resultCount": 0,
                "responded": True,
            },
        ]
        result = assess_quote_min_length_cancel_logs(events, "arrested", "ab")
        self.assertFalse(result.ok)
        self.assertIn("stale", result.detail)

    def test_min_length_cancel_passes_when_valid_query_does_not_serve(self) -> None:
        # Production below-min: empty respond only (no quote.autocomplete search line).
        events = [
            {
                "event": "quote.autocomplete.responded",
                "query": "ab",
                "resultCount": 0,
                "responded": True,
            },
        ]
        result = assess_quote_min_length_cancel_logs(events, "arrested", "ab")
        self.assertTrue(result.ok)

    def test_min_length_cancel_fails_without_below_min_respond(self) -> None:
        events = [
            {"event": "quote.autocomplete", "query": "arrested", "resultCount": 0},
        ]
        result = assess_quote_min_length_cancel_logs(events, "arrested", "ab")
        self.assertFalse(result.ok)
        self.assertIn("missing quote.autocomplete.responded", result.detail)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
