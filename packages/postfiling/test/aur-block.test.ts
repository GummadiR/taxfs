/** I.3/I.7 acceptance: no standalone 1040-X while an AUR/CP2000 case is open on the same items. */
import { describe, expect, it } from 'vitest';
import { filedScenario } from './helpers';

describe('AUR procedural block', () => {
  it('blocks a standalone amendment touching a noticed concept, with routing guidance', async () => {
    const { pf, filing } = await filedScenario();
    const noticeCase = pf.openNoticeCase({
      filing,
      notice_type: 'CP2000',
      notice_date: '2026-05-15',
      response_deadline: '2026-08-13',
      items: [
        { irs_claim: { form: '1099-INT', payer: 'Second Bank', concept: 'income.interest', amount: '350', claim_kind: 'underreported' }, our_fact_refs: [] },
      ],
    });

    expect(() =>
      pf.openAmendmentCase({ filing, reason: 'user_correction', correction_concepts: ['income.interest'] }),
    ).toThrow(/blocked.*open CP2000\/AUR case.*Respond through the notice case/s);

    // Unrelated concepts stay amendable
    const unrelated = pf.openAmendmentCase({ filing, reason: 'user_correction', correction_concepts: ['deduction.itemized.total'] });
    expect(unrelated.status).toBe('draft');

    // Amendments born from the notice outcome route THROUGH the case and pass
    const fromNotice = pf.openAmendmentCase({ filing, reason: 'notice_outcome', correction_concepts: ['income.interest'] });
    expect(fromNotice.status).toBe('draft');

    // Once the case closes, standalone amendments unblock
    pf.setNoticeStatus(noticeCase.case_id, 'closed');
    const afterClose = pf.openAmendmentCase({ filing, reason: 'user_correction', correction_concepts: ['income.interest'] });
    expect(afterClose.status).toBe('draft');
  });
});
