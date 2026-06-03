/**
 * Spinoto — Permission catalog.
 *
 * Permissions are a fixed set of string codes. Adding a new permission =
 * add an entry here, then gate the relevant route(s) with requirePermission().
 *
 * `is_super_admin` users bypass every check (see middleware/auth.middleware.js).
 *
 * The catalog is exposed verbatim via GET /api/users/permissions so the
 * frontend can render a checklist without hard-coding the list in two places.
 */

const PERMISSIONS = Object.freeze({
  // ---- Users ----
  MANAGE_USERS: {
    code: 'MANAGE_USERS',
    label: 'Manage Users',
    description: 'Create, edit, deactivate, and delete users; grant permissions.',
    group: 'Administration',
  },
  MANAGE_TEAM_PERMISSIONS: {
    code: 'MANAGE_TEAM_PERMISSIONS',
    label: 'Manage Team Permissions',
    description: 'Allow a manager to edit the permissions of their own direct team members.',
    group: 'Administration',
  },

  // ---- Master data ----
  MANAGE_MASTER_DATA: {
    code: 'MANAGE_MASTER_DATA',
    label: 'Manage Master Data',
    description: 'Add, rename, and delete locations, vehicles, services.',
    group: 'Administration',
  },
  MANAGE_PRICING: {
    code: 'MANAGE_PRICING',
    label: 'Manage Pricing',
    description: 'Define and edit pricing rules (service × body type × make/model).',
    group: 'Administration',
  },

  // ---- Leads ----
  CREATE_LEAD: {
    code: 'CREATE_LEAD',
    label: 'Create Lead',
    description: 'Capture new leads via the POS / Lead Entry screen.',
    group: 'Leads',
  },
  VIEW_LEAD: {
    code: 'VIEW_LEAD',
    label: 'View All Leads',
    description: 'View all leads in the system regardless of who created them.',
    group: 'Leads',
  },
  VIEW_TEAM_LEADS: {
    code: 'VIEW_TEAM_LEADS',
    label: 'View Team Leads',
    description: 'View leads created by callers assigned under this manager.',
    group: 'Leads',
  },
  VIEW_OWN_LEADS: {
    code: 'VIEW_OWN_LEADS',
    label: 'View Own Leads',
    description: 'View only leads that this user created themselves.',
    group: 'Leads',
  },
  EDIT_LEAD: {
    code: 'EDIT_LEAD',
    label: 'Edit Lead',
    description: 'Update lead status, notes, and contact details.',
    group: 'Leads',
  },
  DELETE_LEAD: {
    code: 'DELETE_LEAD',
    label: 'Delete Lead',
    description: 'Permanently remove leads. Use sparingly.',
    group: 'Leads',
  },

  // ---- Vehicles ----
  CREATE_VEHICLE: {
    code: 'CREATE_VEHICLE',
    label: 'Create Vehicle',
    description: 'Add new vehicle records (type, make, model, segment, body type).',
    group: 'Vehicles',
  },
  VIEW_VEHICLE: {
    code: 'VIEW_VEHICLE',
    label: 'View Vehicles',
    description: 'View the vehicle listing and individual vehicle details.',
    group: 'Vehicles',
  },
  UPDATE_VEHICLE: {
    code: 'UPDATE_VEHICLE',
    label: 'Update Vehicle',
    description: 'Edit existing vehicle records.',
    group: 'Vehicles',
  },
  DELETE_VEHICLE: {
    code: 'DELETE_VEHICLE',
    label: 'Delete Vehicle',
    description: 'Permanently remove vehicle records. Use with caution.',
    group: 'Vehicles',
  },
  BULK_UPLOAD_VEHICLE: {
    code: 'BULK_UPLOAD_VEHICLE',
    label: 'Bulk Upload Vehicles',
    description: 'Import vehicle records in bulk via CSV or Excel files.',
    group: 'Vehicles',
  },

  // ---- Services ----
  CREATE_SERVICE: {
    code: 'CREATE_SERVICE',
    label: 'Create Service',
    description: 'Add new service categories and service items.',
    group: 'Services',
  },
  VIEW_SERVICE: {
    code: 'VIEW_SERVICE',
    label: 'View Services',
    description: 'Read access to service categories and items.',
    group: 'Services',
  },
  UPDATE_SERVICE: {
    code: 'UPDATE_SERVICE',
    label: 'Update Service',
    description: 'Edit service names, descriptions, and active status.',
    group: 'Services',
  },
  DELETE_SERVICE: {
    code: 'DELETE_SERVICE',
    label: 'Delete Service',
    description: 'Remove service categories or items permanently.',
    group: 'Services',
  },

  // ---- Pricing ----
  CREATE_PRICING_RULE: {
    code: 'CREATE_PRICING_RULE',
    label: 'Create Pricing Rule',
    description: 'Add new pricing rules to any service.',
    group: 'Pricing',
  },
  VIEW_PRICING_RULE: {
    code: 'VIEW_PRICING_RULE',
    label: 'View Pricing Rules',
    description: 'Read access to pricing rules.',
    group: 'Pricing',
  },
  UPDATE_PRICING_RULE: {
    code: 'UPDATE_PRICING_RULE',
    label: 'Update Pricing Rule',
    description: 'Edit existing pricing rule fields and prices.',
    group: 'Pricing',
  },
  DELETE_PRICING_RULE: {
    code: 'DELETE_PRICING_RULE',
    label: 'Delete Pricing Rule',
    description: 'Remove pricing rules permanently.',
    group: 'Pricing',
  },
  TOGGLE_PRICING_STATUS: {
    code: 'TOGGLE_PRICING_STATUS',
    label: 'Toggle Pricing Status',
    description: 'Activate or deactivate pricing rules without full edit access.',
    group: 'Pricing',
  },
  BULK_UPLOAD_PRICING: {
    code: 'BULK_UPLOAD_PRICING',
    label: 'Bulk Upload Pricing',
    description: 'Import pricing rules in bulk via CSV or Excel files.',
    group: 'Pricing',
  },

  // ---- Hubs ----
  CREATE_HUB: {
    code: 'CREATE_HUB',
    label: 'Create Hub',
    description: 'Add new HUB (Aggregator) records.',
    group: 'Hubs',
  },
  VIEW_HUB: {
    code: 'VIEW_HUB',
    label: 'View Hubs',
    description: 'View the HUB list and individual HUB details.',
    group: 'Hubs',
  },
  EDIT_HUB: {
    code: 'EDIT_HUB',
    label: 'Edit Hub',
    description: 'Update HUB details, status, and location.',
    group: 'Hubs',
  },
  ACTIVATE_HUB: {
    code: 'ACTIVATE_HUB',
    label: 'Activate / Deactivate Hub',
    description: 'Toggle a HUB active or inactive without full edit access.',
    group: 'Hubs',
  },
  DELETE_HUB: {
    code: 'DELETE_HUB',
    label: 'Delete Hub',
    description: 'Permanently delete a HUB record.',
    group: 'Hubs',
  },
  MANAGE_HUBS: {
    code: 'MANAGE_HUBS',
    label: 'Manage Hubs (Full)',
    description: 'Legacy full access — create, edit, activate/deactivate, and delete HUBs. Prefer granular permissions above.',
    group: 'Hubs',
  },
  VERIFY_HUB: {
    code: 'VERIFY_HUB',
    label: 'Verify / Reject Hub',
    description: 'Approve or reject a pending hub before it can go live.',
    group: 'Hubs',
  },

  // ---- Appointments ----
  VIEW_APPOINTMENT: {
    code: 'VIEW_APPOINTMENT',
    label: 'View Appointments',
    description: 'View the appointment list and individual appointment details.',
    group: 'Appointments',
  },
  CREATE_APPOINTMENT: {
    code: 'CREATE_APPOINTMENT',
    label: 'Create Appointment',
    description: 'Convert a lead into an appointment or book a new appointment directly.',
    group: 'Appointments',
  },
  EDIT_APPOINTMENT: {
    code: 'EDIT_APPOINTMENT',
    label: 'Edit Appointment',
    description: 'Update appointment status, reschedule, and manage appointment details.',
    group: 'Appointments',
  },

  // ---- Customers ----
  VIEW_CUSTOMER: {
    code: 'VIEW_CUSTOMER',
    label: 'View Customers',
    description: 'View the customer list and individual customer profiles.',
    group: 'Customers',
  },
  EDIT_CUSTOMER: {
    code: 'EDIT_CUSTOMER',
    label: 'Edit Customer Details',
    description: 'Update customer contact details and profile information.',
    group: 'Customers',
  },
  ADD_CUSTOMER_VEHICLE: {
    code: 'ADD_CUSTOMER_VEHICLE',
    label: 'Add Customer Vehicle',
    description: 'Add a new vehicle to a customer profile.',
    group: 'Customers',
  },
  EDIT_CUSTOMER_VEHICLE: {
    code: 'EDIT_CUSTOMER_VEHICLE',
    label: 'Edit Customer Vehicle',
    description: 'Update an existing vehicle on a customer profile.',
    group: 'Customers',
  },
  DELETE_CUSTOMER_VEHICLE: {
    code: 'DELETE_CUSTOMER_VEHICLE',
    label: 'Delete Customer Vehicle',
    description: 'Remove a vehicle from a customer profile.',
    group: 'Customers',
  },

  // ---- Estimates ----
  VIEW_ESTIMATE: {
    code: 'VIEW_ESTIMATE',
    label: 'View Estimates',
    description: 'View the estimate list and individual estimate details.',
    group: 'Estimates',
  },
  CREATE_ESTIMATE: {
    code: 'CREATE_ESTIMATE',
    label: 'Create Estimate',
    description: 'Create new estimates for customers.',
    group: 'Estimates',
  },
  EDIT_ESTIMATE: {
    code: 'EDIT_ESTIMATE',
    label: 'Edit Estimate',
    description: 'Update estimate items, notes, and manage work status.',
    group: 'Estimates',
  },
  SUBMIT_ESTIMATE: {
    code: 'SUBMIT_ESTIMATE',
    label: 'Submit Estimate',
    description: 'Submit an estimate for customer or company review.',
    group: 'Estimates',
  },
  APPROVE_ESTIMATE: {
    code: 'APPROVE_ESTIMATE',
    label: 'Approve Estimate',
    description: 'Company-approve an estimate on behalf of Spinoto.',
    group: 'Estimates',
  },
  REVISE_ESTIMATE: {
    code: 'REVISE_ESTIMATE',
    label: 'Revise Estimate',
    description: 'Send an estimate back for revision after review.',
    group: 'Estimates',
  },

  // ---- Invoices ----
  VIEW_INVOICE: {
    code: 'VIEW_INVOICE',
    label: 'View Invoices',
    description: 'View the invoice list and individual invoice details.',
    group: 'Invoices',
  },
  CREATE_INVOICE: {
    code: 'CREATE_INVOICE',
    label: 'Create Invoice',
    description: 'Generate a new invoice from an appointment or manually.',
    group: 'Invoices',
  },
  EDIT_INVOICE: {
    code: 'EDIT_INVOICE',
    label: 'Edit Invoice',
    description: 'Update invoice status, discount, and notes.',
    group: 'Invoices',
  },
  ADD_INVOICE_PAYMENT: {
    code: 'ADD_INVOICE_PAYMENT',
    label: 'Add / Delete Invoice Payment',
    description: 'Record payment entries against an invoice and delete incorrect payments.',
    group: 'Invoices',
  },

  // ---- Purchase Invoices ----
  VIEW_PURCHASE_INVOICE: {
    code: 'VIEW_PURCHASE_INVOICE',
    label: 'View Purchase Invoices',
    description: 'View the purchase invoice list, payouts, and individual purchase invoice details.',
    group: 'Purchase Invoices',
  },
  CREATE_PURCHASE_INVOICE: {
    code: 'CREATE_PURCHASE_INVOICE',
    label: 'Generate Purchase Invoice',
    description: 'Generate a new purchase invoice for a hub.',
    group: 'Purchase Invoices',
  },
  APPROVE_PURCHASE_INVOICE: {
    code: 'APPROVE_PURCHASE_INVOICE',
    label: 'Approve Purchase Invoice',
    description: 'Approve a pending purchase invoice.',
    group: 'Purchase Invoices',
  },
  RECALCULATE_PURCHASE_INVOICE: {
    code: 'RECALCULATE_PURCHASE_INVOICE',
    label: 'Recalculate Purchase Invoice',
    description: 'Trigger recalculation on a purchase invoice.',
    group: 'Purchase Invoices',
  },
  ADD_PURCHASE_INVOICE_PAYMENT: {
    code: 'ADD_PURCHASE_INVOICE_PAYMENT',
    label: 'Add / Delete Purchase Invoice Payment',
    description: 'Record or delete payment entries (payouts) against a purchase invoice.',
    group: 'Purchase Invoices',
  },

  // ---- CC Categories ----
  VIEW_CC_CATEGORY: {
    code: 'VIEW_CC_CATEGORY',
    label: 'View CC Categories',
    description: 'View and use call-centre categories in the lead capture flow.',
    group: 'CC Categories',
  },
  CREATE_CC_CATEGORY: {
    code: 'CREATE_CC_CATEGORY',
    label: 'Create CC Category',
    description: 'Add new call-centre categories.',
    group: 'CC Categories',
  },
  EDIT_CC_CATEGORY: {
    code: 'EDIT_CC_CATEGORY',
    label: 'Edit CC Category',
    description: 'Update existing call-centre categories.',
    group: 'CC Categories',
  },
  DELETE_CC_CATEGORY: {
    code: 'DELETE_CC_CATEGORY',
    label: 'Delete CC Category',
    description: 'Remove call-centre categories permanently.',
    group: 'CC Categories',
  },
  MANAGE_CC_CATEGORY: {
    code: 'MANAGE_CC_CATEGORY',
    label: 'Manage CC Categories (Full)',
    description: 'Legacy full access — create, edit, and delete call-centre categories. Prefer granular permissions above.',
    group: 'CC Categories',
  },

  // ---- Parts ----
  CREATE_PART: {
    code: 'CREATE_PART',
    label: 'Create Part',
    description: 'Add new parts to the parts catalogue.',
    group: 'Parts',
  },
  EDIT_PART: {
    code: 'EDIT_PART',
    label: 'Edit Part',
    description: 'Update existing parts in the parts catalogue.',
    group: 'Parts',
  },
  DELETE_PART: {
    code: 'DELETE_PART',
    label: 'Delete Part',
    description: 'Remove parts from the parts catalogue permanently.',
    group: 'Parts',
  },
  MANAGE_PARTS: {
    code: 'MANAGE_PARTS',
    label: 'Manage Parts (Full)',
    description: 'Legacy full access — create, edit, and delete parts. Prefer granular permissions above.',
    group: 'Parts',
  },

  // ---- Discounts ----
  CREATE_DISCOUNT: {
    code: 'CREATE_DISCOUNT',
    label: 'Create Discount',
    description: 'Add new discount rules to the discount master.',
    group: 'Discounts',
  },
  EDIT_DISCOUNT: {
    code: 'EDIT_DISCOUNT',
    label: 'Edit Discount',
    description: 'Update existing discount rules.',
    group: 'Discounts',
  },
  DELETE_DISCOUNT: {
    code: 'DELETE_DISCOUNT',
    label: 'Delete Discount',
    description: 'Remove discount rules permanently.',
    group: 'Discounts',
  },
  MANAGE_DISCOUNTS: {
    code: 'MANAGE_DISCOUNTS',
    label: 'Manage Discounts (Full)',
    description: 'Legacy full access — create, edit, and delete discount rules. Prefer granular permissions above.',
    group: 'Discounts',
  },

  // ---- Operations ----
  BULK_UPLOAD: {
    code: 'BULK_UPLOAD',
    label: 'Bulk Upload (All)',
    description: 'Import any master data via CSV / Excel files.',
    group: 'Operations',
  },
  VIEW_REPORTS: {
    code: 'VIEW_REPORTS',
    label: 'View Reports',
    description: 'Access dashboards, summaries, and lead analytics.',
    group: 'Operations',
  },
  EXPORT_LEADS: {
    code: 'EXPORT_LEADS',
    label: 'Export Leads',
    description: 'Download leads as a CSV file (respects the user\'s view scope — own / team / all).',
    group: 'Operations',
  },

  // ---- Leads (extended) ----
  ASSIGN_LEAD: {
    code: 'ASSIGN_LEAD',
    label: 'Assign Lead',
    description: 'Assign or reassign a lead to an agent without needing full edit access.',
    group: 'Leads',
  },
  MANAGE_FOLLOW_UPS: {
    code: 'MANAGE_FOLLOW_UPS',
    label: 'Manage Follow-ups',
    description: 'View, mark done, and manage follow-up events on leads.',
    group: 'Leads',
  },
  VIEW_ALL_NOTIFICATIONS: {
    code: 'VIEW_ALL_NOTIFICATIONS',
    label: 'View All Notifications',
    description: 'See notifications for the entire team, not just own notifications.',
    group: 'Operations',
  },
});

const PERMISSION_CODES = Object.freeze(Object.keys(PERMISSIONS));

/**
 * The full catalog as an array, suitable for shipping to the frontend.
 * Stable order: roughly grouped by area of the app.
 */
const PERMISSION_CATALOG = Object.freeze(Object.values(PERMISSIONS));

/** Throws if any of the provided codes is not a known permission. */
function assertValidCodes(codes) {
  const bad = codes.filter((c) => !PERMISSION_CODES.includes(c));
  if (bad.length) {
    const err = new Error(`Unknown permission(s): ${bad.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

module.exports = {
  PERMISSIONS,
  PERMISSION_CODES,
  PERMISSION_CATALOG,
  assertValidCodes,
};
