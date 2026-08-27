/**
 * File It: build the package from the deterministic layers and persist it as
 * a LOCKED row (§4 improvement (c): manifests are table rows, never eager
 * blobs; drafts are never persisted, so the P90 pile-up cannot recur).
 * Artifact BYTES are regenerated deterministically on demand and verified
 * against the locked SHA-256 hashes — a mismatch is a loud defect, never a
 * silent difference. (Hosted object storage arrives with the tester phase.)
 */
import { createHash } from 'node:crypto';
import type { Clock } from '@taxfs/shared';
import { buildPackage } from '@taxfs/forms';
import { withSpine, withUserClient } from './db';
import { filingContext } from './filing';
import { releases } from './rules';
import { TAX_YEAR } from './env';

const KERNEL_VERSION = 'taxfs-kernel-1';

class RealClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export async function buildLockedPackage(userId: string, ws: string): Promise<void> {
  const filing = await withUserClient(userId, (client) => filingContext(client, ws));
  if (!filing) throw new Error('complete Get Started first');
  const rel = releases();
  await withSpine({ userId, workspaceId: ws }, async (spine) => {
    const { gateRuns } = await spine.inspect(ws);
    const latest = new Map<string, string>();
    for (const run of gateRuns) latest.set(`${run.gate}:${run.jurisdiction}`, run.result);
    const hardPass = [0, 1, 2, 3, 4, 6].every((g) =>
      ['FED', 'IL'].every((j) => ['pass', 'ack'].includes(latest.get(`${g}:${j}`) ?? '')));
    const facts = (await spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }))
      .filter((f) => f.status === 'confirmed');
    const built = await buildPackage({
      taxpayer_id: ws,
      tax_year: TAX_YEAR,
      facts,
      gate_runs: gateRuns,
      hard_gates_passed: hardPass,
      rule_versions: { FED: rel.fedRules.rule_version, IL: rel.ilRules.rule_version },
      kernel_version: KERNEL_VERSION,
      releases: { fed: rel.formsFed, il: rel.formsIl },
      stub_xsd: { fed: rel.stubXsdFed, il: rel.stubXsdIl },
      business_rules: rel.bizRules,
      pdf_templates: rel.pdfPlaceholderRelease,
      pdf_fill: { maps: rel.fieldMaps, templates: rel.pdfTemplates },
      filing_status: filing.filing_status,
      spine,
      clock: new RealClock(),
    });
    const artifactHashes = built.artifacts.map((a) => ({
      artifact_id: a.artifact_id,
      target: a.target,
      sha256: createHash('sha256').update(a.content).digest('hex'),
    }));
    await withUserClient(userId, async (client) => {
      const next = await client.query(
        `select coalesce(max(version), 0) + 1 as v from packages where workspace_id = $1 and tax_year = $2`,
        [ws, TAX_YEAR],
      );
      const version = next.rows[0].v as number;
      await client.query(
        `insert into packages (workspace_id, package_id, tax_year, version, status, manifest)
         values ($1, $2, $3, $4, 'locked', $5::jsonb)`,
        [ws, `pkg-${TAX_YEAR}-v${version}`, TAX_YEAR, version, JSON.stringify({
          manifest: built.manifest,
          report: built.report,
          artifact_hashes: artifactHashes,
          kernel_version: KERNEL_VERSION,
          rule_versions: { FED: rel.fedRules.rule_version, IL: rel.ilRules.rule_version },
        })],
      );
    });
  });
}

export interface PackageRow {
  package_id: string;
  version: number;
  status: string;
  forms: string[];
  created_at: string;
}

export async function listPackages(userId: string, ws: string): Promise<PackageRow[]> {
  return withUserClient(userId, async (client) => {
    const r = await client.query(
      `select package_id, version, status, manifest, created_at
         from packages where workspace_id = $1 and tax_year = $2 order by version desc`,
      [ws, TAX_YEAR],
    );
    return r.rows.map((row) => ({
      package_id: row.package_id,
      version: row.version,
      status: row.status,
      forms: ((row.manifest?.manifest?.forms ?? []) as { form_id: string }[]).map((f) => f.form_id),
      created_at: (row.created_at as Date).toISOString(),
    }));
  });
}
