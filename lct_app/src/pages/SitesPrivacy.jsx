import { Link } from "react-router-dom";

const section = "mt-9 border-t border-slate-200 pt-7";
const heading = "text-xl font-semibold tracking-[-0.02em] text-slate-800";
const paragraph = "mt-3 text-sm leading-7 text-slate-700";

export default function SitesPrivacy() {
  return (
    <main className="min-h-dvh bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] px-4 pb-16 pt-8 font-sans text-slate-800 sm:px-8 sm:pt-12">
      <article className="mx-auto max-w-[72ch]">
        <Link to="/" className="inline-flex min-h-11 items-center text-sm text-slate-700 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700">Home</Link>
        <header className="mt-7 border-b border-slate-200 pb-7">
          <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Privacy at Threads</h1>
          <p className={paragraph}>This page describes the public Sites preview, including its optional sign-in and cloud features. The separate local and Tailscale app can work differently.</p>
          <p className="mt-2 text-xs text-slate-600">Updated 16 October 2026</p>
        </header>

        <section className={section}>
          <h2 className={heading}>Browsing and sign-in</h2>
          <p className={paragraph}>You can browse public conversations and open files on your own device without signing in. Sign-in is optional and is used to identify the owner of private cloud files and history.</p>
          <p className={paragraph}>If you choose Google sign-in, the Google sign-in script loads after you start that action. Google supplies an identity token, which this Site verifies using Google’s public signing keys. The Site uses your Google account’s subject ID to identify your private files; it does not store the Google identity token, your email, profile, or a Google access token in its session database. This sign-in does not request access to your Google Drive.</p>
          <p className={paragraph}>The Site also supports a separate native ChatGPT sign-in when its host provides one. That host supplies an authenticated user ID to the Site. The two identity providers remain distinct; signing in with one does not automatically open files owned through the other.</p>
        </section>

        <section className={section}>
          <h2 className={heading}>Sessions and browser data</h2>
          <p className={paragraph}>For Google sign-in, the Site stores your Google subject ID, hashed session and sign-in challenge IDs, and session creation and expiry times in its cloud database. Private files are scoped to both identity provider and account ID. The session cookie is HttpOnly, Secure, and SameSite=Strict and expires after one hour. Signing out revokes the matching session. Expired session rows are cleaned up when a later Google sign-in is accepted, so expiry does not mean an old row disappears immediately.</p>
          <p className={paragraph}>By default, new recordings save their audio parts, transcript and maps in this browser, without sign-in. Settings → Ephemeral turns off automatic conversation saving for new recordings; existing copies remain until you remove them. Ephemeral recordings disappear when their tab closes unless you deliberately download or save them. Browser storage is specific to this site and browser and may be removed by clearing site data or by browser eviction. Small preferences, session data, publication removal keys and payload-free timing histories are separate from conversation retention. The session-check history and the other sign-in timing history each keep at most eight samples, recording stage or outcome, elapsed milliseconds, and retry count; they exclude tokens, file contents, and account IDs. You can clear local browser data using your browser’s controls.</p>
        </section>

        <section className={section}>
          <h2 className={heading}>Files and conversations</h2>
          <p className={paragraph}>Opening a browser-local file does not upload or publish it automatically. A private cloud save is a separate action. Private file metadata is stored in the Site’s cloud database and file bytes in its cloud object storage. Private copies stay until their owner deletes them; a failed upload or deletion can require cleanup or a retry. Private saving requires sign-in and enabled personal storage. Each file is limited to 2 MiB, with 10 MiB per account and 20 MiB shared across this Site.</p>
          <p className={paragraph}>Publishing a `.threads` file is another separate, deliberate action that asks you to confirm the whole file may be public. A published copy can be browsed and downloaded by anyone. The browser keeps a removal key for that copy; removing it from the live library cannot recall copies others already downloaded.</p>
        </section>

        <section className={section}>
          <h2 className={heading}>Services and access</h2>
          <p className={paragraph}>Google receives data involved in Google sign-in when you choose it. The Site host and its infrastructure providers necessarily process browser requests and operate the cloud database and object storage. The operator may have infrastructure access to stored data. Private cloud storage is access-controlled for the signed-in owner; it is not end-to-end encrypted from the operator.</p>
          <p className={paragraph}>If you choose the bring-your-own-key AI tools, chat content is sent through the Site’s thin proxy to OpenAI; audio-file transcription with your own key goes from your browser to OpenAI. These are separate from Google sign-in and private file saving. If you choose live transcription, audio streams to Soniox after your permission. If you generate a conversation map, finalized words and their utterance IDs go to the provider you select: Google Gemini through Google AI Studio, or OpenRouter and its configured model provider. The Site does not automatically switch providers or retry. For direct Gemini, Google’s API terms and the project’s billing tier determine data use; OpenRouter’s data-collection setting does not apply to direct Google requests. Provider processing policies and the applicable account settings apply; generation never publishes your transcript or map. The local or ephemeral saving preference applies to generated maps; cloud saving remains a separate action.</p>
        </section>

        <section className={section}>
          <h2 className={heading}>Questions and removal</h2>
          <p className={paragraph}>Use the private-files page to delete a private cloud copy you own, or the saved removal key to remove a public copy. For privacy questions or help with a copy you cannot remove, email <a className="break-all underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700" href="mailto:aditya@repub.live">aditya@repub.live</a>.</p>
        </section>
      </article>
    </main>
  );
}
