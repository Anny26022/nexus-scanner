export class DataUnavailableError extends Error {
  constructor(message: string, readonly reason: 'not_published' | 'not_found' | 'download_failed') {
    super(message);
    this.name = 'DataUnavailableError';
  }
}

export const retryAnnouncement = (count: number, error: Error) =>
  !(error instanceof DataUnavailableError && error.reason !== 'download_failed') && count < 2;
