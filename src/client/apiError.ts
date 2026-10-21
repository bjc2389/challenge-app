// An `{error, message}` response from the API (SPEC.md §10). DOM-free, so pure
// client modules and their tests can use it.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
