// Deploys a Vercel preview (staging env vars are inlined from the project's
// Preview-scoped env) and points the stable staging alias at the new
// deployment so the test Telegram bot always serves the latest build.
//
// Usage: npm run deploy:staging
//
// See docs/staging-setup.md for the full staging workflow.

const { spawnSync } = require('child_process');

const STAGING_ALIAS = 'timor-shop-staging.vercel.app';

function run(args, options = {}) {
  return spawnSync('npx', args, { encoding: 'utf-8', shell: true, ...options });
}

const deploy = run(['vercel', 'deploy', '--yes']);
process.stdout.write(deploy.stdout || '');
process.stderr.write(deploy.stderr || '');
if (deploy.status !== 0) process.exit(deploy.status ?? 1);

const match = (deploy.stdout || '').match(/https:\/\/[^\s]+\.vercel\.app/);
if (!match) {
  console.error('Deploy succeeded but no preview URL was found in the output.');
  process.exit(1);
}

const deployHost = match[0].replace('https://', '');
console.log(`\nPointing ${STAGING_ALIAS} -> ${deployHost}`);
const alias = run(['vercel', 'alias', 'set', deployHost, STAGING_ALIAS], { stdio: 'inherit' });
process.exit(alias.status ?? 0);
