import type { ListPullRequestFiles } from "../../../engine/model/pull-request.js";

/** Requirement files whose diff carries the `pkg==version` pins. */
const REQUIREMENT_FILES = new Set([
  "package_constraints.txt",
  "requirements.txt",
  "requirements_all.txt",
  "requirements_docs.txt",
  "requirements_test.txt",
  "requirements_test_all.txt",
]);

/** Files a bump touches without changing any code. */
const BUMP_FILES = new Set([...REQUIREMENT_FILES, "manifest.json", "pyproject.toml"]);

const PIN = /^([+-])([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;#]+)\s*$/;

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** PEP 503 name normalization. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export interface Bump {
  name: string;
  version: string;
}

/**
 * The single package whose pin the PR moves from one version to another, or
 * undefined when it adds, removes or replaces packages, or bumps several.
 */
export function singleBump(files: ListPullRequestFiles): Bump | undefined {
  const added = new Map<string, Bump>();
  const removed = new Map<string, Set<string>>();
  for (const file of files) {
    if (!REQUIREMENT_FILES.has(basename(file.filename))) continue;
    for (const line of (file.patch ?? "").split("\n")) {
      const match = PIN.exec(line);
      if (!match) continue;
      const [, sign, name, version] = match;
      const key = normalize(name);
      if (sign === "+") {
        const prior = added.get(key);
        if (prior && prior.version !== version) return undefined;
        if (!prior) added.set(key, { name, version });
      } else {
        const versions = removed.get(key) ?? new Set<string>();
        versions.add(version);
        removed.set(key, versions);
      }
    }
  }
  if (added.size !== 1 || removed.size !== 1) return undefined;
  const [[key, bump]] = added;
  const old = removed.get(key);
  if (!old || old.has(bump.version)) return undefined;
  return bump;
}

/** Whether the PR changes more than metadata and tests. */
export function touchesCode(files: ListPullRequestFiles): boolean {
  return files.some(
    (f) => !f.filename.startsWith("tests/") && !BUMP_FILES.has(basename(f.filename)),
  );
}
