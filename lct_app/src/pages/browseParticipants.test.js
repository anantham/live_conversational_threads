import { describe, expect, it } from "vitest";

import {
  buildContactOptions,
  isUsefulParticipantLabel,
  participantKey,
} from "./browseParticipants";

/*
 * Test intent:
 * - Contact filters expose people, not imported metadata keys or speaker placeholders.
 * - Duplicate names differing only by case collapse to one stable filter.
 * - Real participant ids remain stable when the same display name appears elsewhere.
 */

describe("browse participant filters", () => {
  it("rejects metadata debris, markdown fragments, and diarization placeholders", () => {
    for (const label of ["chunk_index", "doc_id", "title", "**Aditya", "@", "SPEAKER_00", "A"]) {
      expect(isUsefulParticipantLabel(label)).toBe(false);
      expect(participantKey({ name: label })).toBeNull();
    }
  });

  it("deduplicates corrected names case-insensitively while preferring readable casing", () => {
    const options = buildContactOptions([
      { participants: [{ name: "aditya" }, { name: "Aditya" }, { name: "Ganesh" }] },
      { participants: [{ name: "GANESH" }, { name: "modified_date" }] },
    ]);
    expect(options).toEqual([
      { key: "name:aditya", label: "Aditya" },
      { key: "name:ganesh", label: "Ganesh" },
    ]);
  });

  it("keeps contact ids as the stable identity", () => {
    expect(participantKey({ contact_id: "person-42", display_name: "María" })).toBe("id:person-42");
  });
});
