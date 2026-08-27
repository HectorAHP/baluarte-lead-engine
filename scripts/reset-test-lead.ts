/**
 * CLI entrypoint for the test-lead reset tool.
 *
 * Usage:
 *   npm.cmd run reset:test-lead -- --lead-id <uuid> --conversation-id <uuid>            (dry run)
 *   npm.cmd run reset:test-lead -- --lead-id <uuid> --conversation-id <uuid> --confirm   (reset)
 *
 * All reusable/testable logic (argument parsing, snapshot capture, dry-run/confirmed-reset
 * orchestration, and the real-Supabase main() this file calls) lives in
 * reset-test-lead-lib.ts -- see that file's header for details, and tests/reset-test-lead.test.ts
 * for the unit coverage (all against in-memory repositories, never real Supabase).
 *
 * This file exists ONLY to be executed directly (`tsx scripts/reset-test-lead.ts`), never
 * imported -- so it calls main() unconditionally, with no `require.main`/`import.meta.url` guard.
 * A guard was tried before and removed: the common
 *   `import.meta.url === \`file://${process.argv[1]}\``
 * pattern silently never matches on Windows, because `process.argv[1]` is a raw OS path
 * (backslash-separated, drive letter as typed, no percent-encoding -- e.g.
 * `C:\repo\scripts\reset-test-lead.ts`) while `import.meta.url` is always a proper `file://` URL
 * (forward slashes, an extra leading slash for the drive letter, spaces and other special
 * characters percent-encoded -- e.g. `file:///C:/repo%20path/scripts/reset-test-lead.ts`). The
 * two strings can never be equal on Windows, so the guard's condition was always false, main()
 * was never called, and the process exited immediately with no output and exit code 0 -- exactly
 * the silent-exit symptom this file was rewritten to fix. Splitting main() out into
 * reset-test-lead-lib.ts (which has no top-level side effects on import) removes the need for any
 * such guard here: this file is never imported by anything, so there is no "only run when
 * executed directly" condition left to express.
 */
import { main } from "./reset-test-lead-lib.js";

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
