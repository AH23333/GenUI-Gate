export { audit, auditExitCode } from './analyze';
export { renderJson, renderText } from './report';
export { runCli, USAGE, type CliIo } from './cli';
export type {
  A11yBaseline,
  AuditReport,
  IssueGroup,
  RuleHit,
  RuleHitSample,
  SurfaceAudit,
} from './types';
