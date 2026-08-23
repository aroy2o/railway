/**
 * Shared query-parameter schemas and the list-response envelope.
 *
 * Every list endpoint validates through these, so pagination behaves the same
 * everywhere and no route can accidentally ship an unbounded result set - the
 * corridors collection has 10,149 documents, and returning all of them because
 * a limit was forgotten is exactly the failure mode to design out.
 */
import { z } from 'zod';

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/**
 * Query params arrive as strings, so `z.coerce.boolean()` is unusable here:
 * it turns the string "false" into `true`. Match the literal instead.
 */
export const booleanParam = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

export const departmentParam = z.enum(['Engineering', 'S&T', 'TRD']);
export type Department = z.infer<typeof departmentParam>;

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  returned: number;
  hasMore: boolean;
}

export interface ListEnvelope<T> {
  data: T[];
  pagination: PaginationMeta;
}

/** Uniform list envelope: `{ data, pagination }`. */
export function listResponse<T>(
  data: T[],
  { total, limit, offset }: { total: number; limit: number; offset: number },
): ListEnvelope<T> {
  return {
    data,
    pagination: {
      total,
      limit,
      offset,
      returned: data.length,
      hasMore: offset + data.length < total,
    },
  };
}
