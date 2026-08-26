/**
 * Step-1 critic set (kickoff scope): 3 IRS-lens + 7 accountant-lens critics.
 * All pure, deterministic, rule-data-driven. Money math is Money-only —
 * native arithmetic operators are lint-banned in this directory.
 */
import {
  C,
  FED_INCOME_CONCEPTS,
  Money,
  THIRD_PARTY_FORM_BY_CONCEPT,
  type Jurisdiction,
  type TaxFact,
} from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import type { Critic, CriticContext, FindingDraft } from '../critic';

// ---------- shared helpers (pure) ----------

function sourcedFacts(ctx: CriticContext): TaxFact[] {
  return ctx.facts.filter((f) => f.derivation === undefined);
}

function derivedFact(ctx: CriticContext, concept: string): TaxFact | undefined {
  return ctx.facts.find((f) => f.concept === concept && f.derivation !== undefined);
}

function sumSourced(ctx: CriticContext, concept: string): { total: Money; ids: string[] } {
  const facts = sourcedFacts(ctx).filter((f) => f.concept === concept && f.status === 'confirmed');
  return {
    total: Money.sum(facts.map((f) => f.value.roundToDollar())),
    ids: facts.map((f) => f.fact_id),
  };
}

function inJurisdiction(f: TaxFact, jur: Jurisdiction): boolean {
  return f.jurisdiction.includes(jur);
}

// ---------- IRS lens ----------

interface TranscriptRecord {
  form: string;
  payer: string;
  concept: string;
  amount: string;
}

function transcriptRecords(ctx: CriticContext): TranscriptRecord[] | undefined {
  const t = ctx.sources.find((s) => s.type === 'IRS_WI_TRANSCRIPT');
  const raw = t?.fields['records'];
  if (raw === undefined) return undefined;
  return JSON.parse(raw) as TranscriptRecord[];
}

/**
 * IRS-INCOME-RECON (gate 2): every income fact reconciles to the IRS Wage &
 * Income transcript.
 *
 * LIMITATION (spec v0.2): the transcript only shows income *reported to the
 * IRS*. Below-threshold self-employment income (NEC/MISC under the current
 * threshold `(verify)`, sub-threshold 1099-K) issues no form and never
 * appears on the transcript — "no 1099 ≠ no income". When Sch C lands
 * (step 2+), transcript matching must be paired with a ledger-based
 * completeness prompt; absence of a form is never treated as absence of
 * income. Step-1 concepts are all form-reported, so matching is sufficient
 * here.
 */
export const irsIncomeRecon: Critic = {
  id: 'IRS-INCOME-RECON',
  lens: 'IRS',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: (ctx) => transcriptRecords(ctx) !== undefined,
  evaluate(ctx) {
    const records = transcriptRecords(ctx) ?? [];
    const findings: FindingDraft[] = [];
    const incomeFacts = sourcedFacts(ctx).filter(
      (f) => FED_INCOME_CONCEPTS.includes(f.concept) && f.status === 'confirmed',
    );
    const matched = new Set<string>();
    for (const rec of records) {
      const hit = incomeFacts.find(
        (f) => !matched.has(f.fact_id) && f.concept === rec.concept && f.value.eq(Money.fromString(rec.amount)),
      );
      if (hit) {
        matched.add(hit.fact_id);
      } else {
        findings.push({
          critic_id: this.id,
          lens: 'IRS',
          severity: 'Error',
          affected: [rec.concept],
          message: `On transcript but not on return: ${rec.form} from ${rec.payer} (${rec.concept} ${rec.amount}) — omitted income`,
          fix_ref: 'fix://income/add-missing-document',
          defense_artifact_ref: 'defense://transcript-reconciliation-report',
        });
      }
    }
    for (const f of incomeFacts) {
      if (!matched.has(f.fact_id)) {
        findings.push({
          critic_id: this.id,
          lens: 'IRS',
          severity: 'Flag',
          affected: [f.fact_id],
          message: `On return but not on transcript: ${f.concept} ${f.value.toString()} — verify or possible duplicate`,
          fix_ref: 'fix://income/verify-unmatched-fact',
        });
      }
    }
    return findings;
  },
};

