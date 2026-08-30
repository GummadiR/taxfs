/**
 * Every action the operator can click must show that it is working
 * (§9.1 structural test).
 *
 * The operator's words: "when i click on rescan/remove i should be able to
 * see some hourglass so that it is working" — and then: apply it to every
 * click in TaxFS. Half the app already routed its buttons through
 * SubmitButton (spinner + disabled while pending); the pages they actually
 * use — Documents, Gates, Review, File It, Get Started, Workspaces — did not,
 * so Rescan and Remove looked dead while the server worked, and a second
 * impatient click fired the action twice.
 *
 * This is structural rather than behavioural on purpose: a spinner that
 * appears for 200ms cannot be asserted reliably in a browser test, but
 * "no raw <button> inside a <form action=…>" can be, and it is the property
 * that actually guarantees the feedback.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFilesUnder(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Client components that own their busy state directly (they use onClick
 *  handlers, not form actions, so useFormStatus does not apply). Each is
 *  listed with the state it sets — none may be added without one. */
const OWN_BUSY_STATE: Record<string, RegExp> = {
  'danger-zone.tsx': /pending \? 'Working…'/,
  'identity-panel.tsx': /const \[busy, setBusy\]/,
};

describe('every clickable action reports that it is working', () => {
  const files = tsxFilesUnder(join(import.meta.dirname, '..', 'src', 'app'));

  it('finds the app pages (guards against a silently empty scan)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('routes every form-submitting button through SubmitButton', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('<form action=')) continue;
      // A raw <button> in a page that submits a form has no pending state.
      if (/<button(\s|>)/.test(src)) offenders.push(file.split('/app/')[1] ?? file);
    }
    expect(
      offenders.filter((f) => !Object.keys(OWN_BUSY_STATE).some((allowed) => f.endsWith(allowed))),
      'use <SubmitButton> so the click shows a spinner and cannot double-fire',
    ).toEqual([]);
  });

  it('the click-handler components that opt out still own a busy state', () => {
    for (const [name, pattern] of Object.entries(OWN_BUSY_STATE)) {
      const file = files.find((f) => f.endsWith(name));
      expect(file, `${name} not found — update OWN_BUSY_STATE`).toBeTruthy();
      expect(pattern.test(readFileSync(file!, 'utf8')), `${name} lost its busy state`).toBe(true);
    }
  });
});
