import { basename } from 'node:path';
import { Transform } from 'node:stream';
import cliProgress from 'cli-progress';

const INITIAL_STATE = { percent: '--', size: '0 B / ?', speed: '--', etaText: '--', state: 'waiting' };

let progressGroup: cliProgress.MultiBar | undefined;
let activeProgressBars = 0;

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export class ProgressTracker {
  private readonly group: cliProgress.MultiBar | undefined;
  private readonly bar: cliProgress.SingleBar | undefined;
  private received = 0;
  private initialBytes = 0;
  private total: number | null = null;
  private startedAt = performance.now();
  private lastUpdate = 0;

  constructor(destination: string) {
    if (process.stderr.isTTY && !progressGroup) {
      progressGroup = new cliProgress.MultiBar(
        {
          format: '{bar} | {filename} | {percent} | {size} | {speed} | ETA {etaText} | {state}',
          barsize: 16,
          fps: 5,
          hideCursor: true,
          clearOnComplete: true,
          stopOnComplete: false,
        },
        cliProgress.Presets.shades_classic,
      );
    }

    this.group = progressGroup;
    const filename = Array.from(basename(destination).replace(/[\u0000-\u001F\u007F]/g, '_'))
      .slice(0, 32)
      .join('');
    this.bar = this.group?.create(1, 0, { filename, ...INITIAL_STATE });
    if (this.bar) {
      activeProgressBars++;
    }
  }

  private render(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastUpdate < 200) {
      return;
    }
    this.lastUpdate = now;

    const elapsedSeconds = (now - this.startedAt) / 1_000;
    // Resumed bytes count toward completion, but not this request's speed.
    const speed = elapsedSeconds > 0 ? (this.received - this.initialBytes) / elapsedSeconds : 0;
    const total = this.total;
    const hasTotal = total !== null && total > 0;
    const percentage = hasTotal ? Math.min((this.received / total) * 100, 100) : null;
    const eta = hasTotal && speed > 0 ? Math.ceil(Math.max(total - this.received, 0) / speed) : null;

    this.bar?.update(hasTotal ? Math.min(this.received, total) : 0, {
      percent: percentage === null ? '--' : `${percentage.toFixed(1)}%`,
      size: `${formatBytes(this.received)} / ${total === null ? '?' : formatBytes(total)}`,
      speed: `${formatBytes(speed)}/s`,
      etaText: eta === null ? '--' : `${eta}s`,
    });
  }

  reset(attempt: number): void {
    this.received = 0;
    this.initialBytes = 0;
    this.total = null;
    this.startedAt = performance.now();
    this.lastUpdate = 0;
    this.bar?.setTotal(1);
    this.bar?.update(0, { ...INITIAL_STATE, state: `request #${attempt}` });
  }

  meter(offset: number, totalBytes: number | null, maxBytes?: number): Transform {
    this.initialBytes = offset;
    this.received = offset;
    this.total = totalBytes;
    this.startedAt = performance.now();
    this.lastUpdate = 0;
    this.bar?.setTotal(totalBytes !== null && totalBytes > 0 ? totalBytes : 1);
    this.bar?.update({ state: offset > 0 ? 'resume' : 'download' });
    this.render(true);

    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.received += chunk.byteLength;

        if (maxBytes !== undefined && this.received > maxBytes) {
          callback(new Error('File exceeds size limit.'));
          return;
        }

        this.render();
        callback(null, chunk);
      },
      flush: (callback) => {
        this.render(true);
        callback();
      },
    });
  }

  setState(state: string): void {
    this.bar?.update({ state, speed: '--', etaText: '--' });
  }

  retry(message: string): void {
    this.setState('waiting for retry');
    const safeMessage = message.replace(/[\u0000-\u001F\u007F]/g, ' ');
    if (this.group) {
      this.group.log(`${safeMessage}\n`);
    } else {
      console.warn(safeMessage);
    }
  }

  close(): void {
    if (!this.group || !this.bar) {
      return;
    }
    this.group.remove(this.bar);
    activeProgressBars--;
    if (activeProgressBars === 0) {
      this.group.stop();
      progressGroup = undefined;
    }
  }
}
