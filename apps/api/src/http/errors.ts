import { STATUS_CODES } from 'node:http';

/** An error whose status and detail are safe to show to API clients. */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string, options?: ErrorOptions) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`AppError status must be an integer from 400 to 599, got ${status}`);
    }
    super(detail, options);
    this.status = status;
    this.detail = detail;
  }
}

/** RFC 9457 problem details body, plus the request id for support correlation. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
}

export function statusTitle(status: number): string {
  return STATUS_CODES[status] ?? 'Error';
}
