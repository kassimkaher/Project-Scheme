export type QaMode = 'analyze' | 'api' | 'web' | 'full';

export type QaLoginType = 'email_password' | 'phone_password' | 'username_password' | 'custom';

/** A statically defined QA account, credentials included. Only ever held in memory or in secrets.enc. */
export type QaAccount = {
  id: string;
  role: string;
  label?: string;
  loginType: QaLoginType;
  credentials: Record<string, string>;
  notes?: string;
};

/** An account with all secret material stripped. Safe for project.json, API responses and the UI. */
export type QaAccountRef = {
  id: string;
  role: string;
  label?: string;
  loginType: QaLoginType;
  /** Names of the credential fields that exist, never their values. */
  credentialKeys: string[];
  notes?: string;
  source: 'static' | 'catalog';
};

/**
 * Points at a live catalog of QA personas, e.g. a JSON endpoint the tested system
 * publishes. Resolved fresh on every run; never cached into the project definition.
 */
export type QaAccountCatalog = {
  url: string;
  /** Persona ids that must resolve, otherwise the run fails preflight. */
  requiredPersonas?: string[];
  /** Roles that must resolve at least one persona, otherwise the run fails preflight. */
  requiredRoles?: string[];
};

export type QaWebApp = { id: string; label: string; url: string };

export type QaEnvironment = {
  id: string;
  label: string;
  kind: 'local' | 'qa' | 'staging' | 'production' | 'other';
  apiBaseUrl?: string;
  openapiUrl?: string;
  webApps: QaWebApp[];
  /** Per-environment catalog; falls back to the project-level one. */
  accountCatalog?: QaAccountCatalog;
};

export type QaSpecQaBlock = {
  preferredLanguage?: string;
  destructiveActions?: 'forbid' | 'allow-build-test-only' | 'allow';
  notes?: string[];
};

/** The imported QA definition, exactly as authored. Credentials present. */
export type QaProjectSpec = {
  version: 1;
  /** Optional stable id supplied by the author; used to match re-imports. */
  projectId?: string;
  system: { name: string; description?: string };
  environments: QaEnvironment[];
  accounts: QaAccount[];
  accountCatalog?: QaAccountCatalog;
  documentation?: Array<{ label: string; url: string }>;
  qa?: QaSpecQaBlock;
};

/** The same definition with every credential value removed. This is what gets persisted plainly. */
export type QaProjectSpecSafe = Omit<QaProjectSpec, 'accounts'> & { accounts: QaAccountRef[] };

// ---------------------------------------------------------------- run stages

