import type { ScoreClass } from "./scoring.js";
import type { QualificationVertical } from "./qualification-fields.js";

export interface LeadScoreRecord {
  id: string;
  leadId: string;
  vertical: QualificationVertical;
  total: number;
  scoreClass: ScoreClass;
  /** Numeric per-category points (sums to `total`), plus optional string audit tags such as
   * `readinessReason` -- never mixed into the same key a caller might sum, since those tags are
   * added at persistence time, after the pure scoring math already produced `total`. */
  breakdown: Record<string, number | string>;
  /** Explicit, queryable version of the rules that produced this score (e.g.
   * "PATRIMONIAL_QUALIFICATION_V1", or "manual-scoring-legacy-v1" for the older
   * /api/leads/:id/score endpoint). Required -- every scoring code path must tag its formula. */
  rulesVersion: string;
  createdAt: Date;
}
