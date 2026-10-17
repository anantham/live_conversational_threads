"""Local-only production settings layered over the recovered upstream source."""
from attendee.settings.production import *  # noqa: F403

SOCIALACCOUNT_ENABLED = False
AWS_S3_ADDRESSING_STYLE = "path"
AWS_S3_REGION_NAME = "us-east-1"
for _name in ("default", "recordings", "audio_chunks", "bot_debug_screenshots"):
    STORAGES[_name]["OPTIONS"].update(addressing_style="path", region_name="us-east-1")  # noqa: F405

# Expose only the project-authenticated meeting API, not the Attendee dashboard.
ROOT_URLCONF = "lct_cloud_api"
MIDDLEWARE = ["lct_cloud_api.OnlyMeetingAPI", *MIDDLEWARE]  # noqa: F405

# The only public relay host; request routing remains guarded before Django views.
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "app", "asus-strix-scar.tail4741ad.ts.net"]
