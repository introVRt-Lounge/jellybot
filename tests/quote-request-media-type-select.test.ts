import { describe, expect, test } from "bun:test";
import {
  handleQuoteRequestMediaTypeSelect,
  isQuoteRequestMediaTypeSelect,
} from "../src/quote-requests/handle-select.ts";
import {
  QUOTE_REQUEST_MEDIA_TYPE_MOVIE,
  QUOTE_REQUEST_MEDIA_TYPE_SELECT_ID,
  QUOTE_REQUEST_MEDIA_TYPE_TV,
  QUOTE_REQUEST_MODAL_ID,
  QUOTE_REQUEST_TV_MODAL_ID,
} from "../src/quote-requests/modal.ts";

type SelectLikeInteraction = {
  customId: string;
  values: string[];
  showModal: (modal: { data?: { custom_id?: string } }) => Promise<void>;
  reply: (payload: unknown) => Promise<void>;
};

function makeSelectInteraction(values: string[]): {
  interaction: SelectLikeInteraction;
  spies: { modalCustomIds: string[]; replies: unknown[] };
} {
  const spies = { modalCustomIds: [] as string[], replies: [] as unknown[] };
  const interaction: SelectLikeInteraction = {
    customId: QUOTE_REQUEST_MEDIA_TYPE_SELECT_ID,
    values,
    showModal: async (modal) => {
      const customId =
        // discord.js ModalBuilder exposes the customId via `.data.custom_id`
        // when serialized. We accept both shapes for robustness in tests.
        (modal as { data?: { custom_id?: string }; customId?: string })?.data?.custom_id ??
        (modal as { customId?: string })?.customId ??
        "<unknown>";
      spies.modalCustomIds.push(customId);
    },
    reply: async (payload) => {
      spies.replies.push(payload);
    },
  };
  return { interaction, spies };
}

describe("isQuoteRequestMediaTypeSelect", () => {
  test("matches the canonical custom id and rejects others", () => {
    expect(
      isQuoteRequestMediaTypeSelect({
        customId: QUOTE_REQUEST_MEDIA_TYPE_SELECT_ID,
      } as never),
    ).toBe(true);
    expect(
      isQuoteRequestMediaTypeSelect({ customId: "feature_rank_step1_abc" } as never),
    ).toBe(false);
  });
});

describe("handleQuoteRequestMediaTypeSelect", () => {
  test("opens the movie modal when the user picks 'movie'", async () => {
    const { interaction, spies } = makeSelectInteraction([QUOTE_REQUEST_MEDIA_TYPE_MOVIE]);
    await handleQuoteRequestMediaTypeSelect(interaction as never);
    expect(spies.modalCustomIds).toEqual([QUOTE_REQUEST_MODAL_ID]);
    expect(spies.replies).toHaveLength(0);
  });

  test("opens the TV modal when the user picks 'tv'", async () => {
    const { interaction, spies } = makeSelectInteraction([QUOTE_REQUEST_MEDIA_TYPE_TV]);
    await handleQuoteRequestMediaTypeSelect(interaction as never);
    expect(spies.modalCustomIds).toEqual([QUOTE_REQUEST_TV_MODAL_ID]);
    expect(spies.replies).toHaveLength(0);
  });

  test("falls back with an ephemeral reply when the value is unknown", async () => {
    const { interaction, spies } = makeSelectInteraction(["other"]);
    await handleQuoteRequestMediaTypeSelect(interaction as never);
    expect(spies.modalCustomIds).toHaveLength(0);
    expect(spies.replies).toHaveLength(1);
  });
});
