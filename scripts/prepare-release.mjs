import { readFileSync, writeFileSync } from 'node:fs';
import { env } from 'node:process';
import { URL } from 'node:url';

const packageFile = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
const { GITHUB_REF_NAME, GITHUB_SERVER_URL, GITHUB_REPOSITORY } = env;

const expectedTag = `v${manifest.version}`;
if (GITHUB_REF_NAME !== expectedTag) {
  throw new Error(`Release tag ${GITHUB_REF_NAME ?? '(unset)'} must match ${expectedTag}.`);
}
if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY) {
  throw new Error('GitHub Actions must supply the release repository.');
}

// Set provenance metadata from the actual TypeScript SDK repository for this tarball.
manifest.repository = {
  type: 'git',
  url: `git+${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git`,
};
writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
