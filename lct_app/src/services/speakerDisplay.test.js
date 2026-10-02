import { expect, it } from "vitest";
import { buildSpeakerDisplayNames, speakerDisplayName, transcriptSpeakerLabels } from "./speakerDisplay";

// Test intent: aliases come only from this artifact's current speaker rows;
// raw transcript offsets and unsupported labels remain stable.
it("uses utterance names over graph names and falls back to stable IDs", () => {
  const names = buildSpeakerDisplayNames({
    utterances: [{ speaker_id: "SPEAKER_00", speaker_name: "Ada" }],
    graph_data: [[{ speaker_id: "SPEAKER_00", speaker_display: "Old name" }, { speaker_id: "SPEAKER_01", speaker_name: "Bea" }]],
  });
  expect(speakerDisplayName(names, "SPEAKER_00")).toBe("Ada");
  expect(speakerDisplayName(names, "SPEAKER_01")).toBe("Bea");
  expect(speakerDisplayName(names, "UNMAPPED")).toBe("UNMAPPED");
  expect(speakerDisplayName(names, null)).toBe("Unknown speaker");
});

it("maps only recognized line-leading labels without touching spoken mentions", () => {
  const transcript = "[SPEAKER_00] SPEAKER_00 is a label\r\n[SPEAKER_01] Another turn\n[00:00:01.250] SPEAKER_00: Legacy turn\nUNKNOWN: unchanged\nA spoken SPEAKER_00: mention";
  const names = buildSpeakerDisplayNames([{ speaker_id: "SPEAKER_00", speaker_name: "Ada" }]);
  const labels = transcriptSpeakerLabels(transcript, names);
  expect(labels).toHaveLength(2);
  expect(labels.map(({ start, end }) => transcript.slice(start, end))).toEqual(["SPEAKER_00", "SPEAKER_00"]);
  expect(labels.map(({ text }) => text)).toEqual(["Ada", "Ada"]);
  expect(transcriptSpeakerLabels("[UNKNOWN] text\n[SPEAKER_00] known", names)).toHaveLength(1);
});
