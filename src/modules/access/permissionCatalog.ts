/**
 * The permission catalog: the single list of everything a staff member can be
 * allowed to do in the admin console.
 *
 * Adding a feature
 *   1. Add its module (or actions) here.
 *   2. Guard its routes with the new keys (see admin.routes.ts).
 *   That is all: the keys are synced to the `permissions` table at server
 *   start, appear as new checkboxes when a role is created, and belong to every
 *   super admin automatically. No existing role receives a new permission.
 *
 * Rules
 *   - A key is `<module>.<action>` and is stored in the database: never rename
 *     or remove one. To withdraw a permission set `retired: true`.
 *   - `requires` lists permissions that must be held together with this one
 *     (blocking a customer is meaningless without being able to view them).
 */

interface ActionDefinition {
  label: string;
  description: string;
  requires?: readonly string[];
  retired?: boolean;
}

interface ModuleDefinition {
  label: string;
  actions: Record<string, ActionDefinition>;
}

const MODULES = {
  users: {
    label: 'Customers',
    actions: {
      view: { label: 'View customers', description: 'See the customer list and each customer profile' },
      view_risk_profiles: {
        label: 'View risk profile history',
        description: 'See every version of a customer risk profile',
        requires: ['users.view'],
      },
      view_activity: {
        label: 'View customer activity',
        description: 'See the audit trail of a customer account',
        requires: ['users.view'],
      },
      block: {
        label: 'Block customers',
        description: 'Block a customer and sign them out of every device',
        requires: ['users.view'],
      },
      unblock: { label: 'Unblock customers', description: 'Restore a blocked customer', requires: ['users.view'] },
    },
  },
  segments: {
    label: 'Segments',
    actions: {
      view: { label: 'View segments', description: 'See trading segments and their capital and risk limits' },
      create: { label: 'Create segments', description: 'Add a new trading segment', requires: ['segments.view'] },
      edit: {
        label: 'Edit segments',
        description: 'Change a segment, its minimum capital and its risk range',
        requires: ['segments.view'],
      },
    },
  },
  policies: {
    label: 'Policies',
    actions: {
      view: { label: 'View policies', description: 'See policy drafts and published versions' },
      create: { label: 'Create policy drafts', description: 'Start a new policy draft', requires: ['policies.view'] },
      edit: { label: 'Edit policy drafts', description: 'Change a policy draft', requires: ['policies.view'] },
      publish: {
        label: 'Publish policies',
        description: 'Publish a draft; every customer must then accept it',
        requires: ['policies.view'],
      },
    },
  },
  analytics: {
    label: 'Analytics',
    actions: {
      view: { label: 'View analytics', description: 'See the dashboard statistics' },
    },
  },
  audit_logs: {
    label: 'Audit logs',
    actions: {
      view: { label: 'View audit logs', description: 'See the full audit trail of the platform' },
    },
  },
  staff: {
    label: 'Staff',
    actions: {
      view: { label: 'View staff', description: 'See the staff accounts in their own branch' },
      create: { label: 'Create staff', description: 'Create staff accounts under themselves', requires: ['staff.view'] },
      edit: { label: 'Edit staff', description: 'Change the details of staff they created', requires: ['staff.view'] },
      block: { label: 'Block staff', description: 'Block a staff member they created', requires: ['staff.view'] },
      unblock: { label: 'Unblock staff', description: 'Restore a blocked staff member', requires: ['staff.view'] },
      reset_password: {
        label: 'Reset staff passwords',
        description: 'Generate a new temporary password for staff they created',
        requires: ['staff.view'],
      },
      delete: {
        label: 'Delete staff',
        description: 'Delete a staff member they created, together with everyone below',
        requires: ['staff.view'],
      },
    },
  },
  roles: {
    label: 'Roles',
    actions: {
      view: { label: 'View roles', description: 'See the roles in their own branch' },
      create: {
        label: 'Create roles',
        description: 'Create roles from the permissions they hold themselves',
        requires: ['roles.view'],
      },
      edit: { label: 'Edit roles', description: 'Rename a role they created or change its permissions', requires: ['roles.view'] },
      assign: {
        label: 'Assign roles',
        description: 'Give roles they created to staff they created, or take them away',
        requires: ['roles.view', 'staff.view'],
      },
      delete: { label: 'Delete roles', description: 'Delete a role they created', requires: ['roles.view'] },
    },
  },
} as const satisfies Record<string, ModuleDefinition>;

type Modules = typeof MODULES;

/** Every permission key, e.g. `'users.block'`. A typo does not compile. */
export type PermissionKey = {
  [M in keyof Modules & string]: `${M}.${keyof Modules[M]['actions'] & string}`;
}[keyof Modules & string];

export interface PermissionDefinition {
  key: PermissionKey;
  module: string;
  moduleLabel: string;
  action: string;
  label: string;
  description: string;
  requires: readonly PermissionKey[];
  retired: boolean;
}

const KEY_PART = /^[a-z][a-z0-9_]*$/;

function buildCatalog(): PermissionDefinition[] {
  const definitions: PermissionDefinition[] = [];
  const modules: Record<string, ModuleDefinition> = MODULES;

  for (const [module, moduleDefinition] of Object.entries(modules)) {
    for (const [action, definition] of Object.entries(moduleDefinition.actions)) {
      if (!KEY_PART.test(module) || !KEY_PART.test(action)) {
        throw new Error(`Permission catalog: "${module}.${action}" must be lower_snake_case`);
      }
      definitions.push({
        key: `${module}.${action}` as PermissionKey,
        module,
        moduleLabel: moduleDefinition.label,
        action,
        label: definition.label,
        description: definition.description,
        requires: (definition.requires ?? []) as readonly PermissionKey[],
        retired: definition.retired ?? false,
      });
    }
  }

  // `requires` is plain text above, so check it here: a broken catalog must
  // stop the server at start rather than misbehave at request time.
  const byKey = new Map(definitions.map((definition) => [definition.key as string, definition]));
  for (const definition of definitions) {
    if (definition.key.length > 100) throw new Error(`Permission catalog: "${definition.key}" is longer than 100 characters`);
    for (const required of definition.requires) {
      const target = byKey.get(required);
      if (!target) throw new Error(`Permission catalog: "${definition.key}" requires unknown "${required}"`);
      if (target.key === definition.key) throw new Error(`Permission catalog: "${definition.key}" requires itself`);
      if (target.retired && !definition.retired) {
        throw new Error(`Permission catalog: "${definition.key}" requires retired "${required}"`);
      }
    }
  }
  return definitions;
}

/** Every permission ever defined, including retired ones, in display order. */
export const PERMISSION_CATALOG: readonly PermissionDefinition[] = buildCatalog();

/** Permissions that can be granted and checked today. */
export const ACTIVE_PERMISSIONS: readonly PermissionDefinition[] = PERMISSION_CATALOG.filter(
  (definition) => !definition.retired,
);

const ACTIVE_KEYS: ReadonlySet<string> = new Set(ACTIVE_PERMISSIONS.map((definition) => definition.key));

/** What a super admin holds: everything that is active. */
export const ALL_PERMISSION_KEYS: ReadonlySet<PermissionKey> = new Set(
  ACTIVE_PERMISSIONS.map((definition) => definition.key),
);

/** True for a known, non-retired key. Use on anything read from the database or a request. */
export function isPermissionKey(value: string): value is PermissionKey {
  return ACTIVE_KEYS.has(value);
}
