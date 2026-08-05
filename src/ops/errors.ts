export class BrokerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
export function asBrokerError(error: unknown): BrokerError {
  if (error instanceof BrokerError) return error;
  const message = error instanceof Error ? error.message : "unknown error";
  return new BrokerError("INTERNAL", message, 500);
}
