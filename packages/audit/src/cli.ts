import { audit, auditExitCode } from './analyze';
import { renderJson, renderText } from './report';

export const USAGE = `Usage: genui-audit [options] <spec-file>

Audit an A2UI spec (single message, message array, JSONL, or example wrapper)
and print a GenUI Gate quality report.

Options:
  --json     Print the report as JSON instead of text
  --help     Show this help and exit
  --version  Print the CLI version and exit

Exit codes:
  0  audit passed (no parse error, at least one surface record, no blocked live surface)
  1  usage or file read error
  2  audit blocked (parse error, no surfaces at all, or a blocked surface)
`;

export interface CliIo {
  read(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Pure CLI core: returns the process exit code, performs no I/O itself. */
export function runCli(argv: string[], io: CliIo, version: string): number {
  let json = false;
  const files: string[] = [];
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      io.stdout(USAGE);
      return 0;
    } else if (arg === '--version') {
      io.stdout(`${version}\n`);
      return 0;
    } else if (arg.startsWith('--')) {
      io.stderr(`genui-audit: unknown option "${arg}"\n\n${USAGE}`);
      return 1;
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) {
    io.stderr(USAGE);
    return 1;
  }
  if (files.length > 1) {
    io.stderr(`genui-audit: expected exactly one spec file, got ${files.length}\n`);
    return 1;
  }
  const file = files[0]!;
  let raw: string;
  try {
    raw = io.read(file);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    io.stderr(`genui-audit: cannot read file "${file}"${detail}\n`);
    return 1;
  }
  const report = audit(raw);
  const code = auditExitCode(report);
  io.stdout(json ? renderJson(report) : renderText(report));
  return code;
}
