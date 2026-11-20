'use strict';
/*
 * jobResumeFactory.js — team-run tailored-resume factory (Oct 29, 2026).
 *
 * WHY THIS EXISTS: the 270 resumes in the pipeline were produced by a
 * one-off CEO-side factory run. Jesse's ruling: it only counts when the
 * MACF team's own machinery produces the outcome. This runner is that
 * machinery for the resume factory (Vikunja #908). It runs on macf-server
 * under the macf-job-resume-factory.timer systemd unit and closes the
 * loop the pipeline state machine leaves open:
 *
 *   candidate at ready_for_tailoring (no qualifying resume artifact)
 *     -> deterministic generation via engine/buildResumes.js
 *        (keyword-cluster tailoring over Jesse's canonical record ONLY —
 *        every line traces to team-skills/jesse-biography.md or
 *        biography-research/desktop-canonical-resume-jesse.md; nothing is
 *        invented, and no LLM is involved, so the stage can never depend
 *        on an agent remembering to do it)
 *     -> resume.md lands in the candidate folder
 *     -> the next macf-job-pipeline run flips the stage to resume_ready
 *        from the artifact on disk, never from a claim.
 *
 * The factory only fills gaps: a candidate with ANY existing resume
 * artifact is left untouched, and the written file must clear the
 * pipeline's MIN_RESUME_BYTES guard before it is counted as generated.
 */
const fs = require('fs');
const path = require('path');

const { sandboxDir, qualifyingResume, MIN_RESUME_BYTES } = require('./jobPipeline');
const { buildResume } = require('./buildResumes');

const STATE_FILE = path.join(__dirname, '..', '.state', 'job-resume-factory.json');
const RESUME_FILES = ['resume.pdf', 'resume.docx', 'resume.md'];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function run() {
  const sandbox = sandboxDir();
  const candRoot = path.join(sandbox, 'jobs', 'candidates');
  const summary = { ranAt: new Date().toISOString(), scanned: 0, generated: [], skippedExisting: 0, anomalies: [], errors: [] };
  if (!fs.existsSync(candRoot)) {
    console.log(JSON.stringify({ jobResumeFactory: summary }, null, 2));
    return summary;
  }
  for (const slug of fs.readdirSync(candRoot).sort()) {
    const dir = path.join(candRoot, slug);
    const status = readJson(path.join(dir, 'status.json'), null);
    if (!status || status.stage !== 'ready_for_tailoring') continue;
    summary.scanned++;
    if (qualifyingResume(dir)) { summary.skippedExisting++; continue; }
    const anyArtifact = RESUME_FILES.some(f => fs.existsSync(path.join(dir, f)));
    if (anyArtifact) {
      // A stub/placeholder exists but does not qualify. Never overwrite an
      // artifact silently — surface it as an anomaly instead.
      summary.anomalies.push({ slug, note: 'resume artifact present but below MIN_RESUME_BYTES; left untouched' });
      continue;
    }
    const posting = readJson(path.join(dir, 'posting.json'), null);
    if (!posting) { summary.errors.push({ slug, error: 'posting.json missing or unreadable' }); continue; }
    try {
      const md = buildResume({
        company: posting.company || status.company || '',
        title: posting.title || status.title || '',
        location: posting.location || null,
        salaryMin: posting.salaryMin || null,
        salaryMax: posting.salaryMax || null,
        slug,
      });
      const bytes = Buffer.byteLength(md, 'utf8');
      if (bytes <= MIN_RESUME_BYTES) {
        summary.errors.push({ slug, error: `generated resume only ${bytes} bytes (guard is ${MIN_RESUME_BYTES}) — not written` });
        continue;
      }
      fs.writeFileSync(path.join(dir, 'resume.md'), md);
      summary.generated.push({ slug, company: posting.company || null, title: posting.title || null, bytes });
      console.log(`jobResumeFactory: generated resume.md for ${slug} (${bytes} bytes)`);
    } catch (e) {
      summary.errors.push({ slug, error: String(e.message || e).slice(0, 300) });
    }
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ jobResumeFactory: { ranAt: summary.ranAt, scanned: summary.scanned, generated: summary.generated.length, skippedExisting: summary.skippedExisting, anomalies: summary.anomalies.length, errors: summary.errors.length } }, null, 2));
  return summary;
}

if (require.main === module) {
  try { run(); } catch (e) { console.error('jobResumeFactory ERROR:', String(e.message || e)); process.exit(2); }
}

module.exports = { run };
