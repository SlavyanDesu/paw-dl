import { expect, test } from 'bun:test';
import { ProgressTracker } from './progress.ts';

test('tracker lifecycle is safe without a TTY', () => {
  const tracker = new ProgressTracker('/tmp/some-photo.jpg');

  tracker.reset(1);
  const stream = tracker.meter(0, 10);
  expect(stream.writable).toBe(true);
  tracker.setState('finalizing');
  tracker.retry('[Download] x failed');
  tracker.close();
  tracker.close();
});

test('meter aborts past the size cap', async () => {
  const tracker = new ProgressTracker('/tmp/capped.jpg');
  const stream = tracker.meter(0, null, 4);

  try {
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.write(Buffer.alloc(5));
      stream.end();
    });
    expect.unreachable('meter must reject over-cap chunks');
  } catch (error) {
    expect((error as Error).message).toBe('File exceeds size limit.');
  } finally {
    tracker.close();
  }
});