/** IRS-DOC-MATCH (gate 2): each W-2/1099-type fact traces to its expected third-party form. */
export const irsDocMatch: Critic = {
  id: 'IRS-DOC-MATCH',
  lens: 'IRS',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    for (const f of sourcedFacts(ctx)) {
      const expectedForms = THIRD_PARTY_FORM_BY_CONCEPT[f.concept];
      if (expectedForms === undefined) continue;
      const sourceIds = (f.provenance ?? []).map((p) => p.source_id);
      const hasForm = ctx.sources.some((s) => sourceIds.includes(s.source_id) && expectedForms.includes(s.type));
      if (!hasForm) {
        findings.push({
          critic_id: this.id,
          lens: 'IRS',
          severity: 'Flag',
          affected: [f.fact_id],
          message: `${f.concept} fact is not backed by its expected third-party form (${expectedForms.join(' or ')})`,
          fix_ref: 'fix://documents/attach-form',
        });
      }
    }
    return findings;
  },
};

/** IRS-ROUNDNUM (gate 5): suspicious round-number pattern across source-entered amounts. */
export const irsRoundNum: Critic = {
  id: 'IRS-ROUNDNUM',
  lens: 'IRS',
  gates: [5],
  jurisdiction: ['FED', 'IL'],
  applies_when: () => true,
  evaluate(ctx) {
    const rules = ctx.jurisdiction === 'FED' ? ctx.fed_rules : ctx.il_rules;
    const multiple = rules.audit.round_number_multiple;
    const hits = sourcedFacts(ctx).filter(
      (f) => inJurisdiction(f, ctx.jurisdiction) && !f.value.isZero() && f.value.isMultipleOf(multiple),
    );
    if (hits.length >= rules.audit.round_number_min_count) {
      return [
        {
          critic_id: this.id,
          lens: 'IRS',
          severity: 'Audit-Risk',
          affected: hits.map((f) => f.fact_id),
          message: `${hits.length} source amounts are exact multiples of ${multiple} — round-number pattern draws attention (threshold ${rules.audit.round_number_min_count} — preliminary in this release)`,
          fix_ref: 'fix://evidence/attach-exact-substantiation',
          defense_artifact_ref: 'defense://substantiation-index',
        },
      ];
    }
    return [];
  },
};

// ---------- Accountant lens ----------

/** ACC-DOC-COMPLETE (gate 2): uploaded document with no extracted/confirmed fact. */
export const accDocComplete: Critic = {
  id: 'ACC-DOC-COMPLETE',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const referenced = new Set(
      sourcedFacts(ctx).flatMap((f) => (f.provenance ?? []).map((p) => p.source_id)),
    );
    for (const s of ctx.sources) {
      if (s.type === 'IRS_WI_TRANSCRIPT') continue;
      // The persisted Get Started election (P29/P91) is a settings record,
      // not a document — it never produces TaxFacts and must not read as one.
      // P91 made the id per-client (profile-<tenant>); the legacy shared id
      // still exists in older data.
      if (s.source_id === 'profile-settings' || s.source_id.startsWith('profile-')) continue;
      if (!referenced.has(s.source_id)) {
        findings.push({
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [s.source_id],
          message: `Document ${s.source_id} (${s.type}) is present but no TaxFact was extracted from it — completeness gap`,
          fix_ref: 'fix://documents/extract-and-confirm',
        });
      }
    }
    return findings;
  },
};

/** ACC-STD-VS-ITEM (gate 2): the applied deduction must be the greater of standard vs itemized. */
export const accStdVsItem: Critic = {
  id: 'ACC-STD-VS-ITEM',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: (ctx) => derivedFact(ctx, C.FED_DEDUCTION) !== undefined,
  evaluate(ctx) {
    const applied = derivedFact(ctx, C.FED_DEDUCTION);
    const std = derivedFact(ctx, C.FED_STD_DEDUCTION);
    if (!applied || !std) return [];
    const itemized = sumSourced(ctx, C.ITEMIZED);
    const best = Money.max(std.value, itemized.total);
    if (!applied.value.eq(best)) {
      return [
        {
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Optimization',
          affected: [applied.fact_id],
          message: `Applied deduction ${applied.value.toString()} is not the greater of standard (${std.value.toString()}) vs itemized (${itemized.total.toString()}) — money left on the table`,
          fix_ref: 'fix://deduction/use-greater-of',
        },
      ];
    }
    return [];
  },
};

