"""Local-only production settings layered over the recovered upstream source."""
from attendee.settings.production import *  # noqa: F403

SOCIALACCOUNT_ENABLED = False
AWS_S3_ADDRESSING_STYLE = "path"
AWS_S3_REGION_NAME = "us-east-1"
for _name in ("default", "recordings", "audio_chunks", "bot_debug_screenshots"):
    STORAGES[_name]["OPTIONS"].update(addressing_style="path", region_name="us-east-1")  # noqa: F405
