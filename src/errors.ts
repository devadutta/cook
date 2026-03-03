export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class PolicyError extends CliError {
  constructor(message: string, exitCode = 4) {
    super(message, exitCode);
    this.name = 'PolicyError';
  }
}
