#!/usr/bin/env node
'use strict';

/**
 * Provision the Cloudflare resources this form depends on.
 *
 * After the Pages project is connected to this repo via the Cloudflare
 * dashboard (one-time OAuth flow), git push → main triggers an auto-build
 * and deploy. This script is for the one-time *resource provisioning*:
 * creating the R2 buckets the Function writes to, binding them to the
 * Pages project, and optionally attaching a custom domain.
 *
 * Re-running is safe: every step checks state before mutating.
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN    , scoped to: Account R2:Edit + Pages:Edit
 *                             (+ optional Zone:DNS:Edit for custom domain)
 *
 * Optional env:
 *   CLOUDFLARE_ACCOUNT_ID   , inferred from /accounts if exactly one
 *
 * CLI:
 *   --project-name <name>   , Pages project (default: bukmuk-intake)
 *   --submissions-bucket    , R2 bucket for JSON submissions
 *                             (default: bukmuk-intake-submissions)
 *   --files-bucket          , R2 bucket for photo/artwork uploads
 *                             (default: bukmuk-intake-files)
 *   --domain <subdomain>    , optional custom domain to attach
 *                             (e.g. submit.bukmukpublishing.com)
 *   --dry-run               , show what would happen, don't mutate
 *   --skip-deploy           , do NOT run wrangler pages deploy at the end
 *                             (recommended once git-connected: deploys
 *                             happen on git push, not from this script)
 *
 * Typical run (after connecting the repo in the Cloudflare dashboard):
 *   node scripts/setup-cloudflare.js \
 *     --domain submit.bukmukpublishing.com --skip-deploy
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const API = 'https://api.cloudflare.com/client/v4';
// In this repo the form is at the repo root and this script lives in scripts/.
// (Earlier life of this script was inside bukmuk-editor, where the form was
// a subdirectory; FORM_DIR now resolves to the repo root.)
const PROJECT_ROOT = path.join(__dirname, '..');
const FORM_DIR = PROJECT_ROOT;

function parseArgs(argv){
  const o = {
    project: 'bukmuk-intake',
    submissions: 'bukmuk-intake-submissions',
    files: 'bukmuk-intake-files',
    domain: null,
    dryRun: false,
    skipDeploy: false,
  };
  for (let i = 2; i < argv.length; i++){
    const a = argv[i];
    if (a === '--project-name')        o.project     = argv[++i];
    else if (a === '--submissions-bucket') o.submissions = argv[++i];
    else if (a === '--files-bucket')   o.files       = argv[++i];
    else if (a === '--domain')         o.domain      = argv[++i];
    else if (a === '--dry-run')        o.dryRun      = true;
    else if (a === '--skip-deploy')    o.skipDeploy  = true;
  }
  return o;
}

function redact(s){
  // Never let a token slip into a log line accidentally.
  const t = process.env.CLOUDFLARE_API_TOKEN || '';
  if (!t) return s;
  return String(s).split(t).join('[CF_TOKEN_REDACTED]');
}

function log(line){ console.log(redact(line)); }
function err(line){ console.error(redact(line)); }

async function api(method, pathTail, body){
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  const url = pathTail.startsWith('http') ? pathTail : `${API}${pathTail}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

async function resolveAccountId(){
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const r = await api('GET', '/accounts');
  if (!r.ok || !r.json || !Array.isArray(r.json.result)){
    throw new Error(`could not list accounts: ${r.status}`);
  }
  if (r.json.result.length !== 1){
    throw new Error(`multiple accounts visible; set CLOUDFLARE_ACCOUNT_ID explicitly. Visible: ${r.json.result.map(a => a.id + ' (' + a.name + ')').join(', ')}`);
  }
  return r.json.result[0].id;
}

// ─── R2 bucket: create if missing ─────────────────────────────────────────
async function ensureBucket(accountId, name, opts){
  log(`• r2 bucket: ${name}`);
  // List first (the scope-light path)
  const list = await api('GET', `/accounts/${accountId}/r2/buckets`);
  if (list.ok && list.json && Array.isArray(list.json.result?.buckets || list.json.result)){
    const buckets = list.json.result.buckets || list.json.result;
    if (buckets.some(b => b.name === name)){
      log(`  ↳ already exists, leaving alone`);
      return;
    }
  }
  if (opts.dryRun){ log(`  ↳ [dry-run] would create`); return; }
  const res = await api('POST', `/accounts/${accountId}/r2/buckets`, { name });
  if (!res.ok){
    throw new Error(`failed to create R2 bucket "${name}": ${res.status} ${res.text}`);
  }
  log(`  ↳ created`);
}

// ─── Pages project: create if missing ─────────────────────────────────────
async function ensurePagesProject(accountId, name, opts){
  log(`• pages project: ${name}`);
  const got = await api('GET', `/accounts/${accountId}/pages/projects/${name}`);
  if (got.ok && got.json && got.json.result && got.json.result.name === name){
    log(`  ↳ already exists, leaving alone`);
    return got.json.result;
  }
  if (opts.dryRun){ log(`  ↳ [dry-run] would create`); return null; }
  // Direct-upload Pages project (no git connection); we'll deploy via wrangler.
  const res = await api('POST', `/accounts/${accountId}/pages/projects`, {
    name,
    production_branch: 'main',
  });
  if (!res.ok){
    throw new Error(`failed to create Pages project: ${res.status} ${res.text}`);
  }
  log(`  ↳ created`);
  return res.json.result;
}

// ─── Bind R2 buckets to the Pages project (production + preview) ──────────
async function bindR2Buckets(accountId, projectName, subBucket, filesBucket, opts){
  log(`• r2 bindings on Pages project ${projectName}`);
  const project = await api('GET', `/accounts/${accountId}/pages/projects/${projectName}`);
  if (!project.ok){
    if (opts.dryRun && project.status === 404){
      log(`  ↳ [dry-run] project doesn't exist yet; would set INTAKE_SUBMISSIONS + INTAKE_FILES bindings after creation`);
      return;
    }
    throw new Error(`could not GET pages project: ${project.status}`);
  }
  const cur = project.json.result?.deployment_configs || { production: {}, preview: {} };

  // R2 binding shape on a Pages project is { name } only.
  // An explicit jurisdiction:'default' is REJECTED at deploy time
  // ("invalid jurisdiction"); omit it entirely for the default region.
  const desired = {
    INTAKE_SUBMISSIONS: { name: subBucket },
    INTAKE_FILES:       { name: filesBucket },
  };

  // Only mutate when the desired bindings aren't already set.
  function same(env){
    const r = (env || {}).r2_buckets;
    if (!r) return false;
    return Object.keys(desired).every(k => r[k] && r[k].name === desired[k].name);
  }
  if (same(cur.production) && same(cur.preview)){
    log(`  ↳ bindings already in place`);
    return;
  }

  if (opts.dryRun){ log(`  ↳ [dry-run] would set INTAKE_SUBMISSIONS + INTAKE_FILES bindings`); return; }

  const patch = {
    deployment_configs: {
      production: { ...cur.production, r2_buckets: desired },
      preview:    { ...cur.preview,    r2_buckets: desired },
    },
  };
  const res = await api('PATCH', `/accounts/${accountId}/pages/projects/${projectName}`, patch);
  if (!res.ok){
    throw new Error(`failed to bind R2 buckets: ${res.status} ${res.text}`);
  }
  log(`  ↳ bound INTAKE_SUBMISSIONS → ${subBucket}, INTAKE_FILES → ${filesBucket}`);
}

// ─── Custom domain (optional) ─────────────────────────────────────────────
async function ensureCustomDomain(accountId, projectName, domain, opts){
  if (!domain) return;
  log(`• custom domain: ${domain}`);
  const list = await api('GET', `/accounts/${accountId}/pages/projects/${projectName}/domains`);
  if (list.ok && Array.isArray(list.json?.result)){
    if (list.json.result.some(d => d.name === domain)){
      log(`  ↳ already attached`);
      return;
    }
  }
  if (opts.dryRun){ log(`  ↳ [dry-run] would attach ${domain}`); return; }

  // Attach the domain to the Pages project
  const r = await api('POST', `/accounts/${accountId}/pages/projects/${projectName}/domains`, { name: domain });
  if (!r.ok){
    throw new Error(`failed to attach domain ${domain}: ${r.status} ${r.text}`);
  }
  log(`  ↳ attached (DNS validation may take a moment)`);

  // Also create the CNAME record if the zone is in this account.
  const parent = domain.split('.').slice(-2).join('.');
  const zones = await api('GET', `/zones?name=${encodeURIComponent(parent)}`);
  if (zones.ok && Array.isArray(zones.json?.result) && zones.json.result.length){
    const zoneId = zones.json.result[0].id;
    // Don't duplicate an existing record
    const recs = await api('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(domain)}`);
    if (recs.ok && Array.isArray(recs.json?.result) && recs.json.result.length){
      log(`  ↳ DNS record already exists for ${domain}, leaving alone`);
      return;
    }
    const target = `${projectName}.pages.dev`;
    const res = await api('POST', `/zones/${zoneId}/dns_records`, {
      type: 'CNAME', name: domain, content: target, ttl: 1, proxied: true,
    });
    if (!res.ok){
      err(`  ↳ ! could not create DNS CNAME (${res.status}). Add manually: ${domain} CNAME ${target}`);
    } else {
      log(`  ↳ DNS CNAME ${domain} → ${target} created (proxied)`);
    }
  } else {
    err(`  ↳ ! zone for ${parent} not in this account; add CNAME ${domain} → ${projectName}.pages.dev manually`);
  }
}

// ─── Deploy via wrangler ──────────────────────────────────────────────────
// Wrangler 4.x only discovers `functions/` when CWD is the deploy directory.
// Pointing at an absolute path with `pages deploy <abs>` from a parent dir
// silently skips Functions (deploys static assets only). Verified the hard
// way: `wrangler pages deploy intake-form` from the repo root uploads HTML
// + CSS + JS but NEVER says "Compiled Worker"; cd-ing into intake-form/
// first does.
function deployWithWrangler(projectName, opts){
  return new Promise((resolve, reject) => {
    if (opts.skipDeploy){ log(`• skipping wrangler deploy (--skip-deploy)`); return resolve(); }
    if (opts.dryRun){ log(`• [dry-run] would run (in repo root): wrangler pages deploy . --project-name ${projectName} --branch main`); return resolve(); }

    log(`• wrangler pages deploy . (CWD: repo root)`);
    const child = spawn('wrangler', [
      'pages', 'deploy', '.',
      '--project-name', projectName,
      '--branch', 'main',
      '--commit-dirty=true',
    ], {
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: FORM_DIR,
      env: process.env,
    });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`wrangler exited ${code}`)));
    child.on('error', reject);
  });
}

// ─── Pre-flight: token sanity check ───────────────────────────────────────
async function verifyToken(){
  const r = await api('GET', '/user/tokens/verify');
  if (!r.ok || !r.json?.success){
    throw new Error(`token verify failed: ${r.status} ${r.text}`);
  }
  log(`✓ token active (id ${r.json.result.id.slice(0, 8)}…)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main(){
  const opts = parseArgs(process.argv);
  if (!fs.existsSync(path.join(FORM_DIR, 'index.html'))){
    throw new Error(`intake form files missing at ${FORM_DIR} (no index.html)`);
  }
  if (!process.env.CLOUDFLARE_API_TOKEN){
    throw new Error('CLOUDFLARE_API_TOKEN environment variable is required');
  }

  log(`Bukmuk intake-form Cloudflare provisioning${opts.dryRun ? ' [DRY RUN]' : ''}`);
  log(`──────────────────────────────────────────────────────────────`);

  await verifyToken();
  const accountId = await resolveAccountId();
  log(`✓ account ${accountId.slice(0, 8)}…`);

  await ensureBucket(accountId, opts.submissions, opts);
  await ensureBucket(accountId, opts.files, opts);
  await ensurePagesProject(accountId, opts.project, opts);
  await bindR2Buckets(accountId, opts.project, opts.submissions, opts.files, opts);
  await deployWithWrangler(opts.project, opts);
  await ensureCustomDomain(accountId, opts.project, opts.domain, opts);

  log(`──────────────────────────────────────────────────────────────`);
  log(`Done.`);
  log(`  Pages URL:    https://${opts.project}.pages.dev`);
  if (opts.domain) log(`  Custom URL:   https://${opts.domain}`);
  log(`  Submissions:  R2 bucket "${opts.submissions}"`);
  log(`  Files:        R2 bucket "${opts.files}"`);
  log(`  Next: open the URL with ?book=monsoon-2026 to test.`);
}

main().catch(e => { err('✗ ' + e.message); process.exitCode = 1; });
