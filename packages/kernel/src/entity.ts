/**
 * PART C (P4) — ENTITY KERNEL: owned-entity returns (1120-S first; 1065 in
 * P4.4). An entity return is its own kernel run over the entity's facts
 * (ARCHITECTURE §4): it emits entity-level lines (Form 1120-S page 1,
 * Schedule K, IL-1120-ST) and DERIVES the outbound Schedule K-1 facts per
 * member. The personal run then consumes those facts exactly like inbound
 * K-1s — one mechanism, two directions.
 *
 * ALLOCATION LAW: every Schedule K line is allocated per member with
 * CUMULATIVE rounding over the sorted member order (alloc_i =
 * round(line × cumshare_i) − round(line × cumshare_{i−1})), so per-member
 * K-1 boxes always sum exactly to the entity line. The 2022 back-test
 * oracle pins this: −10,445 and 36,237 at 50/50 allocate as
 * −5,223/−5,222 and 18,119/18,118 (docs/reviews/BACKTEST-2022.md).
 *
 * Same purity rules as compute.ts: no I/O, no clock, no randomness; all
 * figures from injected rule data; every derived value emits a Calculation.
 */
import {
  ENTITY_DEDUCTION_CATEGORIES,
  ENTITY_K_LINES,
  Money,
  type TaxFact,
} from '@taxfs/shared';
import { makeEmitter, sourcedFacts, sumOfConcept } from './emit';
import type { KernelInput, KernelResult } from './compute';

const ENTITY_RE = /^entity\.([a-z0-9][a-z0-9_-]*)\./;
const MEMBER_SHARE_RE = /^entity\.([a-z0-9][a-z0-9_-]*)\.member\.([a-z0-9][a-z0-9_-]*)\.share$/;

/** Entity ids present in the sourced facts (each is one entity return run). */
export function entityIds(facts: readonly TaxFact[]): string[] {
  return [...new Set(
    facts
      .filter((f) => f.derivation === undefined && f.status === 'confirmed')
      .map((f) => ENTITY_RE.exec(f.concept)?.[1])
      .filter((x): x is string => x !== undefined),
  )].sort();
}

/**
 * Compute all owned-entity returns present in the facts. Returns entity
 * lines plus derived outbound `k1.<entity>-<member>.*` facts ready for the
 * personal run (the orchestrator re-sources them across the boundary).
 */
