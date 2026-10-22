// Who may do what inside a workspace. Pure, so it can be unit-tested and reused by every action.

export const ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "workspace.view"
  | "post.edit"
  | "brand.edit"
  | "brand.create"
  | "brand.archive"
  | "website.manage"
  | "account.connect"
  | "post.approve"
  | "profile.approve"
  | "workspace.manage";

// The lowest role that holds each permission. Roles are ordered, so higher roles inherit.
const MIN_ROLE: Record<Permission, Role> = {
  "workspace.view": "viewer",
  "post.edit": "editor",
  "brand.edit": "editor",
  "brand.create": "admin",
  "brand.archive": "admin",
  "website.manage": "admin",
  "account.connect": "admin",
  "post.approve": "admin",
  "profile.approve": "admin",
  "workspace.manage": "owner",
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role || !isRole(role)) return false;
  return ROLES.indexOf(role) >= ROLES.indexOf(MIN_ROLE[permission]);
}

export class AccessDenied extends Error {
  constructor(permission: Permission) {
    super(`You don't have permission to do this (${permission}).`);
    this.name = "AccessDenied";
  }
}

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found.`);
    this.name = "NotFound";
  }
}

export function assertCan(role: Role, permission: Permission) {
  if (!can(role, permission)) throw new AccessDenied(permission);
}
