"""
WhatsApp "Export Chat" transcript parser.

Supports parsing of WhatsApp chat exports (the ``_chat.txt`` produced by
WhatsApp's "Export Chat" feature) in both common line formats:

    iOS-style:     [DD/MM/YYYY, HH:MM:SS] Sender: message
    Android-style: DD/MM/YYYY, HH:MM - Sender: message

Handles multi-line messages, system/notification lines (join notices,
encryption notices, etc — no sender, filtered out), and attachment
placeholders (``<attached: filename>``) which are surfaced via
``Utterance.metadata['attachment_filename']`` for the caller to caption
and splice — this parser itself does no I/O.
"""

import re
from typing import List, Optional, Dict
import logging

from .google_meet import Utterance, ParsedTranscript, ValidationResult

logger = logging.getLogger(__name__)

# WhatsApp exports prefix each line with an invisible LRM/RLM mark on some
# locales/platforms — strip before matching.
_INVISIBLE_MARKS = "‎‏"

# Matches both bracketed (iOS) and dash-separated (Android) message starts:
#   [DD/MM/YYYY, HH:MM:SS] Sender: message
#   DD/MM/YYYY, HH:MM - Sender: message
# Date separator may be '/' or '.'; seconds and AM/PM are optional.
_MESSAGE_START_PATTERN = re.compile(
    r"^\[?"
    r"(?P<date>\d{1,2}[/.]\d{1,2}[/.]\d{2,4}),\s*"
    r"(?P<time>\d{1,2}:\d{2}(?::\d{2})?(?:\s?[apAP][mM])?)"
    r"\]?\s*-?\s*"
    r"(?P<rest>.*)$"
)

# Within the "rest" of a matched line, a real message has a "Sender: text"
# shape. System/notification lines (added/removed/encryption notices) don't.
_SENDER_PATTERN = re.compile(r"^(?P<speaker>[^:]{1,80}?):\s(?P<text>.*)$")

# Searched (not anchored) against the FULLY JOINED message text in flush():
# attachments are frequently accompanied by caption text on the same line
# ("Figure from: <url> <attached: x.jpg>") or land on a continuation line of
# a multi-line message rather than standing alone — confirmed against a real
# export where an anchored ^...$ match missed 15 of 18 real attachments.
_ATTACHMENT_PATTERN = re.compile(r"<attached:\s*(?P<filename>.+?)>", re.IGNORECASE)

# WhatsApp group-management notices are exported in the SAME "Name: text"
# shape as a real message (e.g. "Vatsal: ‎Vatsal was added"), so they
# pass the sender-colon check and must be filtered on message BODY content
# instead — confirmed against a real export, which surfaced "was added",
# "You added X", "left", "joined using your invite", "pinned a message",
# and phone-number-change notices all sharing this exact shape.
_SYSTEM_NOTICE_PATTERNS = [
    re.compile(p, re.IGNORECASE) for p in (
        r"^you added .+$",
        r"^you removed .+$",
        r"^.+ was added$",
        r"^.+ was removed$",
        r"^.+ left$",
        r"^.+ joined using (this group'?s invite link|your invite)$",
        r"^.+ changed (their|the) (phone number|group description|subject|group'?s icon|group settings).*$",
        r"^you changed (the )?(group description|subject|group'?s icon|group settings)$",
        r"^.+ pinned a message$",
        r"^you pinned a message$",
        r"^.+ created (group|this group).*$",
        r"^.+ (is now|is no longer) an admin$",
        r"^missed (voice|video) call.*$",
        r"^your security code with .+ changed.*$",
        r"^.+ turned (on|off) disappearing messages.*$",
        r"^messages and calls are end-to-end encrypted.*$",
    )
]
# Short-ending phrasings ("...was added", "...left") risk coincidentally
# matching the tail of a real, longer message ("the new feature was added")
# — cap how long a body can be and still be treated as this class of notice.
_SYSTEM_NOTICE_MAX_LEN = 120

_LRM = "‎"


def _is_system_notice(raw_text: str) -> bool:
    """Takes the sender-line body BEFORE invisible-mark cleanup: WhatsApp
    stamps every generated notice body with a leading U+200E, while
    human-typed text never starts with one — patterns alone over-match
    (audited on a real 3754-message export: 165/165 notices carried the
    mark; the only pattern matches without it were real human messages,
    e.g. "yeah, bunch of people left"). No mark → fail open to keeping
    the message."""
    body = raw_text.lstrip(" \t")
    if not body.startswith(_LRM):
        return False
    cleaned = body.replace("‎", "").replace("‏", "").strip()
    if len(cleaned) > _SYSTEM_NOTICE_MAX_LEN:
        return False
    return any(pattern.match(cleaned) for pattern in _SYSTEM_NOTICE_PATTERNS)


