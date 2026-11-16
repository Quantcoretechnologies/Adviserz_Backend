import { z } from 'zod';
import { AppError } from '../errors/AppError.js';
import { ErrorCode } from '../errors/errorCodes.js';

/**
 * Parse untrusted input against a schema. On failure throws a 422
 * VALIDATION_ERROR listing every problem (path + message), so clients can map
 * errors to form fields.
 */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw AppError.unprocessable(
      'Validation failed',
      ErrorCode.VALIDATION_ERROR,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Reusable primitives */
export const uuidParam = z.object({ id: z.uuid({ error: 'Invalid id' }) });

/**
 * Positive decimal string with at most `scale` fractional digits. Accepts JSON
 * numbers too, but they are converted to strings immediately so no float math
 * ever happens.
 */
export function decimalString(scale: number, label: string) {
  const pattern = new RegExp(`^\\d{1,16}(\\.\\d{1,${scale}})?$`);
  return z
    .union([z.string().trim(), z.number().finite()])
    .transform((value) => (typeof value === 'number' ? value.toString() : value))
    .refine((value) => pattern.test(value), {
      error: `${label} must be a positive number with at most ${scale} decimal places`,
    });
}

/** `?page=` — a whole number from 1. */
export const pageParam = z.coerce
  .number({ error: 'Page must be a number' })
  .int('Page must be a whole number')
  .min(1, 'Page must be at least 1')
  .default(1);

/** `?pageSize=` — a whole number from 1 to `max`. */
export function pageSizeParam(max: number, fallback: number) {
  return z.coerce
    .number({ error: 'Page size must be a number' })
    .int('Page size must be a whole number')
    .min(1, 'Page size must be at least 1')
    .max(max, `Page size must be at most ${max}`)
    .default(fallback);
}

/** Enum with a message that lists the allowed values. */
export function enumOf<const T extends readonly [string, ...string[]]>(values: T, label: string) {
  return z.enum(values, { error: `${label} must be one of: ${values.join(', ')}` });
}

export const paginationQuery = z.object({
  page: pageParam,
  pageSize: pageSizeParam(100, 20),
});

export function toPagination(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
