import { STATUS_CODES } from 'node:http';

/** Extra problem-details members (RFC 9457 extensions), e.g. a stable `code` or the conflicting `runId`. */
export type ProblemExtensions = Record<string, unknown>;

/** An error whose status, detail, and extensions are safe to show to API clients. */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly status: number;
  readonly detail: string;
  readonly extensions: ProblemExtensions;

  constructor(status: number, detail: string, options?: ErrorOptions & { extensions?: ProblemExtensions }) {
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`AppError status must be an integer from 400 to 599, got ${status}`);
    }
    super(detail, options);
    this.status = status;
    this.detail = detail;
    this.extensions = options?.extensions ?? {};
  }
}

/** RFC 9457 problem details body, plus the request id for support correlation and optional extensions. */
export interface ProblemDetails extends ProblemExtensions {
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
