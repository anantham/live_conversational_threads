"""
Tests for the WhatsApp chat export parser.

Run with: pytest tests/test_whatsapp_parser.py -v
"""

from lct_python_backend.parsers.whatsapp import WhatsAppParser


class TestBasicParsing:
    def test_parse_ios_style(self):
        parser = WhatsAppParser()
        text = (
            "[01/02/2026, 09:15:03] Alice: Hey everyone\n"
            "[01/02/2026, 09:15:40] Bob: Hi Alice!\n"
            "[01/02/2026, 09:16:00] Charlie: Good morning\n"
        )
        transcript = parser.parse_text(text)

        assert len(transcript.utterances) == 3
        assert set(transcript.participants) == {"Alice", "Bob", "Charlie"}
        assert transcript.utterances[0].speaker == "Alice"
        assert transcript.utterances[0].text == "Hey everyone"

    def test_parse_android_style(self):
        parser = WhatsAppParser()
        text = (
            "01/02/2026, 9:15 AM - Alice: Hey everyone\n"
            "01/02/2026, 9:15 AM - Bob: Hi Alice!\n"
        )
        transcript = parser.parse_text(text)

        assert len(transcript.utterances) == 2
        assert transcript.utterances[0].speaker == "Alice"
        assert transcript.utterances[1].speaker == "Bob"

    def test_empty_transcript(self):
        parser = WhatsAppParser()
        transcript = parser.parse_text("")
        assert len(transcript.utterances) == 0
        assert len(transcript.participants) == 0


class TestMultilineAndSystemMessages:
    def test_multiline_message_joins_continuation_lines(self):
        parser = WhatsAppParser()
        text = (
            "[01/02/2026, 09:15:03] Alice: This is a long message\n"
            "that continues on the next line\n"
            "and even a third line.\n"
            "[01/02/2026, 09:16:00] Bob: ok\n"
        )
        transcript = parser.parse_text(text)

        assert len(transcript.utterances) == 2
        assert transcript.utterances[0].text == (
            "This is a long message that continues on the next line and even a third line."
        )

    def test_system_messages_are_skipped(self):
        parser = WhatsAppParser()
        text = (
            "[01/02/2026, 09:00:00] Messages and calls are end-to-end encrypted.\n"
            "[01/02/2026, 09:01:00] Alice created group \"AI Alignment India\"\n"
            "[01/02/2026, 09:15:03] Alice: Hey everyone\n"
        )
        transcript = parser.parse_text(text)

        assert len(transcript.utterances) == 1
        assert transcript.utterances[0].speaker == "Alice"
        assert transcript.parse_metadata["system_message_count"] == 2


class TestAttachments:
    def test_attachment_reference_is_captured_in_metadata(self):
        parser = WhatsAppParser()
        text = "[01/02/2026, 09:15:03] Alice: <attached: IMG-20260101-WA0001.jpg>\n"
        transcript = parser.parse_text(text)

        assert len(transcript.utterances) == 1
        utt = transcript.utterances[0]
        assert utt.metadata.get("attachment_filename") == "IMG-20260101-WA0001.jpg"
        assert utt.text == "[attached: IMG-20260101-WA0001.jpg]"

    def test_omitted_placeholder_has_no_attachment_filename(self):
        parser = WhatsAppParser()
        text = "[01/02/2026, 09:15:03] Alice: image omitted\n"
        transcript = parser.parse_text(text)

        assert len(transcript.utterances) == 1
        utt = transcript.utterances[0]
        assert "attachment_filename" not in utt.metadata
        assert utt.text == "image omitted"


class TestValidation:
    def test_valid_transcript(self):
        parser = WhatsAppParser()
        text = "[01/02/2026, 09:15:03] Alice: hi\n[01/02/2026, 09:15:10] Bob: hey\n"
        transcript = parser.parse_text(text)
        result = parser.validate_transcript(transcript)

        assert result.is_valid
        assert result.stats["total_speakers"] == 2

    def test_empty_transcript_is_invalid(self):
        parser = WhatsAppParser()
        transcript = parser.parse_text("")
        result = parser.validate_transcript(transcript)

        assert not result.is_valid
        assert "No utterances found in transcript" in result.errors
