import { expect, test } from '@playwright/test';

test.describe('meeting live captions', () => {
  test('renders transcript websocket frames on the meeting route', async ({ page }) => {
    await page.route('**/api/import/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'healthy' }),
      });
    });

    await page.addInitScript(() => {
      class FakeMeetingWebSocket {
        static OPEN = 1;
        static CLOSED = 3;
        static instances = [];

        constructor(url) {
          this.url = url;
          this.readyState = FakeMeetingWebSocket.OPEN;
          this.sent = [];
          FakeMeetingWebSocket.instances.push(this);
          setTimeout(() => {
            this.onopen?.({ type: 'open' });
          }, 0);
        }

        send(payload) {
          this.sent.push(payload);
        }

        addEventListener(type, handler) {
          this[`on${type}`] = handler;
        }

        removeEventListener(type, handler) {
          if (this[`on${type}`] === handler) this[`on${type}`] = undefined;
        }

        close() {
          this.readyState = FakeMeetingWebSocket.CLOSED;
          this.onclose?.({ type: 'close' });
        }
      }

      window.__meetingSockets = FakeMeetingWebSocket.instances;
      window.WebSocket = FakeMeetingWebSocket as unknown as typeof WebSocket;
      window.__pushMeetingMessage = (payload) => {
        const socket = FakeMeetingWebSocket.instances.find((candidate) =>
          String(candidate.url).includes('/ws/meeting/')
        );
        if (!socket) throw new Error('No meeting websocket instance');
        if (!socket.onmessage) throw new Error('Meeting websocket has no message handler');
        socket.onmessage?.({ data: JSON.stringify(payload) });
      };
    });

    await page.goto('/meeting/e2e-meeting');

    await expect(page.getByText('Live Meeting Graph')).toBeVisible();
    await page.waitForFunction(() =>
      Boolean(
        window.__meetingSockets?.some(
          (socket) => String(socket.url).includes('/ws/meeting/') && socket.onmessage
        ) && window.__pushMeetingMessage
      )
    );

    await page.evaluate(() => {
      window.__pushMeetingMessage({
        type: 'transcript_final',
        text: 'the browser caption path is alive',
        metadata: {
          speaker_name: 'Aditya',
          speaker_uuid: 'speaker-a',
        },
      });
    });

    await expect(page.getByText('Meeting transcript')).toBeVisible();
    await expect(page.getByText('Aditya:')).toBeVisible();
    await expect(page.getByText('the browser caption path is alive')).toBeVisible();

    await page.evaluate(() => {
      window.__pushMeetingMessage({
        type: 'transcript_final',
        text: 'deployment branches avoid rewritten git history',
        metadata: {
          speaker_name: 'Vatsal',
          speaker_uuid: 'speaker-b',
        },
      });
    });

    await page.getByTitle('Expand transcript').click();
    await expect(page.getByText('Threads')).toBeVisible();
    await expect(page.getByText('Vatsal:')).toBeVisible();
    await expect(
      page.getByText('deployment branches avoid rewritten git history', { exact: true })
    ).toBeVisible();
  });
});
