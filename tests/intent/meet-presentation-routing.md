# Meet presentation routing intent

- Reproduce the final pilot failure with only synthetic hosts, presentation devices and caption/audio packets through the pinned public UserManager, CaptionManager and WebSocketClient APIs. The raw upstream must fail presentation attribution assertions while ordinary microphone/disabled/unknown-source checks pass.
- Route presentation captions and PCM only through Google's explicit parentDeviceId. Do not infer identity from names, a single attendee, or a default host. Keep presentation entries excluded from the human roster. Unknown IDs remain unchanged for downstream refusal.
- Preserve revision stability, caption text/final flag/version, immutable inputs, exact PCM bytes, and distinguish a microphone and multiple simultaneous presentation sources whose numeric caption IDs collide.
- Feed emitted wire packets into the actual Python ClosedCaptionManager with a synthetic participant directory and actual PCM-to-WAV conversion. Verify observable saved utterances/source UUIDs and valid WAV, without DB/network/provider/browser activity.
- Hash-pin the complete upstream payload, refuse existing destination/wrong source, and syntax-check derived JavaScript. Full live acceptance remains separate; no new bot is authorized by these tests.

- Adjacent audio-level regression: the pinned RMS squares int16 samples before conversion, overflowing at ordinary speech amplitudes. Prove quarter/full-scale results and actual five-second chunk emission before/after float conversion using existing real dependencies; no threshold or VAD oracle is weakened.