class WhatsAppParser:
    """
    Parser for WhatsApp "Export Chat" transcripts.

    Format:
        [DD/MM/YYYY, HH:MM:SS] Speaker: message text
        or
        DD/MM/YYYY, HH:MM - Speaker: message text

        Continuation lines (no leading timestamp) belong to the previous
        message. Lines with a timestamp but no "Speaker:" prefix are
        WhatsApp system notices and are skipped.
    """

    def __init__(self):
        self.current_timestamp = None

    def parse_file(self, file_path: str) -> ParsedTranscript:
        """Parse a WhatsApp chat export .txt file."""
        text = self._read_text_file(file_path)
        transcript = self.parse_text(text)
        transcript.source_file = file_path
        return transcript

    def _read_text_file(self, file_path: str) -> str:
        for encoding in ("utf-8", "utf-8-sig", "latin-1", "cp1252", "iso-8859-1"):
            try:
                with open(file_path, "r", encoding=encoding) as f:
                    text = f.read()
                logger.info(f"Read {len(text)} characters from {file_path} using {encoding}")
                return text
            except UnicodeDecodeError:
                continue
        raise ValueError("Could not decode WhatsApp chat file with any common encoding")

    def parse_text(self, text: str) -> ParsedTranscript:
        """Parse WhatsApp chat export text into structured utterances."""
        lines = text.split("\n")
        utterances: List[Utterance] = []
        current_speaker: Optional[str] = None
        current_text_parts: List[str] = []
        current_timestamp: Optional[str] = None
        current_line_numbers: List[int] = []
        current_metadata: Dict = {}
        sequence_number = 0
        system_message_count = 0

        def flush():
            nonlocal current_speaker, current_text_parts, current_line_numbers
            nonlocal current_metadata, sequence_number
            if current_speaker and current_text_parts:
                # Invisible LRM/RLM marks can land mid-body on any line (not
                # just line edges) — before "<This message was edited>",
                # "image omitted", or an <attached:...> marker on a
                # continuation line — so normalize once over the fully
                # joined text rather than per source line.
                joined_text = (
                    " ".join(current_text_parts)
                    .replace("‎", "")
                    .replace("‏", "")
                    .strip()
                )
                metadata = dict(current_metadata)

                # Detect an attachment marker anywhere in the FULLY JOINED
                # text — it may carry caption text alongside it, or have
                # landed on a continuation line rather than the message's
                # first line.
                attachment_match = _ATTACHMENT_PATTERN.search(joined_text)
                if attachment_match:
                    filename = attachment_match.group("filename").strip()
                    metadata["attachment_filename"] = filename
                    joined_text = (
                        joined_text[: attachment_match.start()]
                        + f"[attached: {filename}]"
                        + joined_text[attachment_match.end():]
                    ).strip()

                utterances.append(Utterance(
                    speaker=current_speaker,
                    text=joined_text,
                    timestamp_marker=current_timestamp,
                    sequence_number=sequence_number,
                    line_numbers=current_line_numbers.copy(),
                    metadata=metadata,
                ))
                sequence_number += 1
            current_speaker = None
            current_text_parts = []
            current_line_numbers = []
            current_metadata = {}

        for line_num, raw_line in enumerate(lines, 1):
            line = raw_line.strip(_INVISIBLE_MARKS + " \t\r")
            if not line:
                continue

            match = _MESSAGE_START_PATTERN.match(line)
            if match:
                # New timestamped entry — flush whatever was being built.
                flush()
                current_timestamp = f"{match.group('date')} {match.group('time')}"
                rest = match.group("rest").strip(_INVISIBLE_MARKS + " \t")

                sender_match = _SENDER_PATTERN.match(rest)
                if not sender_match:
                    # Timestamp with no "Speaker:" prefix -> a system/notification
                    # line (join notice, encryption notice, etc). Skip it.
                    system_message_count += 1
                    continue

                speaker = sender_match.group("speaker").strip()

                if _is_system_notice(sender_match.group("text")):
                    # e.g. "Vatsal: ‎Vatsal was added" / "Admin: ‎You added X" —
                    # a WhatsApp group-management notice, not a real message.
                    # Checked on the RAW body: the U+200E stamp is the
                    # discriminator and cleanup below would erase it.
                    system_message_count += 1
                    continue

                # Invisible LRM/RLM marks also show up mid-body (e.g. before
                # "<This message was edited>" or "image omitted"), not just
                # at line edges — strip everywhere, not just via the outer
                # line.strip().
                text_part = (
                    sender_match.group("text")
                    .replace("‎", "")
                    .replace("‏", "")
                    .strip()
                )

                current_speaker = speaker
                current_text_parts = [text_part] if text_part else []
                current_line_numbers = [line_num]
                current_metadata = {}
                continue

            if current_speaker:
                # Continuation line of the message being built.
                current_text_parts.append(line)
                current_line_numbers.append(line_num)
            # else: stray line before any recognized message start — ignore.

        flush()

        participants = list(dict.fromkeys(u.speaker for u in utterances))

        transcript = ParsedTranscript(
            utterances=utterances,
            participants=participants,
            duration=None,
            parse_metadata={
                "total_lines": len(lines),
                "utterance_count": len(utterances),
                "participant_count": len(participants),
                "system_message_count": system_message_count,
            },
        )
        return transcript

    def validate_transcript(self, transcript: ParsedTranscript) -> ValidationResult:
        """Validate a parsed WhatsApp transcript for quality and completeness."""
        errors = []
        warnings = []
        stats = {}

        if not transcript.utterances:
            errors.append("No utterances found in transcript")
            return ValidationResult(is_valid=False, errors=errors)

        if not transcript.participants:
            errors.append("No speakers identified")
        elif len(transcript.participants) == 1:
            warnings.append("Only one speaker detected - may be a monologue")

        stats["total_utterances"] = len(transcript.utterances)
        stats["total_speakers"] = len(transcript.participants)
        stats["system_message_count"] = transcript.parse_metadata.get("system_message_count", 0)

        attachment_count = sum(
            1 for u in transcript.utterances if u.metadata.get("attachment_filename")
        )
        stats["attachment_count"] = attachment_count

        short_utterances = [u for u in transcript.utterances if len(u.text) < 3]
        if len(short_utterances) > len(transcript.utterances) * 0.2:
            warnings.append(f"{len(short_utterances)} utterances are very short (< 3 chars)")

        for speaker in transcript.participants:
            if len(speaker) > 100:
                warnings.append(f"Speaker name is very long: {speaker[:50]}...")

        is_valid = len(errors) == 0

        return ValidationResult(
            is_valid=is_valid,
            errors=errors,
            warnings=warnings,
            stats=stats,
        )
