export type ApiErrorCode =
  | "BAD_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHENTICATED"
  | "NOT_TEAM_MEMBER"
  | "INSUFFICIENT_ROLE"
  | "RATE_LIMITED"
  | "CSRF_INVALID";

export class ApiError extends Error {
  statusCode: number;
  code: ApiErrorCode;

  constructor(statusCode: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const isApiError = (value: unknown): value is ApiError => {
  return value instanceof ApiError;
};
