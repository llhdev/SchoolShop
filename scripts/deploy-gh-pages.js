// Publishes dist/ to the gh-pages branch via the GitHub REST API.
// Use this when github.com:443 (git push) is unreachable but api.github.com
// works — gh-pages pushes are plain git-over-HTTPS and die with the web host.
//
// Usage: node scripts/deploy-gh-pages.js
// Auth: uses `gh auth token`; repo is hardcoded below.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'llhdev/SchoolShop';
const BRANCH = 'gh-pages';
const DIST = path.join(__dirname, '..', 'dist');

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const api = async (method, url, body) => {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
};

function collectFiles(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...collectFiles(full, rel));
    else files.push({ rel, full });
  }
  return files;
}

(async () => {
  const files = collectFiles(DIST);
  console.log(`publishing ${files.length} files to ${REPO}@${BRANCH}`);

  const ref = await api(
    'GET',
    `/repos/${REPO}/git/ref/heads/${BRANCH}`
  );
  const parentSha = ref.object.sha;

  // Binary assets (fonts, icons, images) must go up as base64 — reading them
  // as utf8 corrupts non-UTF-8 bytes into U+FFFD and the browser then fails
  // with "Failed to decode downloaded font". The tree API's inline
  // `encoding: 'base64'` is unreliable for this, so create real blobs via
  // the blobs endpoint and reference them by sha in the tree.
  const tree = [];
  for (const { rel, full } of files) {
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      encoding: 'base64',
      content: fs.readFileSync(full).toString('base64'),
    });
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await api('POST', `/repos/${REPO}/git/trees`, {
    base_tree: parentSha,
    tree,
  });

  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message: `deploy: web build ${new Date().toISOString()}`,
    tree: newTree.sha,
    parents: [parentSha],
  });

  await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha,
  });

  console.log(`done: ${commit.sha.slice(0, 7)}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
