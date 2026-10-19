"""Bounded PCM-to-WAV for live guest meeting audio; no network or persistence."""
import io
import wave

MAX_PCM_BYTES = 1024 * 1024
MAX_AUDIO_PARTS = 512

def pcm_wave(data, sample_rate):
    if sample_rate not in {8000, 16000, 24000, 32000, 48000}:
        raise ValueError("Unsupported sample rate")
    if not data or len(data) > MAX_PCM_BYTES or len(data) % 2:
        raise ValueError("Invalid PCM audio size")
    output = io.BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(bytes(data))
    return output.getvalue()