/**
 * ACC-WITHHOLD-RECON (gates 2/4): withholding + estimated payments reconcile.
 * Gate 2: each sourced withholding fact matches its source-document field.
 * Gate 4: the derived payments total equals the sum of sourced payment facts.
 */
export const accWithholdRecon: Critic = {
  id: 'ACC-WITHHOLD-RECON',
  lens: 'ACCOUNTANT',
  gates: [2, 4],
  jurisdiction: ['FED', 'IL'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const paymentConcepts =
      ctx.jurisdiction === 'FED'
        ? [C.FED_WITHHOLDING, C.FED_ESTIMATED]
        : [C.IL_WITHHOLDING, C.IL_ESTIMATED];
    if (ctx.gate === 2) {
      for (const concept of paymentConcepts) {
        for (const f of sourcedFacts(ctx).filter((x) => x.concept === concept)) {
          for (const p of f.provenance ?? []) {
            const source = ctx.sources.find((s) => s.source_id === p.source_id);
            const docValue = source?.fields[p.source_field];
            if (docValue !== undefined && !f.value.eq(Money.fromString(docValue))) {
              findings.push({
                critic_id: this.id,
                lens: 'ACCOUNTANT',
                severity: 'Error',
                affected: [f.fact_id],
                message: `${concept} fact ${f.value.toString()} does not match document field ${p.source_field}=${docValue} on ${p.source_id}`,
                fix_ref: 'fix://payments/reconfirm-document-field',
              });
            }
          }
        }
      }
      return findings;
    }
    const totalConcept = ctx.jurisdiction === 'FED' ? C.FED_PAYMENTS : C.IL_PAYMENTS;
    const derived = derivedFact(ctx, totalConcept);
    if (!derived) return [];
    // Documented payments PLUS the derived payment-side lines the 1040
    // carries: refundable net PTC (line 31) and Form 8959 additional
    // Medicare withholding (line 25c) — omitting them false-failed every
    // PTC/8959 return (P11 smoke-test finding).
    const derivedPaymentAddons =
      ctx.jurisdiction === 'FED'
        ? [derivedFact(ctx, C.FED_PTC_NET), derivedFact(ctx, C.FED_ADDL_MEDICARE_WH)]
        : [];
    const expected = Money.sum([
      ...paymentConcepts.map((c2) => sumSourced(ctx, c2).total),
      ...derivedPaymentAddons.map((f) => (f ? f.value : Money.zero())),
    ]);
    if (!derived.value.eq(expected)) {
      findings.push({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Error',
        affected: [derived.fact_id],
        message: `${totalConcept} ${derived.value.toString()} ≠ sum of documented payments (+ net PTC / 8959 withholding) ${expected.toString()}`,
        fix_ref: 'fix://payments/recompute',
      });
    }
    return findings;
  },
};

/** ACC-TIEOUT-FORM (gate 4): every form-total line re-adds to the components
 * the kernel ITSELF recorded for it.
 *
 * TaxFS §3.2 rewrite (the P76/P94 lesson, twice-earned): this critic used to
 * restate the kernel's formulas by hand — "AGI = total income − adjustments
 * − ½SE − HSA − ..." — and silently drifted every time the kernel gained a
 * term (QBI, then HSA/½SE), blaming the operator for our defect. It now
 * consumes the calculation graph the kernel emits: each form-total line's
 * Calculation carries signed `terms`, and the check is Σ sign·term == line
 * (with the recorded zero-clamp where the form has one). There is no second
 * copy of any formula left to drift — a new deduction added to the kernel's
 * terms is covered here automatically. */
