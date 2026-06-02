import { describe, expect, test } from "bun:test";
import {
  QUOTE_REQUEST_TV_FIELD_EPISODE,
  QUOTE_REQUEST_TV_FIELD_QUOTE,
  QUOTE_REQUEST_TV_FIELD_SEASON,
  QUOTE_REQUEST_TV_FIELD_SHOW,
  parseQuoteRequestTvModal,
} from "../src/quote-requests/modal.ts";

function fakeInteraction(values: Record<string, string>) {
  return {
    fields: {
      getTextInputValue: (id: string) => values[id] ?? "",
    },
  } as never;
}

describe("parseQuoteRequestTvModal", () => {
  test("trims and parses numeric season/episode", () => {
    const parsed = parseQuoteRequestTvModal(
      fakeInteraction({
        [QUOTE_REQUEST_TV_FIELD_SHOW]: "  Buffy ",
        [QUOTE_REQUEST_TV_FIELD_SEASON]: " 2 ",
        [QUOTE_REQUEST_TV_FIELD_EPISODE]: "5",
        [QUOTE_REQUEST_TV_FIELD_QUOTE]: "  what's so funny? ",
      }),
    );
    expect(parsed.show).toBe("Buffy");
    expect(parsed.season).toBe(2);
    expect(parsed.episode).toBe(5);
    expect(parsed.quote).toBe("what's so funny?");
  });

  test("returns undefined for non-numeric season or episode and surfaces the raw text", () => {
    const parsed = parseQuoteRequestTvModal(
      fakeInteraction({
        [QUOTE_REQUEST_TV_FIELD_SHOW]: "Buffy",
        [QUOTE_REQUEST_TV_FIELD_SEASON]: "two",
        [QUOTE_REQUEST_TV_FIELD_EPISODE]: "",
        [QUOTE_REQUEST_TV_FIELD_QUOTE]: "anything",
      }),
    );
    expect(parsed.season).toBeUndefined();
    expect(parsed.episode).toBeUndefined();
    expect(parsed.rawSeason).toBe("two");
    expect(parsed.rawEpisode).toBe("");
  });

  test("rejects negative or non-integer values via the digit-only regex", () => {
    const parsed = parseQuoteRequestTvModal(
      fakeInteraction({
        [QUOTE_REQUEST_TV_FIELD_SHOW]: "Buffy",
        [QUOTE_REQUEST_TV_FIELD_SEASON]: "-1",
        [QUOTE_REQUEST_TV_FIELD_EPISODE]: "1.5",
        [QUOTE_REQUEST_TV_FIELD_QUOTE]: "anything",
      }),
    );
    expect(parsed.season).toBeUndefined();
    expect(parsed.episode).toBeUndefined();
  });
});
