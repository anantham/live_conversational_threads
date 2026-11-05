import logging
import os
import signal

from celery import shared_task
from celery.signals import worker_shutting_down

from bots.bot_controller import BotController
from bots.models import Bot, BotStates

logger = logging.getLogger(__name__)


@shared_task(bind=True, soft_time_limit=3600)
def run_bot(self, bot_id):
    # A hard-stopped worker can redeliver a task after the bot has finished.
    # Do not construct a recorder or update that retained terminal record.
    try:
        bot = Bot.objects.only("id", "state").get(id=bot_id)
    except Bot.DoesNotExist:
        logger.info("Skipping task for missing bot %s", bot_id)
        return
    if BotStates.state_to_api_code(bot.state) in ("ended", "fatal_error", "data_deleted"):
        logger.info("Skipping terminal bot task %s", bot_id)
        return
    logger.info(f"Running bot {bot_id}")
    bot_controller = BotController(bot_id)
    bot_controller.run()


def kill_child_processes():
    # Get the process group ID (PGID) of the current process
    pgid = os.getpgid(os.getpid())

    try:
        # Send SIGTERM to all processes in the process group
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        pass  # Process group may no longer exist


@worker_shutting_down.connect
def shutting_down_handler(sig, how, exitcode, **kwargs):
    # Just adding this code so we can see how to shut down all the tasks
    # when the main process is terminated.
    # It's likely overkill.
    logger.info("Celery worker shutting down, sending SIGTERM to all child processes")
    kill_child_processes()