export const accTieoutForm: Critic = {
  id: 'ACC-TIEOUT-FORM',
  lens: 'ACCOUNTANT',
  gates: [4],
  jurisdiction: ['FED', 'IL'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const byId = new Map(ctx.facts.map((f) => [f.fact_id, f]));
    for (const calc of ctx.calculations) {
      const terms = calc.terms;
      if (!terms || terms.length === 0) continue;
      const out = byId.get(calc.output_fact_id);
      if (!out || !inJurisdiction(out, ctx.jurisdiction)) continue;
      let expected = Money.zero();
      const parts: string[] = [];
      let missing = false;
      for (const term of terms) {
        const tf = byId.get(term.fact_id);
        if (!tf) {
          findings.push({
            critic_id: this.id,
            lens: 'ACCOUNTANT',
            severity: 'Error',
            affected: [calc.output_fact_id],
            message: `Tie-out cannot verify ${calc.concept}: its recorded component ${term.concept} is missing from the fact set. Re-run the gates; if this persists it is a TaxFS defect, not a data problem — report it.`,
            fix_ref: 'fix://compute/rerun',
          });
          missing = true;
          break;
        }
        expected = term.sign === 1 ? expected.add(tf.value) : expected.sub(tf.value);
        parts.push(`${term.sign === 1 ? '+' : '\u2212'} ${term.concept} = ${tf.value.toString()}`);
      }
      if (missing) continue;
      if (calc.clamp_zero) expected = Money.max(Money.zero(), expected);
      if (!out.value.eq(expected)) {
        const diff = out.value.sub(expected);
        findings.push({
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [out.fact_id],
          message: `Tie-out failure on ${calc.concept}: the form carries ${out.value.toString()}, but re-adding the components the kernel itself recorded for this line (${parts.join(', ')})${calc.clamp_zero ? ', clamped at zero,' : ''} gives ${expected.toString()} \u2014 a difference of ${diff.toString()}. You did not cause this and cannot fix it by editing data: both totals come from the same recorded components, so if re-running the gates does not clear it, TaxFS itself computed one of them wrong \u2014 report the difference shown here.`,
          fix_ref: 'fix://mapping/correct-form-line',
        });
      }
    }
    return findings;
  },
};

/**
 * ACC-METHOD (gate 4): IRS-method-correct — whole-dollar rounding on every
 * line, greater-of deduction applied, and every derived line reproduces
 * under an independent kernel recomputation from sourced facts (table vs
 * worksheet selection, rounding convention, ordering).
 */
export const accMethod: Critic = {
  id: 'ACC-METHOD',
  lens: 'ACCOUNTANT',
  gates: [4],
  jurisdiction: ['FED', 'IL'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const derivedHere = ctx.facts.filter(
      (f) => f.derivation !== undefined && inJurisdiction(f, ctx.jurisdiction),
    );
    for (const f of derivedHere) {
      if (!f.value.isWholeDollars()) {
        findings.push({
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [f.fact_id],
          message: `${f.concept} = ${f.value.toString()} is not whole-dollar rounded (IRS convention)`,
          fix_ref: 'fix://method/rounding',
        });
      }
    }
    const recomputed = compute({
      taxpayer_id: ctx.filing.taxpayer_id,
      tax_year: ctx.filing.tax_year,
      ctx: ctx.filing,
      facts: sourcedFacts(ctx),
      fed_rules: ctx.fed_rules,
      il_rules: ctx.il_rules,
    });
    const byConcept = new Map(recomputed.computedFacts.map((f) => [f.concept, f.value]));
    for (const f of derivedHere) {
      const expected = byConcept.get(f.concept);
      if (expected !== undefined && !expected.eq(f.value)) {
        findings.push({
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [f.fact_id],
          message: `${f.concept} = ${f.value.toString()} does not reproduce under method recomputation (expected ${expected.toString()})`,
          fix_ref: 'fix://method/recompute',
        });
      }
    }
    return findings;
  },
};

