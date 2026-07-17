export type LogFields = Record<string, unknown>;

export function logEvent(event: string, fields: LogFields = {}): void {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), event, ...fields }),
  );
}

export function logError(
  event: string,
  error: unknown,
  fields: LogFields = {},
): void {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      error: error instanceof Error ? error.message : String(error),
      ...fields,
    }),
  );
}
