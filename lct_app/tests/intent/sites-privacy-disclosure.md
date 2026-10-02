# Test intent: Sites privacy disclosure

- A guest can open the public `/privacy` route without waiting for a session or backend check.
- The access panel is absent on `/privacy`, so no sign-in request or floating overlay obscures the policy; leaving for Home restores it.
- The optional sign-in panel links to the disclosure in guest, checking, and failed states.
- The page explains the separate private-save and public-publish actions and gives a usable contact address.
- A direct HTML navigation to `/privacy` receives the Sites app shell when managed assets do not have a file at that path.
