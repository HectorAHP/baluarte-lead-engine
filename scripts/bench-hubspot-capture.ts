/**
 * Fase 7C.1 §17 -- local, standalone benchmark re-measuring capture()'s sync-vs-outbox latency
 * gap (Fase 7C's own claim, re-verified here rather than re-asserted from memory). NOT a vitest
 * test -- harness overhead would add noise to p50/p95 measurements. Run with:
 *
 *   npx tsx scripts/bench-hubspot-capture.ts
 *
 * Reports whatever this run actually measured -- no invented SLA, no hardcoded target.
 */
import { WebLeadCaptureService } from "../src/application/web-lead-capture.js";
import { HubSpotFiscalSyncService } from "../src/application/hubspot-fiscal-sync-service.js";
import { LeadService } from "../src/application/services.js";
import {
  InMemoryLeadRepository, InMemoryProcessedEventRepository, InMemoryLeadStatusHistoryRepository,
  InMemoryFiscalLeadScoreRepository, InMemoryHubSpotSyncOutboxRepository, InMemoryAtomicFiscalCaptureRepository,
} from "../src/infrastructure/memory-repositories.js";
import type { HubSpotCRMProvider, Logger } from "../src/application/ports.js";

const NOOP_LOGGER: Logger = { warn: () => {} };

const fiscalCalculator = {
  age: 35, city: "León", taxRegime: "sueldos", filesAnnualReturn: true,
  monthlyIncome: 40000, annualContribution: 20000,
  deductions: { medicalExpenses: 0, tuition: 0, mortgageInterest: 0, other: 0 },
  hasGmm: false, hasPpr: false,
  calculation: { annualIncome: 480000, pprDeductionLimit: 48000, effectivePprContribution: 20000, otherDeductionsConsidered: 0, estimatedTaxBenefitMin: 2000, estimatedTaxBenefitMax: 3000 },
};

function baseInput(i: number) {
  return {
    submissionId: `bench-${i}-${Math.random()}`,
    phone: `477${String(1000000 + i).slice(0, 7)}`,
    email: `bench-${i}-${Math.random()}@example.com`,
    source: "WEB_FISCAL_CALCULATOR",
    consentContact: false,
    privacyAcceptedAt: new Date(),
    fiscalCalculator,
    fiscalCalculatorSnapshot: fiscalCalculator,
    calculationVersion: "ppr_calc_2026_v1",
  };
}

/** Realistic simulated HubSpot latency for the INLINE path (the real network round-trip the
 * outbox path never awaits) -- matches the ~150-300ms range this project's own tests
 * (tests/web-lead-capture-hubspot-outbox.test.ts) already use to model a real HubSpot call. */
function slowHubSpotCrm(delayMs: number): HubSpotCRMProvider {
  return {
    upsertContact: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { hubspotContactId: "hs-bench", created: true };
    },
  };
}

function makeInlineService(hubspotCrm: HubSpotCRMProvider) {
  const leads = new InMemoryLeadRepository();
  const processedEvents = new InMemoryProcessedEventRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const leadService = new LeadService(leads, { create: async () => { throw new Error("unused"); }, listByLeadId: async () => [] }, leadStatusHistory, NOOP_LOGGER);
  const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
  const hubspotSync = new HubSpotFiscalSyncService(hubspotCrm, NOOP_LOGGER);
  return new WebLeadCaptureService(leads, processedEvents, leadService, NOOP_LOGGER, fiscalLeadScores, hubspotSync, { hubspotOutboxEnabled: false });
}

function makeOutboxService(hubspotCrm: HubSpotCRMProvider) {
  const leads = new InMemoryLeadRepository();
  const processedEvents = new InMemoryProcessedEventRepository();
  const leadStatusHistory = new InMemoryLeadStatusHistoryRepository();
  const leadService = new LeadService(leads, { create: async () => { throw new Error("unused"); }, listByLeadId: async () => [] }, leadStatusHistory, NOOP_LOGGER);
  const fiscalLeadScores = new InMemoryFiscalLeadScoreRepository();
  const hubspotOutbox = new InMemoryHubSpotSyncOutboxRepository();
  const atomicFiscalCapture = new InMemoryAtomicFiscalCaptureRepository(fiscalLeadScores, hubspotOutbox);
  const hubspotSync = new HubSpotFiscalSyncService(hubspotCrm, NOOP_LOGGER); // never actually called in this mode
  return new WebLeadCaptureService(leads, processedEvents, leadService, NOOP_LOGGER, fiscalLeadScores, hubspotSync, { hubspotOutboxEnabled: true }, hubspotOutbox, atomicFiscalCapture);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function bench(name: string, run: (i: number) => Promise<void>, n: number) {
  const durations: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await run(i);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  console.log(`${name}: n=${n} p50=${percentile(durations, 50).toFixed(2)}ms p95=${percentile(durations, 95).toFixed(2)}ms min=${durations[0].toFixed(2)}ms max=${durations[durations.length - 1].toFixed(2)}ms`);
}

async function main() {
  const N = 200;
  const HUBSPOT_LATENCY_MS = 200; // realistic simulated HubSpot round-trip

  const inlineService = makeInlineService(slowHubSpotCrm(HUBSPOT_LATENCY_MS));
  await bench("INLINE (HUBSPOT_OUTBOX_ENABLED=false, awaits simulated 200ms HubSpot call)", (i) => inlineService.capture(baseInput(i)).then(() => {}), N);

  const outboxService = makeOutboxService(slowHubSpotCrm(HUBSPOT_LATENCY_MS));
  await bench("OUTBOX (HUBSPOT_OUTBOX_ENABLED=true, atomic capture, never awaits HubSpot)", (i) => outboxService.capture(baseInput(i)).then(() => {}), N);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
