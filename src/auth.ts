import type { NextFunction, Request, Response } from "express";
import { pool } from "./db.js";
import { ApiError } from "./errors.js";

export interface Actor {
  id: number;
  email: string;
  roles: string[];
  permissions: Set<string>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

/**
 * Bearer token stands in for whatever the real identity provider would be. The
 * point of this stage is not the token format -- it is that the roles come from
 * the database on every request and the permission check happens here, on the
 * server, before any handler runs.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return next(new ApiError(401, "unauthenticated", "missing bearer token"));

  const { rows } = await pool.query<{
    id: string; email: string; roles: string[]; permissions: string[];
  }>(
    `SELECT u.id, u.email,
            COALESCE(array_agg(DISTINCT ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL), '{}') AS roles,
            COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM users u
       LEFT JOIN user_roles ur       ON ur.user_id = u.id
       LEFT JOIN role_permissions rp ON rp.role_code = ur.role_code
      WHERE lower(u.email) = lower($1) AND u.is_active
      GROUP BY u.id, u.email`,
    [token],
  );

  const row = rows[0];
  if (!row) return next(new ApiError(401, "unauthenticated", "unknown or inactive user"));

  req.actor = {
    id: Number(row.id),
    email: row.email,
    roles: row.roles,
    permissions: new Set(row.permissions),
  };
  next();
}

/** Route-level authorisation. Returns 403 for an authenticated actor who lacks the permission. */
export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const actor = req.actor;
    if (!actor) return next(new ApiError(401, "unauthenticated", "no actor on request"));
    if (!actor.permissions.has(permission)) {
      return next(
        new ApiError(403, "forbidden", `requires ${permission}`, {
          required: permission,
          held: [...actor.permissions].sort(),
        }),
      );
    }
    next();
  };
}

export function actorOf(req: Request): Actor {
  const actor = req.actor;
  if (!actor) throw new ApiError(401, "unauthenticated", "no actor on request");
  return actor;
}
