// Compatibility: runtime engines range, installed version vs pin, lockfile integrity vs registry,
// and an actual import of the installed module.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CompatFinding } from "./types.js";

type V = [number, number, number];

export function parseVersion(v: string): V {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) throw new Error(`bad version ${v}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmp(a: V, b: V): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Supports the range forms used in engines fields: ||, >=, >, <=, <, ^, ~, exact, x, *. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  return range.split("||").some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts[0] === "*" || parts[0] === "x") return true;
    return parts.every((p) => {
      const m = p.match(/^(>=|<=|>|<|\^|~|=)?(.+)$/);
      if (!m) return false;
      const op = m[1] ?? "=";
      const t = parseVersion(m[2].replace(/\.x/g, ".0"));
      const c = cmp(v, t);
      switch (op) {
        case ">=": return c >= 0;
        case ">": return c > 0;
        case "<=": return c <= 0;
        case "<": return c < 0;
        case "~": return c >= 0 && v[0] === t[0] && v[1] === t[1];
        case "^":
          if (t[0] > 0) return c >= 0 && v[0] === t[0];
          if (t[1] > 0) return c >= 0 && v[0] === 0 && v[1] === t[1];
          return c >= 0 && v[0] === 0 && v[1] === 0 && v[2] === t[2];
        default: return c === 0;
      }
    });
  });
}

export async function checkCompat(
  name: string,
  pinnedVersion: string,
  registryIntegrity: string,
  enginesNode: string | undefined,
  projectRoot: string,
): Promise<CompatFinding> {
  const problems: string[] = [];
  const nodeVersion = process.versions.node;
  const enginesSatisfied = enginesNode ? satisfies(nodeVersion, enginesNode) : true;
  if (!enginesSatisfied) problems.push(`node ${nodeVersion} does not satisfy engines ${enginesNode}`);

  const pkgPath = join(projectRoot, "node_modules", name, "package.json");
  const installedVersion = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, "utf8")).version as string) : null;
  const installedMatchesPin = installedVersion === pinnedVersion;
  if (!installedVersion) problems.push(`${name} not installed`);
  else if (!installedMatchesPin) problems.push(`installed ${installedVersion} != pinned ${pinnedVersion}`);

  const projectPkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const declaredRange = projectPkg.dependencies?.[name];
  if (declaredRange !== pinnedVersion) problems.push(`package.json range ${declaredRange} is not an exact pin`);

  let lockfileIntegrity: string | null = null;
  // npm-shrinkwrap.json is the lockfile that ships inside packaged instances.
  const lockPath = [join(projectRoot, "npm-shrinkwrap.json"), join(projectRoot, "package-lock.json")].find(existsSync) ?? "";
  if (lockPath) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lockfileIntegrity = lock.packages?.[`node_modules/${name}`]?.integrity ?? null;
  } else problems.push("no package-lock.json or npm-shrinkwrap.json");
  const lockfileMatchesRegistry = lockfileIntegrity === registryIntegrity;
  if (!lockfileMatchesRegistry) problems.push("lockfile integrity does not match registry integrity");

  let importable = false;
  try {
    const mod = await import(name);
    importable = mod != null;
  } catch (e) {
    problems.push(`import failed: ${(e as Error).message}`);
  }

  return {
    nodeVersion,
    enginesRange: enginesNode ?? null,
    enginesSatisfied,
    installedVersion,
    installedMatchesPin,
    lockfileIntegrity,
    lockfileMatchesRegistry,
    importable,
    problems,
  };
}