/** ACC-SANITY (gate 4): effective-rate band, sign/edge cases, refund plausibility. */
export const accSanity: Critic = {
  id: 'ACC-SANITY',
  lens: 'ACCOUNTANT',
  gates: [4],
  jurisdiction: ['FED', 'IL'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const flag = (affected: string[], message: string): void => {
      findings.push({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected,
        message,
        fix_ref: 'fix://review/manual-check',
      });
    };
    if (ctx.jurisdiction === 'FED') {
      const income = derivedFact(ctx, C.FED_TOTAL_INCOME);
      const tax = derivedFact(ctx, C.FED_TAX);
      const taxable = derivedFact(ctx, C.FED_TAXABLE);
      if (taxable && taxable.value.isNegative()) {
        flag([taxable.fact_id], `Taxable income is negative: ${taxable.value.toString()}`);
      }
      if (income && tax && !income.value.isZero() && !income.value.isNegative()) {
        const cap = income.value.mulRate(ctx.fed_rules.audit.effective_rate_max);
        if (tax.value.gt(cap)) {
          flag(
            [tax.fact_id],
            `Effective rate exceeds ${ctx.fed_rules.audit.effective_rate_max} band: tax ${tax.value.toString()} on income ${income.value.toString()} (a preliminary band in this release)`,
          );
        }
      }
      if (income && tax && income.value.isZero() && !tax.value.isZero()) {
        flag([tax.fact_id], `Nonzero tax ${tax.value.toString()} on zero income`);
      }
      // 1099-DIV box 1b (qualified) is a subset of box 1a (ordinary); an
      // excess is impossible data and silently distorts the cap-gain
      // worksheet (auditor finding F5).
      const qualified = sumSourced(ctx, C.DIV_QUALIFIED);
      const ordinaryDiv = sumSourced(ctx, C.DIV_ORDINARY);
      if (qualified.total.gt(ordinaryDiv.total)) {
        flag(
          qualified.ids,
          `Qualified dividends ${qualified.total.toString()} exceed ordinary dividends ${ordinaryDiv.total.toString()} — box 1b can never exceed box 1a — re-check the two dividend boxes on the document`,
        );
      }
      return findings;
    }
    const base = derivedFact(ctx, C.IL_BASE_INCOME);
    const ilTax = derivedFact(ctx, C.IL_TAX);
    if (base && ilTax && !base.value.isZero() && !base.value.isNegative()) {
      const cap = base.value.mulRate(ctx.il_rules.audit.effective_rate_max);
      if (ilTax.value.gt(cap)) {
        flag(
          [ilTax.fact_id],
          `IL effective rate exceeds ${ctx.il_rules.audit.effective_rate_max} band: tax ${ilTax.value.toString()} on base ${base.value.toString()}`,
        );
      }
    }
    if (ilTax && ilTax.value.isNegative()) {
      flag([ilTax.fact_id], `IL tax is negative: ${ilTax.value.toString()}`);
    }
    return findings;
  },
};

/** ACC-IL-SUBTRACT (gates 2/4, IL): Sch M subtractions correctly applied (SS/retirement not taxed). */
export const accIlSubtract: Critic = {
  id: 'ACC-IL-SUBTRACT',
  lens: 'ACCOUNTANT',
  gates: [2, 4],
  jurisdiction: ['IL'],
  applies_when: (ctx) => derivedFact(ctx, C.IL_SUBTRACTIONS) !== undefined,
  evaluate(ctx) {
    const il = ctx.il_rules.il;
    const derived = derivedFact(ctx, C.IL_SUBTRACTIONS);
    if (!il || !derived) return [];
    const eligible = Money.sum(
      il.sch_m_subtraction_concepts.map((concept) => sumSourced(ctx, concept).total),
    );
    if (derived.value.lt(eligible)) {
      return [
        {
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [derived.fact_id],
          message: `IL Sch M subtractions ${derived.value.toString()} miss eligible income (SS/retirement) totaling ${eligible.toString()} — IL over-taxes (high-error area)`,
          fix_ref: 'fix://il/sch-m-apply-subtraction',
        },
      ];
    }
    if (derived.value.gt(eligible)) {
      return [
        {
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [derived.fact_id],
          message: `IL Sch M subtractions ${derived.value.toString()} exceed eligible amounts ${eligible.toString()} — unsupported subtraction`,
          fix_ref: 'fix://il/sch-m-remove-excess',
        },
      ];
    }
    return [];
  },
};

/**
 * ACC-DUP-DOC (gate 2): two documents of the SAME type reporting the
 * IDENTICAL amount for the same concept are probably the same statement
 * uploaded twice — brokerages routinely include duplicate copies in one
 * envelope, and the duplicate-file guard only catches byte-identical files.
 * FLAGS (never blocks): genuinely distinct accounts can coincide, so the
 * human decides — but silently double-counting income is exactly what the
 * IRS matching computers catch, in the taxpayer's disfavor.
 */
