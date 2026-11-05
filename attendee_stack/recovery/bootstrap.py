"""Initialize only the dedicated recovery database and private recording bucket.

Run after migrations, inside the app image. Does not create a bot or webhook,
print credentials, contact an inference provider, or read the old database.
"""
import hashlib
import json
import os

import django


def main():
    if os.environ.get("POSTGRES_DB") != "lct_meet_recovery_20261017":
        raise RuntimeError("Refusing bootstrap outside the dedicated recovery database")
    key = os.environ.get("LCT_BOOTSTRAP_API_KEY", "")
    if len(key) != 64:
        raise RuntimeError("Missing recovery API credential; no database changes made")
    django.setup()
    from django.conf import settings
    from django.db import transaction
    from accounts.models import Organization
    from bots.models import ApiKey, Bot, Project
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError

    if settings.DATABASES["default"]["NAME"] != "lct_meet_recovery_20261017":
        raise RuntimeError("Resolved database does not match recovery namespace")
    with transaction.atomic():
        if Bot.objects.exists():
            raise RuntimeError("Existing bots require inspection; bootstrap will not reset them")
        org, _ = Organization.objects.get_or_create(name="LCT isolated recovery")
        project, _ = Project.objects.get_or_create(name="LCT isolated recovery", organization=org,
                                                  defaults={"concurrent_bots_limit_override": 1})
        if project.concurrent_bots_limit_override != 1:
            raise RuntimeError("Unexpected bot limit; preserve and inspect instead of changing it")
        expected = hashlib.sha256(key.encode()).hexdigest()
        if ApiKey.objects.filter(project=project).exclude(key_hash=expected).exists():
            raise RuntimeError("Unexpected API credential; preserve and inspect instead of rotating")
        ApiKey.objects.get_or_create(project=project, key_hash=expected, defaults={"name": "LCT relay"})

    client = boto3.client("s3", endpoint_url="http://minio:9000", region_name="us-east-1",
                          aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
                          aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
                          config=Config(s3={"addressing_style": "path"}, connect_timeout=3,
                                        read_timeout=5, retries={"max_attempts": 2}))
    bucket = "lct-meeting-recordings"
    try:
        client.head_bucket(Bucket=bucket)
    except ClientError as exc:
        if exc.response["ResponseMetadata"]["HTTPStatusCode"] != 404:
            raise
        client.create_bucket(Bucket=bucket)
    print(json.dumps({"bootstrap": "ready", "bot_count": 0, "storage": "private local bucket"}))


if __name__ == "__main__":
    main()
