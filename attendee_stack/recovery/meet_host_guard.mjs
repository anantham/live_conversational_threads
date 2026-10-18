/** Operator-only CUA guard. Caller must separately verify actual room/admission. */
export async function joinApprovedMeetHost(tab, { meetingUrl, expectedAccount }) {
  const expected = new URL(meetingUrl);
  const actual = new URL(await tab.url());
  if (expected.origin !== 'https://meet.google.com' || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(expected.pathname)
      || expected.search || expected.hash || actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    throw new Error('Refused: Meet room does not match the approved room.');
  }
  if (typeof expectedAccount !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedAccount)) {
    throw new Error('Refused: an exact approved host account is required.');
  }
  const switcher = tab.playwright.getByRole('link', { name: 'Switch account', exact: true });
  const identityMatches = await switcher.count() === 1 && await switcher.isVisible()
    && await switcher.evaluate((link, account) => {
      const parent = link.parentElement;
      return link.matches('a[data-account-switcher-url]') && parent?.children.length === 2
        && parent.children[1] === link && parent.children[0].textContent.trim() === account;
    }, expectedAccount);
  if (!identityMatches) {
    throw new Error('Refused: the visible Google account differs from the approved host.');
  }
  for (const name of ['Microphone: Permission needed', 'Camera: Permission needed']) {
    const control = tab.playwright.getByRole('button', { name, exact: true });
    if (await control.count() !== 1 || !await control.isVisible() || await control.isEnabled()) {
      throw new Error('Refused: microphone/camera permission state needs inspection.');
    }
  }
  await tab.playwright.getByRole('button', { name: 'Join now', exact: true }).click();
  return { joinAttempted: true };
}

/** Verify the actual Site origin before a handoff; never infer cloud login from preview UI. */
export async function assertApprovedSiteOrigin(tab, siteOrigin) {
  const expected = new URL(siteOrigin), actual = new URL(await tab.url());
  if (expected.protocol !== 'https:' || expected.href !== expected.origin + '/'
      || expected.username || expected.password || actual.username || actual.password
      || actual.origin !== expected.origin) {
    throw new Error('Refused: use the selected live cloud Site, not a separate preview origin.');
  }
  return { origin: expected.origin };
}

/** Read-only operator prerequisite. The session tab must show the actual server JSON. */
export async function requireRecordingOwnerSession(siteTab, sessionTab, { siteOrigin, expectedOwner }) {
  await assertApprovedSiteOrigin(siteTab, siteOrigin);
  await assertApprovedSiteOrigin(sessionTab, siteOrigin);
  const proofURL = new URL(await sessionTab.url());
  if (proofURL.pathname !== '/api/auth/session' || proofURL.search || proofURL.hash
      || typeof expectedOwner !== 'string' || !/^(google|chatgpt):.{1,255}$/.test(expectedOwner)) {
    throw new Error('Refused: an exact approved owner and live session proof are required.');
  }
  const state = JSON.parse(await sessionTab.playwright.evaluate(() => document.body.innerText));
  if (state?.authenticated !== true || state.user?.id !== expectedOwner
      || state.user?.provider !== expectedOwner.split(':')[0]) {
    throw new Error('Refused: the live session does not match the approved recording owner.');
  }
  return { authenticated: true, ownerMatches: true, provider: state.user.provider };
}
