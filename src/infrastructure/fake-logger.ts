import type { Logger } from "../application/ports.js";

/** Test double capturing every warn() call so tests can assert a failure was observable
 * through the logger rather than silently swallowed. */
export class FakeLogger implements Logger {
  public readonly warnings: Array<{ details: Record<string, unknown>; message: string }> = [];

  warn(details: Record<string, unknown>, message: string): void {
    this.warnings.push({ details, message });
  }
}
