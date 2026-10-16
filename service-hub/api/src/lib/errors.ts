export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const fail = (status: number, message: string, details?: unknown): never => {
  throw new HttpError(status, message, details);
};
