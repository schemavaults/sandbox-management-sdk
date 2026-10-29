import type { ExecResult, SandboxStatus } from "./types.js";

export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SandboxNotFoundError extends SandboxError {
  constructor(readonly sandboxId: string) {
    super(`Sandbox "${sandboxId}" not found`);
  }
}

export class ProviderNotFoundError extends SandboxError {
  constructor(readonly providerName: string) {
    super(`No sandbox provider registered under the name "${providerName}"`);
  }
}

/** The operation is not allowed while the sandbox is in its current status. */
export class SandboxStateError extends SandboxError {
  constructor(
    readonly sandboxId: string,
    readonly status: SandboxStatus,
    operation: string,
  ) {
    super(`Cannot ${operation} sandbox "${sandboxId}" while it is ${status}`);
  }
}

/** The sandbox stayed in a transitional status for longer than the manager waits. */
export class SandboxBusyError extends SandboxError {
  constructor(
    readonly sandboxId: string,
    readonly status: SandboxStatus,
  ) {
    super(`Timed out waiting for sandbox "${sandboxId}" to leave status ${status}`);
  }
}

/** A lifecycle command (git clone or a setup step) exited non-zero. */
export class SandboxCommandError extends SandboxError {
  constructor(
    readonly step: string,
    readonly result: ExecResult,
  ) {
    const output = (result.stderr || result.stdout).trim().slice(-2000);
    super(`${step} exited with code ${result.exitCode}${output ? `: ${output}` : ""}`);
  }
}

/** Thrown by providers when an operation needs a running sandbox but it is stopped. */
export class ProviderSandboxStoppedError extends SandboxError {
  constructor(readonly providerRef: string) {
    super(`Provider sandbox "${providerRef}" is not running`);
  }
}

/** Thrown by providers when the sandbox no longer exists on the provider. */
export class ProviderSandboxMissingError extends SandboxError {
  constructor(readonly providerRef: string) {
    super(`Provider sandbox "${providerRef}" no longer exists`);
  }
}