export const accDupDoc: Critic = {
  id: 'ACC-DUP-DOC',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const typeOf = new Map(ctx.sources.map((s) => [s.source_id, s.type]));
    const groups = new Map<string, { fact: TaxFact; source_id: string }[]>();
    for (const f of sourcedFacts(ctx)) {
      if (f.status !== 'confirmed' || f.value.isZero()) continue;
      const src = f.provenance?.[0]?.source_id;
      if (!src) continue;
      const key = `${f.concept}|${f.value.toString()}`;
      const list = groups.get(key) ?? [];
      list.push({ fact: f, source_id: src });
      groups.set(key, list);
    }
    for (const [, list] of groups) {
      const bySource = new Map(list.map((x) => [x.source_id, x]));
      if (bySource.size < 2) continue;
      const entries = [...bySource.values()];
      const sameType = new Set(entries.map((x) => typeOf.get(x.source_id))).size === 1;
      if (!sameType) continue;
      const f = entries[0]!.fact;
      findings.push({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: entries.map((x) => x.fact.fact_id),
        message: `${entries.length} documents report the IDENTICAL ${f.concept} of ${f.value.toString()}: ${entries.map((x) => x.source_id).join(', ')}. If these are copies of the same statement, delete the duplicate on Documents — the IRS receives each form once, and counting it twice overstates your income. If they are genuinely different accounts that happen to match, no action is needed.`,
        fix_ref: 'fix://documents/delete-duplicate',
      });
    }
    return findings;
  },
};

/** P38 — a SCANNED K-1 supplies box1 and the S-corp flag but NOT the two
 *  answers only the taxpayer knows: opening basis and material
 *  participation. Without them the kernel conservatively treats basis as
 *  zero and the activity as passive — a loss silently suspends to $0. That
 *  conservatism is correct math but must never be silent: this flag names
 *  each incomplete K-1 and where to finish it. */
export const accK1Complete: Critic = {
  id: 'ACC-K1-COMPLETE',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: (ctx) => sourcedFacts(ctx).some((f) => /^k1\..+\.box1$/.test(f.concept)),
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const confirmed = sourcedFacts(ctx).filter((f) => f.status === 'confirmed');
    const has = (concept: string) => confirmed.some((f) => f.concept === concept);
    const ids = [...new Set(
      confirmed
        .map((f) => /^k1\.(.+)\.box1$/.exec(f.concept)?.[1])
        .filter((x): x is string => x !== undefined),
    )];
    for (const id of ids) {
      const missing: string[] = [];
      if (!has(`k1.${id}.basis_opening`)) missing.push('opening basis (basis_opening)');
      if (!has(`k1.${id}.material_participation`)) missing.push('material participation (yes = you actively run/work in it; no = investor only)');
      if (missing.length === 0) continue;
      const box1 = confirmed.find((f) => f.concept === `k1.${id}.box1`);
      findings.push({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: box1 ? [box1.fact_id] : [],
        message: `K-1 "${id}" is missing: ${missing.join(' and ')}. Until you add ${missing.length === 1 ? 'it' : 'them'}, the kernel assumes zero basis and a passive activity — ${box1 && box1.value.isNegative() ? 'this LOSS is suspended at $0 and deducts NOTHING' : 'the amount may be treated more conservatively than your facts allow'}. Fix: Add Data → K-1 card, enter id "${id}" and fill ONLY the missing fields.`,
        fix_ref: 'fix://data/k1-completion',
      });
    }
    return findings;
  },
};

/**
 * ACC-DEPCARE-EARNED-INCOME (gate 2): §21(d) caps dependent-care expenses at
 * earned income — the LOWER of the spouses' on a joint return. When neither
 * the figure nor an explicit "it does not bind" attestation is present, the
 * kernel still computes the credit (so the return stays workable) but records
 * that the favourable assumption was made. This surfaces it as a Warning the
 * filer actually sees, instead of a trail string nobody reads.
 */