export function computeEntities(input: KernelInput): KernelResult {
  const il = input.il_rules.il;
  if (!il) throw new Error('entity kernel: IL rule set missing il parameters');
  const rvFed = input.fed_rules.rule_version;
  const rvIl = input.il_rules.rule_version;
  const em = makeEmitter(input);

  for (const eid of entityIds(input.facts)) {
    const g = (field: string) => sumOfConcept(input, `entity.${eid}.${field}`);
    const scorp = !g('is_scorp').total.isZero();

    // ---- Members (ownership shares must sum to exactly 1) ----
    const memberIds = [...new Set(
      input.facts
        .filter((f) => f.derivation === undefined && f.status === 'confirmed')
        .map((f) => {
          const m = MEMBER_SHARE_RE.exec(f.concept);
          return m?.[1] === eid ? m[2] : undefined;
        })
        .filter((x): x is string => x !== undefined),
    )].sort();
    if (memberIds.length === 0) {
      throw new Error(`entity kernel: entity ${eid} has no member.<id>.share facts — cannot allocate K-1s`);
    }
    // Shares are FRACTIONS, not dollars — read them unrounded (sumOfConcept
    // would round 0.5 to a whole dollar).
    const members = memberIds.map((mid) => {
      const rows = sourcedFacts(input, `entity.${eid}.member.${mid}.share`);
      return { mid, share: Money.sum(rows.map((f) => f.value)), inputs: rows };
    });
    const shareSum = Money.sum(members.map((m) => m.share));
    if (!shareSum.sub(Money.fromString('1')).isZero()) {
      throw new Error(
        `entity kernel: entity ${eid} member shares sum to ${shareSum.toString()}, expected exactly 1`,
      );
    }

    // Guaranteed payments (1065 line 10 / K-1 box 4) are per-member SOURCED
    // amounts, never share-allocated. §199A(c)(4)(B): never QBI. S-corps
    // have no guaranteed payments — presence on an S-corp is a hard error.
    const gps = members.map((m) => ({
      mid: m.mid,
      sum: sumOfConcept(input, `entity.${eid}.member.${m.mid}.guaranteed_payment`),
    }));
    const gpTotal = Money.sum(gps.map((x) => x.sum.total.roundToDollar()));
    if (scorp && !gpTotal.isZero()) {
      throw new Error(
        `entity kernel: entity ${eid} is an S-corp but carries guaranteed_payment facts (a 1065-only concept)`,
      );
    }
    // §752: the partnership liability-share change flows to each member as
    // Δ outside basis (k1.liab_change). Economic-risk-of-loss tiering is a
    // recorded gap — this slice allocates by ownership share.
    const liabBegin = g('liabilities_beginning');
    const liabEnd = g('liabilities_ending');
    const liabChange = liabEnd.total.roundToDollar().sub(liabBegin.total.roundToDollar());
    if (scorp && (liabBegin.inputs.length > 0 || liabEnd.inputs.length > 0)) {
      throw new Error(
        `entity kernel: entity ${eid} is an S-corp — entity-level debt gives shareholders no basis (§752 is partnership-only; 7203 debt basis needs a DIRECT shareholder loan)`,
      );
    }

    // Cumulative-rounding allocation of one Schedule K line across members
    // (grouping-invariant; allocations sum exactly to the rounded line).
    const allocate = (line: Money): Map<string, Money> => {
      const out = new Map<string, Money>();
      const upTo = (list: readonly typeof members[number][]): Money =>
        line.mulRate(Money.sum(list.map((m) => m.share)).toString()).roundToDollar();
      members.forEach((m) => {
        const before = members.slice(0, members.indexOf(m));
        out.set(m.mid, upTo([...before, m]).sub(upTo(before)));
      });
      return out;
    };

    // ---- Page 1: ordinary business income (loss) ----
    const gross = g('gross_receipts');
    const returns = g('returns_allowances');
    const cogs = g('cogs');
    const dedSteps: string[] = [];
    const dedInputs: TaxFact[] = [];
    let deductions = Money.zero();
    // P13 form-feed: the business-return mapping layer does NO math, so every
    // printable page-1 line must exist as a single kernel-emitted fact (the
    // sourced concepts can hold multiple facts — mapping requires exactly one).
    const formRef = scorp ? 'FED.1120S' : 'FED.1065';
    const p1Line = (field: string, sum: { total: Money; inputs: TaxFact[] }, note: string): void => {
      if (sum.inputs.length === 0) return;
      em.emit({
        concept: `entity.${eid}.p1.${field}`,
        jurisdiction: ['FED', 'IL'],
        inputs: sum.inputs,
        formula_ref: `${formRef}.P1.${field.toUpperCase()}`,
        rule_version: rvFed,
        steps: [`${note} = ${sum.total.roundToDollar().toString()} (sum of sourced entity.${eid}.${field === 'guaranteed_payments' ? 'member.*.guaranteed_payment' : field} facts, rounded)`],
        value: sum.total.roundToDollar(),
        taxpayer_scope: `entity:${eid}`,
      });
    };
    p1Line('gross_receipts', gross, scorp ? '1120-S line 1a gross receipts' : '1065 line 1a gross receipts');
    p1Line('returns_allowances', returns, 'line 1b returns and allowances');
    p1Line('cogs', cogs, 'cost of goods sold (Form 1125-A)');
    for (const cat of ENTITY_DEDUCTION_CATEGORIES) {
      const d = g(`deduction.${cat}`);
      if (d.inputs.length === 0) continue;
      deductions = deductions.add(d.total.roundToDollar());
      dedInputs.push(...d.inputs);
      dedSteps.push(`deduction.${cat} += ${d.total.roundToDollar().toString()}`);
      p1Line(`deduction.${cat}`, d, `deduction line (${cat})`);
    }
    if (!scorp && !gpTotal.isZero()) {
      deductions = deductions.add(gpTotal);
      dedInputs.push(...gps.flatMap((x) => x.sum.inputs));
      dedSteps.push(`guaranteed payments to partners ${gpTotal.toString()} deducted (1065 line 10)`);
      p1Line('guaranteed_payments', { total: gpTotal, inputs: gps.flatMap((x) => x.sum.inputs) },
        '1065 line 10 guaranteed payments to partners');
    }
    if (dedInputs.length > 0 || !gpTotal.isZero()) {
      em.emit({
        concept: `entity.${eid}.p1.total_deductions`,
        jurisdiction: ['FED', 'IL'],
        inputs: dedInputs,
        formula_ref: `${formRef}.P1.TOTAL_DEDUCTIONS`,
        rule_version: rvFed,
        steps: [`total deductions = ${deductions.toString()} (${scorp ? '1120-S line 20' : '1065 line 21'})`],
        value: deductions,
        taxpayer_scope: `entity:${eid}`,
      });
    }
    const ordinary = gross.total.sub(returns.total).sub(cogs.total).sub(deductions);
    const ordinaryFact = em.emit({
      concept: `entity.${eid}.ordinary_income`,
      jurisdiction: ['FED', 'IL'],
      inputs: [...gross.inputs, ...returns.inputs, ...cogs.inputs, ...dedInputs],
      formula_ref: scorp ? 'FED.1120S.LINE21.ORDINARY' : 'FED.1065.LINE22.ORDINARY',
      rule_version: rvFed,
      steps: [
        `gross_profit = ${gross.total.toString()} − returns ${returns.total.toString()} − cogs ${cogs.total.toString()}`,
        ...dedSteps,
        `ordinary_income = gross_profit − total deductions ${deductions.toString()} = ${ordinary.toString()} (${scorp ? '1120-S line 21' : '1065 line 22'})`,
      ],
      value: ordinary,
      taxpayer_scope: `entity:${eid}`,
    });

    // ---- Schedule K separately-stated lines + line 18 reconciliation ----
    const kLines = ENTITY_K_LINES
      .filter((line) => line !== 'div_qualified') // informational (subset of 5a)
      .map((line) => ({ line, sum: g(`k.${line}`) }));
    // Analysis of net income: guaranteed payments come BACK into the Sch K
    // reconciliation for partnerships (deducted on page 1, separately
    // stated to the recipient on K-1 box 4).
    const kTotal = ordinaryFact.value
      .add(Money.sum(kLines.map((k) => k.sum.total.roundToDollar())))
      .add(scorp ? Money.zero() : gpTotal);
    const kTotalFact = em.emit({
      concept: `entity.${eid}.k_total`,
      jurisdiction: ['FED', 'IL'],
      inputs: [ordinaryFact, ...kLines.flatMap((k) => k.sum.inputs),
               ...(scorp ? [] : gps.flatMap((x) => x.sum.inputs))],
      formula_ref: scorp ? 'FED.1120S.SCHK.LINE18.RECON' : 'FED.1065.SCHK.ANALYSIS.RECON',
      rule_version: rvFed,
      steps: [
        `k_total = ordinary ${ordinaryFact.value.toString()}`,
        ...kLines
          .filter((k) => k.sum.inputs.length > 0)
          .map((k) => `k_total += ${k.sum.total.roundToDollar().toString()} (k.${k.line})`),
        ...(scorp || gpTotal.isZero() ? [] : [`k_total += guaranteed payments ${gpTotal.toString()} (separately stated, K-1 box 4)`]),
        'interest/dividend separately-stated lines allocate at forms-mapping time (recorded gap in this slice)',
      ],
      value: kTotal,
      taxpayer_scope: `entity:${eid}`,
    });

    // P13 form-feed: Schedule K separately-stated line totals as single
    // facts for the business-return mapping layer (incl. informational 5b).
    for (const { line, sum } of [...kLines, { line: 'div_qualified', sum: g('k.div_qualified') }]) {
      if (sum.inputs.length === 0) continue;
      em.emit({
        concept: `entity.${eid}.k_line.${line}`,
        jurisdiction: ['FED', 'IL'],
        inputs: sum.inputs,
        formula_ref: `${formRef}.SCHK.${line.toUpperCase()}`,
        rule_version: rvFed,
        steps: [`Schedule K line total (${line}) = ${sum.total.roundToDollar().toString()} (sum of sourced entity.${eid}.k.${line} facts, rounded)`],
        value: sum.total.roundToDollar(),
        taxpayer_scope: `entity:${eid}`,
      });
    }

    // ---- IL-1120-ST: base income + replacement tax ----
    const ilBaseFact = em.emit({
      concept: `entity.${eid}.il.base_income`,
      jurisdiction: ['IL'],
      inputs: [kTotalFact],
      formula_ref: scorp ? 'IL.1120ST.BASE_INCOME' : 'IL.1065.BASE_INCOME',
      rule_version: rvIl,
      steps: [
        `il.base_income = federal Sch K reconciliation ${kTotalFact.value.toString()} (unmodified; entity Sch M additions/subtractions are a recorded gap${scorp ? '' : '; IL-1065 personal-service-income/guaranteed-payment subtraction is a recorded gap pending rule authoring'})`,
      ],
      value: kTotalFact.value,
      taxpayer_scope: `entity:${eid}`,
    });
    if (!il.replacement_tax) {
      throw new Error('entity kernel: entity facts present but IL rule data lacks replacement_tax rates');
    }
    const rtRate = scorp ? il.replacement_tax.scorp_rate : il.replacement_tax.partnership_rate;
    const rtBase = Money.max(Money.zero(), ilBaseFact.value);
    em.emit({
      concept: `entity.${eid}.il.replacement_tax`,
      jurisdiction: ['IL'],
      inputs: [ilBaseFact],
      formula_ref: scorp ? 'IL.1120ST.REPLACEMENT_TAX' : 'IL.1065.REPLACEMENT_TAX',
      rule_version: rvIl,
      steps: [
        `replacement_tax = max(0, base ${ilBaseFact.value.toString()}) × ${rtRate} (35 ILCS 5/201(c)-(d))`,
      ],
      value: rtBase.mulRate(rtRate),
      taxpayer_scope: `entity:${eid}`,
    });

    // ---- Outbound K-1s: per-member allocation of each Schedule K line ----
    const box1By = allocate(ordinaryFact.value);
    const stBy = allocate(g('k.st_gain').total.roundToDollar());
    const ltBy = allocate(g('k.lt_gain').total.roundToDollar());
    const oiStBy = allocate(g('k.other_income_st').total.roundToDollar());
    const oiLtBy = allocate(g('k.other_income_lt').total.roundToDollar());
    const liabBy = allocate(liabChange);
    // P13: interest/dividend separately-stated lines now allocate HERE (was a
    // recorded gap deferred "to forms-mapping time" — mapping does no math).
    const intBy = allocate(g('k.int_income').total.roundToDollar());
    const divBy = allocate(g('k.div_ordinary').total.roundToDollar());
    const divQBy = allocate(g('k.div_qualified').total.roundToDollar());
    for (const m of members) {
      const box1 = box1By.get(m.mid) ?? Money.zero();
      const st = stBy.get(m.mid) ?? Money.zero();
      const lt = ltBy.get(m.mid) ?? Money.zero();
      const oiSt = oiStBy.get(m.mid) ?? Money.zero();
      const oiLt = oiLtBy.get(m.mid) ?? Money.zero();
      const k1Box1 = em.emit({
        concept: `k1.${eid}-${m.mid}.box1`,
        jurisdiction: ['FED', 'IL'],
        inputs: [ordinaryFact, ...m.inputs],
        formula_ref: scorp ? 'FED.1120S.K1.BOX1.ALLOC' : 'FED.1065.K1.BOX1.ALLOC',
        rule_version: rvFed,
        steps: [
          `box1 = cumulative-rounding share of ordinary ${ordinaryFact.value.toString()} at ${m.share.toString()} = ${box1.toString()} (member order = sorted member id)`,
        ],
        value: box1,
        taxpayer_scope: `entity:${eid}`,
      });
      em.emit({
        concept: `k1.${eid}-${m.mid}.is_scorp`,
        jurisdiction: ['FED'],
        inputs: [k1Box1],
        formula_ref: 'FED.K1.ENTITY_TYPE',
        rule_version: rvFed,
        steps: [scorp ? 'outbound K-1 from an 1120-S run' : 'outbound K-1 from a 1065 run'],
        value: Money.fromString(scorp ? '1' : '0'),
        taxpayer_scope: `entity:${eid}`,
      });
      if (!scorp) {
        const gp = gps.find((x) => x.mid === m.mid)!.sum;
        const gpAmt = gp.total.roundToDollar();
        if (!gpAmt.isZero()) {
          const gpFact = em.emit({
            concept: `k1.${eid}-${m.mid}.guaranteed_payment`,
            jurisdiction: ['FED', 'IL'],
            inputs: [...gp.inputs],
            formula_ref: 'FED.1065.K1.BOX4.GP',
            rule_version: rvFed,
            steps: [`guaranteed payment ${gpAmt.toString()} (K-1 box 4; sourced per member, not share-allocated)`],
            value: gpAmt,
            taxpayer_scope: `entity:${eid}`,
          });
          em.emit({
            concept: `entity.${eid}.member.${m.mid}.k1p_line29`,
            jurisdiction: ['IL'],
            inputs: [gpFact],
            formula_ref: 'IL.K1P.STEP4.LINE29',
            rule_version: rvIl,
            steps: [`K-1-P line 29 = guaranteed payments ${gpAmt.toString()}`],
            value: gpAmt,
            taxpayer_scope: `entity:${eid}`,
          });
        }
        const liabShare = liabBy.get(m.mid) ?? Money.zero();
        if (!liabShare.isZero()) {
          em.emit({
            concept: `k1.${eid}-${m.mid}.liab_change`,
            jurisdiction: ['FED'],
            inputs: [...liabBegin.inputs, ...liabEnd.inputs, ...m.inputs],
            formula_ref: 'FED.SEC752.K1.LIAB_SHARE',
            rule_version: rvFed,
            steps: [
              `§752 liability-share change = share of (ending ${liabEnd.total.roundToDollar().toString()} − beginning ${liabBegin.total.roundToDollar().toString()}) = ${liabShare.toString()} (economic-risk-of-loss tiering is a recorded gap; allocated by ownership share)`,
            ],
            value: liabShare,
            taxpayer_scope: `entity:${eid}`,
          });
        }
      }
      // Schedule K-1-P Step 4 capital-gain lines (26 ST / 27 LT).
      if (!st.isZero()) {
        em.emit({
          concept: `entity.${eid}.member.${m.mid}.k1p_line26`,
          jurisdiction: ['IL'],
          inputs: [kTotalFact, ...m.inputs],
          formula_ref: 'IL.K1P.STEP4.LINE26',
          rule_version: rvIl,
          steps: [`K-1-P line 26 = member share of net ST capital gain ${st.toString()}`],
          value: st,
          taxpayer_scope: `entity:${eid}`,
        });
      }
      if (!lt.isZero()) {
        em.emit({
          concept: `entity.${eid}.member.${m.mid}.k1p_line27`,
          jurisdiction: ['IL'],
          inputs: [kTotalFact, ...m.inputs],
          formula_ref: 'IL.K1P.STEP4.LINE27',
          rule_version: rvIl,
          steps: [`K-1-P line 27 = member share of net LT capital gain ${lt.toString()}`],
          value: lt,
          taxpayer_scope: `entity:${eid}`,
        });
      }
      const capGain = st.add(lt).add(oiSt).add(oiLt);
      if (!capGain.isZero()) {
        em.emit({
          concept: `k1.${eid}-${m.mid}.capital_gain`,
          jurisdiction: ['FED', 'IL'],
          inputs: [kTotalFact, ...m.inputs],
          formula_ref: 'FED.1120S.K1.CAPGAIN.ALLOC',
          rule_version: rvFed,
          steps: [
            `capital_gain = st ${st.toString()} + lt ${lt.toString()} + other_income_st ${oiSt.toString()} + other_income_lt ${oiLt.toString()} (each line allocated separately, then summed)`,
            'ST/LT character flattens into the single personal-kernel capital_gain feed (recorded gap; per-line member facts keep the split for forms mapping)',
          ],
          value: capGain,
          taxpayer_scope: `entity:${eid}`,
        });
      }
      // P13 form-feed: per-member K-1 print lines (interest, dividends,
      // per-character capital gain, combined other income). The personal-
      // kernel feed remains k1.<id>.capital_gain — these exist to PRINT the
      // outbound K-1 without any math in the mapping layer.
      const k1Print = (field: string, amount: Money, note: string): void => {
        if (amount.isZero()) return;
        em.emit({
          concept: `k1.${eid}-${m.mid}.${field}`,
          jurisdiction: ['FED', 'IL'],
          inputs: [kTotalFact, ...m.inputs],
          formula_ref: `${formRef}.K1.${field.toUpperCase()}.ALLOC`,
          rule_version: rvFed,
          steps: [`${note} = ${amount.toString()} (cumulative-rounding share at ${m.share.toString()})`],
          value: amount,
          taxpayer_scope: `entity:${eid}`,
        });
      };
      k1Print('int_income', intBy.get(m.mid) ?? Money.zero(), scorp ? 'K-1 box 4 interest income' : 'K-1 box 5 interest income');
      k1Print('div_ordinary', divBy.get(m.mid) ?? Money.zero(), scorp ? 'K-1 box 5a ordinary dividends' : 'K-1 box 6a ordinary dividends');
      k1Print('div_qualified', divQBy.get(m.mid) ?? Money.zero(), scorp ? 'K-1 box 5b qualified dividends' : 'K-1 box 6b qualified dividends');
      k1Print('st_gain', st, scorp ? 'K-1 box 7 net short-term capital gain (loss)' : 'K-1 box 8 net short-term capital gain (loss)');
      k1Print('lt_gain', lt, scorp ? 'K-1 box 8a net long-term capital gain (loss)' : 'K-1 box 9a net long-term capital gain (loss)');
      k1Print('other_income', oiSt.add(oiLt), scorp ? 'K-1 box 10 other income (loss)' : 'K-1 box 11 other income (loss)');
      // Schedule K-1-P Step 4 (business income; apportionment factor 1 in
      // this slice — multistate apportionment is a recorded gap).
      em.emit({
        concept: `entity.${eid}.member.${m.mid}.k1p_line20`,
        jurisdiction: ['IL'],
        inputs: [k1Box1],
        formula_ref: 'IL.K1P.STEP4.LINE20',
        rule_version: rvIl,
        steps: [`K-1-P line 20 = member share of ordinary business income ${box1.toString()}`],
        value: box1,
        taxpayer_scope: `entity:${eid}`,
      });
      const otherIncome = oiSt.add(oiLt);
      if (!otherIncome.isZero()) {
        em.emit({
          concept: `entity.${eid}.member.${m.mid}.k1p_line31`,
          jurisdiction: ['IL'],
          inputs: [kTotalFact, ...m.inputs],
          formula_ref: 'IL.K1P.STEP4.LINE31',
          rule_version: rvIl,
          steps: [`K-1-P line 31 (other income) = st ${oiSt.toString()} + lt ${oiLt.toString()} = ${otherIncome.toString()}`],
          value: otherIncome,
          taxpayer_scope: `entity:${eid}`,
        });
      }
    }
  }

  return { computedFacts: em.facts, calculations: em.calculations };
}
