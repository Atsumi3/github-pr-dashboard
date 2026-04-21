// owner/name validation shared by routes/repos.js. GitHub allows letters,
// digits, hyphens, underscores, and dots in repository identifiers.
export const REPO_NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function validateOwnerName(owner, name) {
  return (
    typeof owner === 'string' &&
    typeof name === 'string' &&
    REPO_NAME_RE.test(owner) &&
    REPO_NAME_RE.test(name)
  );
}

export function parseRepoId(id) {
  if (typeof id !== 'string' || !id.includes('/')) return null;
  const parts = id.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!validateOwnerName(owner, name)) return null;
  return { owner, name, id: `${owner}/${name}` };
}
