-- RBAC: editable roles with granular permissions; users can hold several roles.
-- Data-preserving: existing admin/viewer (+ can_view_bodies) users are mapped to built-in roles
-- before the old columns are dropped.

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sso_groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "admin_user_roles_role_id_idx" ON "admin_user_roles"("role_id");

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Built-in roles (keep in sync with BUILTIN_ROLES in src/auth/permissions.ts)
INSERT INTO "roles" ("id", "name", "description", "permissions", "sso_groups", "builtin", "updated_at") VALUES
  (gen_random_uuid(), 'Admin', 'Full control of the gateway.', ARRAY['*'], ARRAY['mail-gateway-admins'], true, now()),
  (gen_random_uuid(), 'Operator', 'Manages API keys and the gateway; no user management.',
     ARRAY['dashboard:read','keys:read','keys:create','keys:update','keys:rotate','keys:disable','keys:test_send','messages:read','gateway:pause','audit:read','settings:read'],
     ARRAY[]::TEXT[], true, now()),
  (gen_random_uuid(), 'Approver', 'Reviews and approves/rejects messages from approval-mode keys.',
     ARRAY['dashboard:read','keys:read','messages:read','messages:bodies','approvals:decide'], ARRAY[]::TEXT[], true, now()),
  (gen_random_uuid(), 'Auditor', 'Read-only access to everything, including message bodies and users.',
     ARRAY['dashboard:read','keys:read','messages:read','messages:bodies','users:read','audit:read','settings:read'], ARRAY[]::TEXT[], true, now()),
  (gen_random_uuid(), 'Viewer', 'Read-only access; message bodies hidden.',
     ARRAY['dashboard:read','keys:read','messages:read','audit:read','settings:read'], ARRAY['mail-gateway-viewers'], true, now()),
  (gen_random_uuid(), 'Body reader', 'Adds access to message bodies and HTML previews.',
     ARRAY['messages:bodies'], ARRAY['mail-gateway-body-viewers'], true, now());

-- Map existing users
INSERT INTO "admin_user_roles" ("user_id", "role_id")
SELECT u."id", r."id" FROM "admin_users" u JOIN "roles" r ON r."name" = 'Admin' WHERE u."role" = 'admin';
INSERT INTO "admin_user_roles" ("user_id", "role_id")
SELECT u."id", r."id" FROM "admin_users" u JOIN "roles" r ON r."name" = 'Viewer' WHERE u."role" = 'viewer';
INSERT INTO "admin_user_roles" ("user_id", "role_id")
SELECT u."id", r."id" FROM "admin_users" u JOIN "roles" r ON r."name" = 'Body reader' WHERE u."role" = 'viewer' AND u."can_view_bodies";

-- AlterTable
ALTER TABLE "admin_users" DROP COLUMN "can_view_bodies",
DROP COLUMN "role";

-- DropEnum
DROP TYPE "AdminRole";
