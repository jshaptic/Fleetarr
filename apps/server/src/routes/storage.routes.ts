import {
  FS_OPS,
  PATH_FILTER_MODES,
  PATH_SELECTORS,
  parsePathFilter,
  queuePayloadSchemas,
  type FsDirectoriesResponse,
  type FsMeasurement,
  type FsOp,
  type FsPreflight,
  type FsRootsResponse,
  type PathMatrixResponse,
} from '@fleetarr/shared';
import type { FastifyPluginAsync } from 'fastify';
import { PATH_SORTS } from '../services/path-matrix.service.js';
import { z } from 'zod';

const pathQuery = z.object({ path: z.string().min(1) });

const measureQuery = pathQuery.extend({
  maxEntries: z.coerce.number().int().min(100).max(1_000_000).optional(),
});

/** `under` is optional: with nothing given the walk starts at every storage root. */
const directoriesQuery = z.object({
  under: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100_000).optional(),
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

/** Repeatable `path`: refetching every expanded level is one request, not one per level. */
const matrixQuery = z.object({
  path: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])),
  only: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value.split(',')))
    .pipe(z.array(z.enum(PATH_SELECTORS)).nonempty().optional()),
  /**
   * The folder filter: brace patterns, whitespace-separated. Rejected here rather than
   * silently ignored - a filter nobody can read is a filter nobody can debug.
   */
  q: z
    .string()
    .optional()
    .refine((value) => value === undefined || parsePathFilter(value).error === null, {
      message: 'filter could not be read',
    }),
  qmode: z.enum(PATH_FILTER_MODES).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  sort: z.enum(PATH_SORTS).optional(),
  /** Repeatable, like `path`: show only these instances' folders. */
  instance: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))
    .pipe(z.array(z.string()))
    .transform((values) => values.map((value) => Number.parseInt(value, 10)))
    .refine((ids) => ids.every((id) => Number.isInteger(id) && id > 0), {
      message: 'instance must be a positive integer id',
    }),
  refresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

const preflightBody = z.object({
  op: z.enum(FS_OPS),
  payload: z.unknown(),
});

/**
 * Storage inspection. Staging goes through POST /api/queue like everything else - there is
 * deliberately no endpoint here that mutates the disk.
 */
export const storageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/storage/roots', async (): Promise<FsRootsResponse> => app.ctx.filesystem.roots());

  /** Recursive size: opt-in, cancellable, and capped - it can take minutes on an array. */
  app.get('/storage/measure', async (request): Promise<FsMeasurement> => {
    const query = measureQuery.parse(request.query);
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());

    return app.ctx.filesystem.measure(query.path, {
      signal: controller.signal,
      ...(query.maxEntries === undefined ? {} : { maxEntries: query.maxEntries }),
    });
  });

  /**
   * Every directory that could be a destination, flat and cached.
   *
   * Deliberately not `/storage/matrix`: that answers what is going on in one level and
   * summarises a big one down to its problems, which is right for the fleet view and wrong
   * for a picker. This walks the tree for names alone, and stops at a root folder.
   */
  app.get('/storage/directories', async (request): Promise<FsDirectoriesResponse> => {
    const query = directoriesQuery.parse(request.query);

    return app.ctx.pathMatrix.directories({
      ...(query.under === undefined ? {} : { under: query.under }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      refresh: query.refresh,
    });
  });

  /** What would happen if this ran. The executor re-runs it before touching anything. */
  app.post('/storage/preflight', async (request): Promise<FsPreflight> => {
    const body = preflightBody.parse(request.body);
    const op: FsOp = body.op;
    const payload = queuePayloadSchemas[op].parse(body.payload);
    return app.ctx.filesystem.preflight(op, payload);
  });

  /**
   * The joined view: disk truth and *Arr truth, one directory level at a time.
   *
   * Omit `path` for the spine - every mount and the chain down to each root folder.
   */
  app.get('/storage/matrix', async (request): Promise<PathMatrixResponse> => {
    const query = matrixQuery.parse(request.query);

    return app.ctx.pathMatrix.matrix({
      paths: query.path,
      ...(query.only === undefined ? {} : { only: query.only }),
      ...(query.q === undefined ? {} : { filter: query.q }),
      ...(query.qmode === undefined ? {} : { filterMode: query.qmode }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
      ...(query.sort === undefined ? {} : { sort: query.sort }),
      ...(query.instance.length === 0 ? {} : { instanceIds: query.instance }),
      refresh: query.refresh,
    });
  });
};