export const accDepcareEarnedIncome: Critic = {
  id: 'ACC-DEPCARE-EARNED-INCOME',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: (ctx) => derivedFact(ctx, C.FED_DEPCARE_EI_UNVERIFIED) !== undefined,
  evaluate(ctx) {
    const flag = derivedFact(ctx, C.FED_DEPCARE_EI_UNVERIFIED);
    const credit = derivedFact(ctx, C.FED_DEPCARE_CREDIT);
    if (!flag) return [];
    return [
      {
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        // 'Flag' is this system's non-blocking review severity (there is no
        // 'Warning'); it surfaces on the board without blocking the gate.
        severity: 'Flag',
        affected: [credit ? credit.fact_id : flag.fact_id],
        message:
          'Dependent-care credit: §21(d) limits your expenses to earned income — the LOWER of the two spouses on a joint return. You have not entered that figure or confirmed it does not apply, so the credit above may be overstated. Enter the lower spouse\u2019s earned income, or confirm both earned more than these expenses.',
        fix_ref: 'fix://f2441/earned-income-limit',
      },
    ];
  },
};

/**
 * P66 — the three silences that let a real 2025 return be wrong by thousands
 * with nothing on the board. Each one fires on a SHAPE that is almost always
 * an incomplete input, not on a guess about the right answer.
 */

/** A1 — foreign income entered with no long-term portion declared.
 *
 *  The kernel puts the long-term portion on Sch D Part II and ANY remainder on
 *  Part I, where it is taxed at ordinary rates. Leaving the split blank is
 *  therefore not neutral: it silently taxes the whole gain at up to 37% instead
 *  of the preferential rate. On the return that prompted this, that was $7,537.
 *  Conservative (never a windfall) — but wrong, and invisible. */
export const accForeignLtcgUndeclared: Critic = {
  id: 'ACC-FOREIGN-LTCG-UNDECLARED',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: (ctx) => sumSourced(ctx, C.FOREIGN_INCOME_FCY).total.gt(Money.zero()),
  evaluate(ctx) {
    const income = sumSourced(ctx, C.FOREIGN_INCOME_FCY);
    const ltcg = sumSourced(ctx, C.FOREIGN_LTCG_FCY);
    if (!ltcg.total.isZero()) return [];
    return [
      {
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: income.ids,
        message:
          `Foreign income of ${income.total.toString()} (foreign currency) is entered with NO long-term portion, so every dollar of it is being taxed at ORDINARY rates rather than the long-term capital-gain rate. If the asset was held more than one year (\u00a71222(3) — the US holding period governs, not the foreign certificate\u2019s label), enter the long-term portion. Note the foreign certificate\u2019s "chargeable to tax" figure is computed under FOREIGN law and is not the US gain: the US measures amount realized minus adjusted basis with no indexation.`,
        fix_ref: 'fix://f1116/long-term-portion',
      },
    ];
  },
};

/** A2 — capital gains present, no capital-loss carryover entered.
 *
 *  Carryovers are manual: they come from LAST year's return, not from any
 *  document you upload this year. A wiped or fresh workspace therefore looks
 *  complete while silently omitting them. On the return that prompted this,
 *  $42,410 of carryover was missing and nothing said so. */
export const accCaploossCarryoverMissing: Critic = {
  id: 'ACC-CAPLOSS-CARRYOVER-MISSING',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  // The Schedule D sub-DAG only runs when lots, carryovers, K-1 gains, or
  // converted foreign income exist; otherwise the legacy single-line total is
  // emitted instead. Keying on FED_SCHD_TOTAL alone would be circular — it
  // appears only once a carryover HAS been entered — so accept either line.
  applies_when: (ctx) => {
    const total = derivedFact(ctx, C.FED_SCHD_TOTAL) ?? derivedFact(ctx, C.FED_CAPGAIN_TOTAL);
    return total !== undefined && total.value.gt(Money.zero());
  },
  evaluate(ctx) {
    const total = derivedFact(ctx, C.FED_SCHD_TOTAL) ?? derivedFact(ctx, C.FED_CAPGAIN_TOTAL);
    if (!total) return [];
    const st = sumSourced(ctx, C.CAPLOSS_CO_ST_PRIOR);
    const lt = sumSourced(ctx, C.CAPLOSS_CO_LT_PRIOR);
    if (!st.total.isZero() || !lt.total.isZero()) return [];
    return [
      {
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: [total.fact_id],
        message:
          `This return reports a net capital gain of ${total.value.toString()} but NO capital-loss carryover from the prior year. Carryovers do not arrive on any document you upload — they come from last year\u2019s Capital Loss Carryover Worksheet and must be entered. If your prior return had unused losses, entering them reduces this gain dollar-for-dollar. If you genuinely had none, no action is needed.`,
        fix_ref: 'fix://schedule-d/carryover',
      },
    ];
  },
};

