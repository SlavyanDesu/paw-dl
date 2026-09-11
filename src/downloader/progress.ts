import { Transform } from 'node:stream';

// TTY bars were a nicety; per-file saved/skipped logs already exist.
// No-op tracker keeps call sites unchanged without the dep.
export class ProgressTracker {
  private received = 0;

  constructor(_destination: string) {}

  reset(_attempt: number): void {
    this.received = 0;
  }

  meter(offset: number, _totalBytes: number | null, maxBytes?: number): Transform {
    this.received = offset;

    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.received += chunk.byteLength;

        if (maxBytes !== undefined && this.received > maxBytes) {
          callback(new Error('File exceeds size limit.'));
          return;
        }

        callback(null, chunk);
      },
    });
  }

  setState(_state: string): void {}

  retry(message: string): void {
    console.warn(message.replace(/[\u0000-\u001F\u007F]/g, ' '));
  }

  close(): void {}
}
