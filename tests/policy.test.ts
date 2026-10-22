import { test } from "node:test";
import assert from "node:assert/strict";
import { AccessDenied, assertCan, can, ROLES, type Permission } from "../src/lib/social/policy";

const ALL: Permission[] = ["workspace.view", "post.edit", "brand.edit", "brand.create", "brand.archive", "website.manage", "account.connect", "post.approve", "workspace.manage"];

test("viewer can only view", () => {
  assert.deepEqual(ALL.filter((p) => can("viewer", p)), ["workspace.view"]);
});

test("editor can write posts and edit brands but not create them or approve", () => {
  assert.ok(can("editor", "post.edit"));
  assert.ok(can("editor", "brand.edit"));
  for (const p of ["brand.create", "website.manage", "account.connect", "post.approve", "workspace.manage"] as Permission[]) assert.equal(can("editor", p), false, p);
});

test("admin can do everything except manage the workspace", () => {
  assert.deepEqual(ALL.filter((p) => !can("admin", p)), ["workspace.manage"]);
});

test("owner can do everything", () => {
  assert.ok(ALL.every((p) => can("owner", p)));
});

test("higher roles never lose a permission a lower role has", () => {
  for (let i = 1; i < ROLES.length; i++) for (const p of ALL) if (can(ROLES[i - 1], p)) assert.ok(can(ROLES[i], p), `${ROLES[i]} ${p}`);
});

test("unknown or missing roles get nothing", () => {
  for (const role of [null, undefined, "superuser", ""]) assert.ok(ALL.every((p) => !can(role as never, p)));
});

test("assertCan throws AccessDenied", () => {
  assert.throws(() => assertCan("viewer", "brand.create"), AccessDenied);
  assert.doesNotThrow(() => assertCan("owner", "workspace.manage"));
});
