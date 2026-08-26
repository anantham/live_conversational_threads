# Drive-backed `.threads` links

The recipient URL is:

```text
https://threads.adityaarpitha.com/view?driveFile=<GOOGLE_DRIVE_FILE_ID>
```

The URL is not an access capability. The `.threads` file remains private in
Google Drive, and the Drive ACL decides whether the selected Google account may
download it. LCT requests the non-sensitive `drive.file` scope on a user click,
keeps the short-lived access token in memory, downloads the named file directly
from Google's `files.get?alt=media` endpoint, validates it, and remembers only
the artifact in the browser-local Library.

## Deployment configuration

1. Use the same Google Cloud OAuth project that Indra's Net uses to create the
   Drive artifact.
2. Enable the Google Drive API.
3. Create a **Web application** OAuth client and add these authorized JavaScript
   origins:
   - `https://threads.adityaarpitha.com`
   - the local development origin when needed, for example
     `http://localhost:43173`
4. Declare `https://www.googleapis.com/auth/drive.file` on the OAuth consent
   screen.
5. Set `VITE_GOOGLE_DRIVE_CLIENT_ID` to the web client id in the Vercel build
   environment and redeploy. A client id is public configuration; do not add a
   client secret to the frontend.

No redirect URI, refresh-token store, LCT backend, or broad `drive.readonly`
scope is required. If a recipient with an explicit Drive reader ACL still gets
a 404 during production validation, use Google Picker to associate that single
file with the app while retaining `drive.file`; do not widen the scope.
