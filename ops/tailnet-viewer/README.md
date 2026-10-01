# Tailnet static viewer

The HTTPS route on port 43192 proxies to a loopback viewer on 43191. Windows
Task Scheduler directly owns the actual Node server process; it must not be
launched as an agent shell child or through a runtime shim. The task runs at the
current user's sign-in, on battery, with no execution time limit. The machine
must be awake and the user signed in.
An additional one-minute trigger relaunches a stopped task. `IgnoreNew` leaves
an already-running server alone. Do not rely on `RestartOnFailure` alone:
Windows marked the forced process exit as a completed action and did not retry it.

Install a previously validated frontend build without editing the deploy checkout:

```powershell
.\ops\tailnet-viewer\install-task.ps1 `
  -BuildDirectory '<validated frontend dist directory>' `
  -ViteCli '<installed lct_app\node_modules\vite\bin\vite.js>' `
  -TailnetHostname 'asus-strix-scar.tail4741ad.ts.net'
```

The default release is `Documents\LCTTailnetViewer`. Do not assume a directory
visible to the agent also exists for Windows Task Scheduler: the previous
AppData deployment was absent when probed from an actual scheduled process.
The installer checks a real scheduled launch and fails if it cannot serve the
app. It replaces only this user's `LCT-Tailnet-Viewer` task and does not change
Tailscale configuration or other services.

The existing route can be inspected with `tailscale serve status`. If setting
it up for the first time, the bounded route command is:

```powershell
tailscale serve --bg --https=43192 http://127.0.0.1:43191
```

Verify the actual Tailnet `/view?src=...` URL in Chromium, switch to Discussion,
and expand a branch. A local HTTP 200 does not prove the remote host is accepted,
that the artifact loads, or that React renders. The existing production browser
smoke suite accepts `PLAYWRIGHT_BASE_URL` pointing to the Tailnet origin.

For recovery, inspect task state/events and `viewer.log`,
then restart this exact task. Never kill an unidentified listener. Logon/reboot
behavior remains unverified until an actual subsequent sign-in/reboot.
For maintenance, disable this task before stopping it; otherwise the next
one-minute trigger will start it again.
