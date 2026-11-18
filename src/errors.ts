/**
 * Raised when a query cannot be translated to SQL. This is a programming
 * error (an unsupported construct), so executing such a query dies rather than
 * failing with a typed error.
 */
export class LinqError extends Error {
  override readonly name = "LinqError";
  readonly _tag = "LinqError";
  /** `file:line:column` of the lambda being translated, when known. */
  location: string | undefined;
  constructor(message: string, location?: string) {
    super(message);
    this.location = location;
  }
}

export const fail = (message: string): never => {
  throw new LinqError(message);
};