export const RUN_STAGES = [
  'queued',
  'preparing',
  'preflight',
  'reading_config',
  'fetching_openapi',
  'resolving_accounts',
  'starting_claude',
  'generating_system_analysis',
  'generating_use_cases',
  'starting_browser',
  'api_testing',
  'web_testing',
  'collecting_evidence',
  'generating_report',
  'completed',
  'failed',
  'cancelled',
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

export const STAGE_LABELS: Record<RunStage, string> = {
  queued: 'Queued',
  preparing: 'Preparing run',
  preflight: 'Preflight checks',
  reading_config: 'Reading project configuration',
  fetching_openapi: 'Fetching OpenAPI',
  resolving_accounts: 'Resolving QA accounts',
  starting_claude: 'Starting Claude Code',
  generating_system_analysis: 'Generating system analysis',
  generating_use_cases: 'Generating use cases',
  starting_browser: 'Starting browser',
  api_testing: 'API testing',
  web_testing: 'Web testing',
  collecting_evidence: 'Collecting evidence',
  generating_report: 'Generating report',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Bounded, redacted failure detail persisted in run.json. Full logs stay in files. */
export type RunFailure = {
  stage: RunStage;
  message: string;
  detail?: string;
  exitCode?: number | null;
  signal?: string | null;
  stdoutTail?: string;
  stderrTail?: string;
  occurredAt: string;
  retryable: boolean;
  /** Which preflight/startup gates were observed to pass, for at-a-glance triage. */
  observed?: {
    claudeStarted?: boolean;
    browserStarted?: boolean;
    openapiFetched?: boolean;
    accountsResolved?: boolean;
    outputWritable?: boolean;
  };
};

export type RunCounts = {
  passed?: number;
  failed?: number;
  blocked?: number;
  total?: number;
  issuesBySeverity?: Partial<Record<'critical' | 'high' | 'medium' | 'low', number>>;
  evidence?: number;
};

export type RunScope = {
  roles?: string[];
  features?: string[];
  useCaseIds?: string[];
  personas?: string[];
};

export type RunRecord = {
  id: string;
  projectId: string;
  projectName: string;
  envId: string;
  mode: QaMode;
  scope?: RunScope;
  status: RunStatus;
  stage: RunStage;
  stageDetail?: string;
  activeUseCase?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  /** Hidden from the active list but kept in history. */
  dismissed?: boolean;
  /** The run this one retries, if any. */
  retryOf?: string;
  pid?: number;
  pgid?: number;
  /** Explicit execution boundary. unsafe-local is not a sandbox. */
  isolationMode?: 'unsafe-local';
  exitCode?: number | null;
  signal?: string | null;
  counts?: RunCounts;
  failure?: RunFailure;
  reportExists?: boolean;
  /** Sanitized launch info for debugging. Never contains secrets. */
  launch?: {
    bin: string;
    resolvedBin?: string;
    args: string[];
    cwd: string;
    model?: string;
    sessionId?: string;
    startedAt: string;
  };
  preflight?: PreflightReport;
};

export type PreflightCheck = {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail?: string;
  /** Actionable remedy shown in the UI when the check does not pass. */
  fix?: string;
  required: boolean;
};

export type PreflightReport = {
  ok: boolean;
  ranAt: string;
  checks: PreflightCheck[];
};

/** Non-sensitive project metadata + counters. This is project.json. */
export type ProjectRecord = {
  id: string;
  name: string;
  description?: string;
  sourceFilename?: string;
  /** Stable fingerprint used to detect re-imports of the same project. */
  fingerprint: string;
  /** Author-supplied stable id, when present. */
  declaredId?: string;
  spec: QaProjectSpecSafe;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  lastRunAt?: string;
  runCount: number;
  latestRunId?: string;
  latestRunStatus?: RunStatus;
  latestReportRunId?: string;
  /** Set when the record was brought forward from the v1 on-disk layout. */
  migratedFrom?: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  description?: string;
  environments: number;
  accounts: number;
  webApps: number;
  hasAccountCatalog: boolean;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  lastRunAt?: string;
  runCount: number;
  latestRunId?: string;
  latestRunStatus?: RunStatus;
};

// ---------------------------------------------------------------- QA artifacts

export type DiscoveredFeature = {
  id: string;
  role: string;
  name: string;
  description?: string;
  routes?: string[];
  apiOperations?: string[];
  status?: 'discovered' | 'verified' | 'blocked';
  children?: DiscoveredFeature[];
};

export type UseCaseActor = {
  /** Logical actor in the scenario, e.g. "author", "reviewer". */
  actor: string;
  role: string;
  /** Persona/account id this actor is played by. */
  accountId: string;
};

export type UseCase = {
  id: string;
  role: string;
  feature: string;
  title: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  mode: 'api' | 'web' | 'cross-role';
  preconditions?: string[];
  /** Multi-role scenarios declare every actor explicitly. */
  actors?: UseCaseActor[];
  accounts?: string[];
  steps: Array<{ actor?: string; action: string; expected: string }>;
  expectedStateTransition?: string;
  evidenceCheckpoints?: string[];
  checks?: string[];
};

export type ResultCase = {
  id: string;
  title?: string;
  role?: string;
  feature?: string;
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  severity?: 'critical' | 'high' | 'medium' | 'low';
  notes?: string;
  evidence?: string[];
};

export type ResultIssue = {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  useCaseId?: string;
  role?: string;
  feature?: string;
  evidence?: string[];
};

export type RunResults = {
  cases: ResultCase[];
  issues: ResultIssue[];
};
