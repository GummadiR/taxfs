/**
 * Static release data — rules, form defs, field maps, templates, schemas.
 * Module-scope singletons loaded once per process (Blueprint §1.3.1): none
 * of this can change between requests, so no session or request ever pays
 * for loading it again. Every path resolves by TAX_YEAR (the P99 rule); a
 * missing release file fails loudly at first read, never a silent default.
 */
import { loadQuestionTemplates, type QuestionTemplate } from '@taxfs/agents';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadVerifiedRuleSet, type RuleSet } from '@taxfs/shared';
import {
  loadBusinessRules,
  loadFieldMaps,
  loadFormDefRelease,
  loadStubXsd,
  type BusinessRule,
  type FieldMapRelease,
  type FormDefRelease,
  type StubXsdConfig,
} from '@taxfs/forms';
import { TAX_YEAR } from './env';

function repoRoot(): string {
  // apps/web runs with cwd at apps/web (dev/start) — the repo root is two up.
  const here = process.cwd();
  return existsSync(join(here, 'rules/fixtures')) ? here : join(here, '../..');
}

export function readFixture(rel: string): unknown {
  const path = join(repoRoot(), rel);
  if (!existsSync(path)) {
    throw new Error(
      `No rule release for tax year ${TAX_YEAR}: missing ${rel}. ` +
        `Author the ${TAX_YEAR} release files (with citations) before setting TAXFS_TAX_YEAR=${TAX_YEAR}.`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export interface StaticReleases {
  fedRules: RuleSet;
  ilRules: RuleSet;
  formsFed: FormDefRelease;
  formsIl: FormDefRelease;
  stubXsdFed: StubXsdConfig;
  stubXsdIl: StubXsdConfig;
  bizRules: BusinessRule[];
  fieldMaps: FieldMapRelease;
  pdfTemplates: Record<string, Uint8Array>;
  /** Placeholder-PDF template release, passed through to buildPackage. */
  pdfPlaceholderRelease: unknown;
  /** E.2 question templates — suggested wording for interview attestations. */
  questionTemplates: QuestionTemplate[];
}

let cached: StaticReleases | null = null;

export function releases(): StaticReleases {
  if (cached) return cached;
  const maps = loadFieldMaps(readFixture(`rules/fixtures/pdf/${TAX_YEAR}.PDF-FIELDMAP.json`));
  const templates: Record<string, Uint8Array> = {};
  for (const [formId, map] of Object.entries(maps.forms)) {
    const path = join(repoRoot(), map.template_path);
    if (existsSync(path)) templates[formId] = new Uint8Array(readFileSync(path));
  }
  cached = {
    fedRules: loadVerifiedRuleSet(
      readFixture(`rules/fixtures/${TAX_YEAR}.FED.1.0.json`),
      readFixture(`rules/fixtures/${TAX_YEAR}.SYSTEM.FED.json`),
    ),
    ilRules: loadVerifiedRuleSet(
      readFixture(`rules/fixtures/${TAX_YEAR}.IL.1.0.json`),
      readFixture(`rules/fixtures/${TAX_YEAR}.SYSTEM.IL.json`),
    ),
    formsFed: loadFormDefRelease(readFixture(`rules/fixtures/forms/${TAX_YEAR}.FORMS.FED.json`)),
    formsIl: loadFormDefRelease(readFixture(`rules/fixtures/forms/${TAX_YEAR}.FORMS.IL.json`)),
    stubXsdFed: loadStubXsd(readFixture(`rules/fixtures/schemas/${TAX_YEAR}.FED.STUBXSD.json`)),
    stubXsdIl: loadStubXsd(readFixture(`rules/fixtures/schemas/${TAX_YEAR}.IL.STUBXSD.json`)),
    bizRules: loadBusinessRules(readFixture(`rules/fixtures/${TAX_YEAR}.BIZRULES.json`)),
    fieldMaps: maps,
    pdfTemplates: templates,
    pdfPlaceholderRelease: readFixture(`rules/fixtures/pdf/${TAX_YEAR}.PDF-TEMPLATES.json`),
    questionTemplates: loadQuestionTemplates(readFixture(`rules/fixtures/${TAX_YEAR}.QUESTIONS.json`)),
  };
  return cached;
}