/** A3 — large gross capital gains, but nothing qualifies for the preferential
 *  rate. The rate-mix red flag: it means the short/long split is lopsided —
 *  usually a long-term item mis-entered as short-term, or a long-term carryover
 *  wiping out the only long-term gains. Either way the tax is materially higher
 *  than it should be, and the bottom line alone never shows why. */
export const accNoPreferentialRate: Critic = {
  id: 'ACC-NO-PREFERENTIAL-RATE',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: (ctx) => {
    const total = derivedFact(ctx, C.FED_SCHD_TOTAL);
    const ncg = derivedFact(ctx, C.FED_SCHD_NCG);
    return total !== undefined && ncg !== undefined && total.value.gt(Money.zero()) && ncg.value.isZero();
  },
  evaluate(ctx) {
    const total = derivedFact(ctx, C.FED_SCHD_TOTAL);
    const ncg = derivedFact(ctx, C.FED_SCHD_NCG);
    const st = derivedFact(ctx, C.FED_SCHD_ST_NET);
    const lt = derivedFact(ctx, C.FED_SCHD_LT_NET);
    if (!total || !ncg) return [];
    return [
      {
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: [total.fact_id, ncg.fact_id],
        message:
          `Schedule D shows a net gain of ${total.value.toString()}, but NOTHING qualifies for the long-term capital-gain rate — every dollar is taxed at ordinary rates${st && lt ? ` (short-term net ${st.value.toString()}, long-term net ${lt.value.toString()})` : ''}. That shape is almost always an input problem: a long-term item entered as short-term, or a long-term carryover cancelling the only long-term gains. Check the term on each gain before filing — the rate difference is large.`,
        fix_ref: 'fix://schedule-d/term-classification',
      },
    ];
  },
};

/** P73 — foreign tax sitting uncredited.
 *
 *  A brokerage 1099 box 7 lands foreign tax with no foreign-source income, and
 *  Form 1116 cannot compute its §904 limitation without it. The kernel used to
 *  REFUSE the whole return; now it computes without the credit and emits this
 *  fact, so the money is visibly left on the table instead of vanishing. */
export const accFtcNotClaimed: Critic = {
  id: 'ACC-FTC-NOT-CLAIMED',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: (ctx) => derivedFact(ctx, C.FED_FTC_NOT_CLAIMED) !== undefined,
  evaluate(ctx) {
    const flag = derivedFact(ctx, C.FED_FTC_NOT_CLAIMED);
    if (!flag) return [];
    return [
      {
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: [flag.fact_id],
        message:
          `${flag.value.toString()} of foreign tax is NOT being credited on this return, so the tax shown is HIGHER than it should be. Form 1116 needs foreign-source income to compute its §904 limitation and none was entered. If this is small, passive-category tax from a payee statement (1099-DIV box 7), claim the §904(j) election to take it in full without Form 1116; otherwise enter the foreign-source income it relates to.`,
        fix_ref: 'fix://f1116/no-foreign-income',
      },
    ];
  },
};

export function createStep1Critics(): Critic[] {
  return [
    accFtcNotClaimed,
    accForeignLtcgUndeclared,
    accCaploossCarryoverMissing,
    accNoPreferentialRate,
    accDepcareEarnedIncome,
    irsIncomeRecon,
    irsDocMatch,
    irsRoundNum,
    accDocComplete,
    accStdVsItem,
    accWithholdRecon,
    accTieoutForm,
    accMethod,
    accSanity,
    accIlSubtract,
    accDupDoc,
    accK1Complete,
  ];
}
