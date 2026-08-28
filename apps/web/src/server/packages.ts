/**
 * File It: build the package from the deterministic layers and persist it as
 * a LOCKED row (§4 improvement (c): manifests are table rows, never eager
 * blobs; drafts are never persisted, so the P90 pile-up cannot recur).
 * Artifact BYTES are regenerated deterministically on demand and verified
 * against the locked SHA-256 hashes — a mismatch is a loud defect, never a
 * silent difference. (Hosted object storage arrives with the tester phase.)
 */
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import type { Clock } from '@taxfs/shared';
import { buildPackage, type PackageManifest } from '@taxfs/forms';
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

/** Build the current package deterministically (identity-free by
 *  construction — the server holds no identity fields to fill). Used by the
 *  lock action AND by artifact regeneration, so the two can never drift. */
export async function buildCurrentPackage(userId: string, ws: string) {
  const filing = await withUserClient(userId, (client) => filingContext(client, ws));
  if (!filing) throw new Error('complete Get Started first');
  const rel = releases();
  return withSpine({ userId, workspaceId: ws }, async (spine) => {
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
    return built;
  });
}

/**
 * Content hash for an artifact. Raw bytes for text artifacts (XML and
 * placeholders are byte-deterministic per the D.7 golden packages); for
 * FILLED PDFs the hash is over the CANONICAL content — every AcroForm
 * field's name and value, sorted — because pdf-lib embeds fonts with a
 * random per-process suffix, so presentation bytes differ across lambdas
 * while the return's actual content does not. A changed money line changes
 * a field value and still fails the check loudly.
 */
export async function artifactSha256(content: string, content_type: string): Promise<string> {
  if (content_type !== 'application/pdf') {
    return createHash('sha256').update(content).digest('hex');
  }
  const doc = await PDFDocument.load(Buffer.from(content, 'base64'), { ignoreEncryption: true, updateMetadata: false });
  const fields = doc
    .getForm()
    .getFields()
    .map((f) => [f.getName(), (f as { getText?: () => string | undefined }).getText?.() ?? (f as { isChecked?: () => boolean }).isChecked?.() ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export async function buildLockedPackage(userId: string, ws: string): Promise<void> {
  const rel = releases();
  const built = await buildCurrentPackage(userId, ws);
  {
    const artifactHashes = await Promise.all(built.artifacts.map(async (a) => ({
      artifact_id: a.artifact_id,
      target: a.target,
      sha256: await artifactSha256(a.content, a.content_type),
    })));
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
  }
}

/**
 * Regenerate one locked artifact's bytes on demand and VERIFY them against
 * the hash frozen at lock. Determinism is the storage; the hash check makes
 * any drift (facts changed since lock, release changed) a loud error, never
 * a silently different return. Identity fields are empty by construction.
 */
export async function regenerateArtifact(
  userId: string,
  ws: string,
  packageId: string,
  artifactId: string,
): Promise<{ content: string; content_type: string }> {
  const row = await withUserClient(userId, async (client) => {
    const r = await client.query(
      `select manifest from packages where workspace_id = $1 and package_id = $2 and status <> 'draft'`,
      [ws, packageId],
    );
    return r.rows[0] as { manifest: { artifact_hashes: { artifact_id: string; sha256: string }[] } } | undefined;
  });
  if (!row) throw new Error(`locked package ${packageId} not found`);
  const locked = row.manifest.artifact_hashes.find((h) => h.artifact_id === artifactId);
  if (!locked) throw new Error(`artifact ${artifactId} is not part of ${packageId}`);
  const built = await buildCurrentPackage(userId, ws);
  const artifact = built.artifacts.find((a) => a.artifact_id === artifactId);
  if (!artifact) throw new Error(`artifact ${artifactId} did not regenerate`);
  const sha = await artifactSha256(artifact.content, artifact.content_type);
  if (sha !== locked.sha256) {
    throw new Error(
      `artifact ${artifactId} no longer matches the locked package ${packageId} — the facts or releases changed since lock. Re-run the gates and lock a new version; locked history is never silently rewritten.`,
    );
  }
  return { content: artifact.content, content_type: artifact.content_type };
}

export interface PackageRow {
  package_id: string;
  version: number;
  status: string;
  forms: string[];
  created_at: string;
  /** Real-PDF artifacts of the locked package (browser fills identity). */
  pdfs: { artifact_id: string; form_id: string; label: string }[];
  /** The archived PackageManifest (post-filing consumers: markFiled, 1040-X). */
  manifest: PackageManifest;
}

export async function listPackages(userId: string, ws: string): Promise<PackageRow[]> {
  return withUserClient(userId, async (client) => {
    const r = await client.query(
      `select package_id, version, status, manifest, created_at
         from packages where workspace_id = $1 and tax_year = $2 order by version desc`,
      [ws, TAX_YEAR],
    );
    return r.rows.map((row) => {
      const hashes = (row.manifest?.artifact_hashes ?? []) as { artifact_id: string; target: string }[];
      const pdfs = hashes
        .filter((h) => h.artifact_id.startsWith('pdf:'))
        .map((h) => {
          const form_id = h.artifact_id.replace(/^pdf:/, '');
          return { artifact_id: h.artifact_id, form_id, label: form_id === 'IL1040' ? 'IL-1040' : form_id };
        })
        .filter((x) => x.form_id === '1040' || x.form_id === 'IL1040');
      return {
        package_id: row.package_id,
        version: row.version,
        status: row.status,
        manifest: row.manifest?.manifest as PackageManifest,
        forms: ((row.manifest?.manifest?.forms ?? []) as { form_id: string }[]).map((f) => f.form_id),
        created_at: (row.created_at as Date).toISOString(),
        pdfs,
      };
    });
  });
}
