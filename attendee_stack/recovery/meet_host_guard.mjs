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
