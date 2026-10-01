# Tailnet viewer deployment test intent

- A viewer launched by Windows Task Scheduler must read the deployed files and
  serve the existing Tailnet URL independently of the agent's launching shell.
- Registration uses only the current user's logon trigger, runs on battery, and
  imposes no execution time limit. It does not require elevation.
- An exited serving process recovers; restarting the task reloads the deployment.
- Reinstallation pauses the recovery trigger before stopping the old server,
  then reenables the installed task so the timer cannot race the replacement.
- Missing startup dependencies produce an actionable log and a nonzero exit,
  while a one-minute trigger relaunches a stopped task without duplicating it.
- The actual Tailnet conversation opens in Chromium, switches to Discussion,
  and loads its script, styles, and artifact without HTTP or JavaScript errors.

Written test exception: filesystem visibility and Task Scheduler ownership are
Windows runtime contracts. Validate them through an actual scheduled launch,
process failure/recovery, and the existing browser smoke suite rather than mocks
of PowerShell cmdlets. Logon/reboot recovery is configured but must be reported
as untested until a real sign-in/reboot has occurred.
