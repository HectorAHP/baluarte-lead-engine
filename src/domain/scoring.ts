export type ScoreClass = "A" | "B" | "C";
/** Tags lead_scores rows produced by the older manual `/api/leads/:id/score` endpoint (this
 * file's formula), as distinct from the Phase 3 conversational-qualifier formulas in
 * qualification-scoring.ts. Required now that lead_scores.rules_version is NOT NULL. */
export const LEGACY_MANUAL_SCORING_RULES_VERSION = "manual-scoring-legacy-v1";
export interface PatrimonialScoreInput { urgency:"THIS_WEEK"|"THIS_MONTH"|"ONE_TO_THREE_MONTHS"|"LATER"|"RESEARCHING"; monthlyCapacity:"LT_3000"|"3000_4999"|"5000_9999"|"10000_19999"|"20000_PLUS"; objectiveDefined:boolean; hasCurrentSavingsOrInvestment:boolean; acceptsMeeting:boolean; }
export interface GmmScoreInput { renewalWindow?:"LE_30"|"31_60"|"61_90"|"GT_90"; wantsNewPolicyThisMonth?:boolean; concreteNeed:boolean; completeInfo:boolean; acceptsMeeting:boolean; }
export interface ScoreResult { total:number; scoreClass:ScoreClass; breakdown:Record<string,number>; }
const classify=(n:number):ScoreClass=>n>=70?"A":n>=45?"B":"C";
export function scorePatrimonial(i:PatrimonialScoreInput):ScoreResult{
 const urgency={THIS_WEEK:30,THIS_MONTH:25,ONE_TO_THREE_MONTHS:15,LATER:5,RESEARCHING:0}[i.urgency];
 const capacity={LT_3000:5,"3000_4999":15,"5000_9999":23,"10000_19999":27,"20000_PLUS":30}[i.monthlyCapacity];
 const breakdown={urgency,monthlyCapacity:capacity,objective:i.objectiveDefined?15:5,currentSavings:i.hasCurrentSavingsOrInvestment?10:0,acceptsMeeting:i.acceptsMeeting?15:0};
 const total=Object.values(breakdown).reduce((a,b)=>a+b,0); return {total,scoreClass:classify(total),breakdown};
}
export function scoreGmm(i:GmmScoreInput):ScoreResult{
 const renewal=i.renewalWindow?{LE_30:30,"31_60":25,"61_90":15,GT_90:5}[i.renewalWindow]:(i.wantsNewPolicyThisMonth?30:0);
 const breakdown={timing:renewal,concreteNeed:i.concreteNeed?20:5,completeInfo:i.completeInfo?20:0,acceptsMeeting:i.acceptsMeeting?30:0};
 const total=Object.values(breakdown).reduce((a,b)=>a+b,0); return {total,scoreClass:classify(total),breakdown};
}
