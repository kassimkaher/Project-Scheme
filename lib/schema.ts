import { z } from 'zod';

const accountSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  label: z.string().optional(),
  loginType: z.enum(['email_password', 'phone_password', 'username_password', 'custom']).default('email_password'),
  credentials: z.record(z.string()).default({}),
  notes: z.string().optional(),
});

const accountCatalogSchema = z.object({
  url: z.string().url(),
  requiredPersonas: z.array(z.string()).optional(),
  requiredRoles: z.array(z.string()).optional(),
});

const envSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['local', 'qa', 'staging', 'production', 'other']),
  apiBaseUrl: z.string().url().optional(),
  openapiUrl: z.string().url().optional(),
  webApps: z.array(z.object({ id: z.string(), label: z.string(), url: z.string().url() })).default([]),
  accountCatalog: accountCatalogSchema.optional(),
});

export const projectSpecSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1).optional(),
  system: z.object({ name: z.string().min(1), description: z.string().optional() }),
  environments: z.array(envSchema).min(1),
  accounts: z.array(accountSchema).default([]),
  accountCatalog: accountCatalogSchema.optional(),
  documentation: z.array(z.object({ label: z.string(), url: z.string().url() })).optional(),
  qa: z.object({
    preferredLanguage: z.string().optional(),
    destructiveActions: z.enum(['forbid', 'allow-build-test-only', 'allow']).optional(),
    notes: z.array(z.string()).optional(),
  }).optional(),
});

export const runScopeSchema = z.object({
  roles: z.array(z.string()).optional(),
  features: z.array(z.string()).optional(),
  useCaseIds: z.array(z.string()).optional(),
  personas: z.array(z.string()).optional(),
}).optional();

export const startRunSchema = z.object({
  envId: z.string().min(1),
  mode: z.enum(['analyze', 'api', 'web', 'full']),
  scope: runScopeSchema,
  /** When false the run starts even if a required preflight check failed. */
  enforcePreflight: z.boolean().default(true),
});

/** Patch shape accepted by the project configuration editor. Credentials are never accepted here. */
export const projectPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  environments: z.array(envSchema).min(1).optional(),
  accountCatalog: accountCatalogSchema.nullable().optional(),
  documentation: z.array(z.object({ label: z.string(), url: z.string().url() })).optional(),
  qa: z.object({
    preferredLanguage: z.string().optional(),
    destructiveActions: z.enum(['forbid', 'allow-build-test-only', 'allow']).optional(),
    notes: z.array(z.string()).optional(),
  }).optional(),
  /** Account metadata only: role/label/notes/loginType. Values of credentials stay untouched. */
  accounts: z.array(z.object({
    id: z.string().min(1),
    role: z.string().min(1),
    label: z.string().optional(),
    loginType: z.enum(['email_password', 'phone_password', 'username_password', 'custom']),
    notes: z.string().optional(),
  })).optional(),
});

export const importSchema = z.object({
  raw: z.string().min(1),
  filename: z.string().optional(),
  /** How to resolve a collision with an existing project. */
  onConflict: z.enum(['ask', 'update', 'copy']).default('ask'),
  /** Explicit target when the user chose "update existing". */
  targetProjectId: z.string().optional(),
});
