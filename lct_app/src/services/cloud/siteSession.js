/** Resolve account state only from the same-origin session API contract. */
export async function checkSiteSession(signal) {
  const response = await fetch('/api/auth/session', {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (![200, 401].includes(response.status) ||
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('The account connection returned an unexpected response.');
  }
  const session = await response.json();
  if (response.status === 401 && session?.authenticated === false) return 'guest';
  if (response.status === 200 && session?.authenticated === true &&
      typeof session.user?.id === 'string' && session.user.id.trim()) return 'signed-in';
  throw new Error('The account connection returned an unreadable session.');
}
