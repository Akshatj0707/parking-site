'use strict';

/*
 * Role-based access control (RBAC). There are exactly three roles and each one has a fixed list of permissions:
 *
 *   customer  anyone who signs up. Books bays and sees ONLY their own bookings.
 *   official  a government official. Sees ALL the data (every booking, every customer, the money, the busiest hours, the
 *             payment records, the spreadsheet download) but changes nothing: no refunds, no settings, no accounts. The
 *             owner creates these logins (see src/auth.js); nobody can sign up as an official.
 *   admin     the owner / operator (OPERATOR_USER and OPERATOR_PASSWORD in the server settings). Sees everything and is the
 *             only one who may refund, run the setup check and create or remove official logins. Nobody can sign up as admin.
 *
 * Every route that is not public asks `can(role, permission)` before it does anything. To give a role a new right, add
 * the permission here, and add a test: the table is the single place that says who may do what.
 */

const PERMISSIONS = {
  'booking:create': 'Book a parking bay',
  'booking:view-own': 'See their own bookings',
  'bookings:view-all': 'See every booking, with payment details',
  'bookings:cancel-refund': 'Cancel a booking and refund the customer',
  'bookings:export': 'Download all bookings as a spreadsheet (CSV)',
  'customers:view': 'See every customer account and what each one has spent',
  'analytics:view': 'See money collected, the busiest hours and the other business numbers',
  'payments:view': 'See the Razorpay connection and payment details',
  'system:view': 'Run the setup check',
  'accounts:manage': 'Create and remove the logins of government officials',
  'samples:manage': 'Add or remove sample bookings (test mode only)',
};

const ROLES = {
  customer: {
    label: 'Customer',
    summary: 'Books a bay and sees only their own bookings.',
    permissions: ['booking:create', 'booking:view-own'],
  },
  official: {
    label: 'Government official',
    summary: 'Sees all the data (every booking, every customer, all payments and numbers) and can download it. Cannot change anything.',
    permissions: ['bookings:view-all', 'bookings:export', 'customers:view', 'analytics:view', 'payments:view'],
  },
  admin: {
    label: 'Admin (owner)',
    summary: 'Full access: all the data, refunds, the settings check, and the logins of government officials.',
    permissions: ['booking:create', 'bookings:view-all', 'bookings:cancel-refund', 'bookings:export', 'customers:view', 'analytics:view', 'payments:view', 'system:view', 'accounts:manage', 'samples:manage'],
  },
};

for (const role of Object.values(ROLES)) {
  for (const p of role.permissions) {
    if (!(p in PERMISSIONS)) throw new Error(`Unknown permission ${p}`);
  }
}

function can(role, permission) {
  const r = Object.prototype.hasOwnProperty.call(ROLES, role) ? ROLES[role] : null;
  return Boolean(r && r.permissions.includes(permission));
}

function permissionsOf(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role) ? ROLES[role].permissions.slice() : [];
}

// The table shown on the owner's page: one row per permission, one column per role.
function matrix() {
  return {
    roles: Object.entries(ROLES).map(([id, r]) => ({ id, label: r.label, summary: r.summary })),
    permissions: Object.entries(PERMISSIONS).map(([id, text]) => ({
      id,
      text,
      roles: Object.keys(ROLES).filter((role) => can(role, id)),
    })),
  };
}

module.exports = { PERMISSIONS, ROLES, can, permissionsOf, matrix };
