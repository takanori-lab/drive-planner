export type ErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'method_not_allowed'
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'ai_unavailable'
  | 'ai_timeout'
  | 'ai_invalid_response'
  | 'routing_not_configured'
  | 'routing_timeout'
  | 'routing_unavailable'
  | 'routing_invalid_response'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function errorResponse(error: ApiError, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  if (error.retryAfterSeconds !== undefined) responseHeaders.set('Retry-After', String(error.retryAfterSeconds));
  return Response.json({
    status: 'error',
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    },
  }, { status: error.status, headers: responseHeaders });
}
