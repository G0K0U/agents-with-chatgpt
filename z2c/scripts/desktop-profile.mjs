/**
 * Canonical profile and child environment resolver for Desktop host/proxy.
 *
 * Provides a shared profile resolver implementing the canonical Windows
 * user profile derivation rule, ensuring child processes and credential
 * access resolve to the real user profile even when running in an isolated
 * HOME/USERPROFILE environment (e.g. sandbox/container/agent harness).
 */
import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolves the canonical user profile directory.
 * Rule: on Windows, if LOCALAPPDATA is an absolute path ending in AppData/Local
 * (case-insensitive), derive canonical user profile as dirname(dirname(LOCALAPPDATA));
 * otherwise use a consistent valid USERPROFILE/homedir fallback.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {string} [plat=process.platform]
 * @returns {string}
 */
export function resolveCanonicalProfile(env = process.env, plat = process.platform) {
  const isWindows = plat === "win32";
  if (isWindows) {
    const rawLocalAppData = env.LOCALAPPDATA || env.LocalAppData;
    if (typeof rawLocalAppData === "string") {
      const trimmed = rawLocalAppData.trim();
      const p = path.win32;
      if (isAbsoluteProfilePath(trimmed, p)) {
        const withoutTrailing = trimmed.replace(/[/\\]+$/, "");
        if (/(?:^|[/\\])AppData[/\\]Local$/i.test(withoutTrailing)) {
          return p.dirname(p.dirname(withoutTrailing));
        }
      }
    }
  }

  const userProfile = typeof env.USERPROFILE === "string" ? env.USERPROFILE.trim() : "";
  if (isAbsoluteProfilePath(userProfile, isWindows ? path.win32 : path)) return userProfile;
  return homedir();
}

function isAbsoluteProfilePath(value, p) {
  // Windows root-relative paths (\\Users\\...) still depend on the current drive.
  return !/[\x00-\x1f]/.test(value) && p.isAbsolute(value) &&
    (p !== path.win32 || /^(?:[a-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/i.test(value)) &&
    !value.split(/[/\\]/).some((part) => part === "." || part === "..");
}

/**
 * Resolves the path to the ZCode credentials store (.zcode/v2/credentials.json)
 * using the canonical profile instead of ambient homedir.
 *
 * @param {string} [canonicalProfile]
 * @param {string} [plat=process.platform]
 * @returns {string}
 */
export function resolveZCodeCredentialStore(
  canonicalProfile = resolveCanonicalProfile(),
  plat = process.platform,
) {
  const p = plat === "win32" ? path.win32 : path;
  return p.join(canonicalProfile, ".zcode", "v2", "credentials.json");
}

/**
 * Builds child process environment overriding USERPROFILE and HOME to
 * the canonical profile and preserving LOCALAPPDATA.
 *
 * @param {string} canonicalProfile
 * @param {Record<string, string | undefined>} [baseEnv=process.env]
 * @returns {Record<string, string | undefined>}
 */
export function buildDesktopChildEnv(canonicalProfile, baseEnv = process.env) {
  const childEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const upper = key.toUpperCase();
    if (upper === "USERPROFILE" || upper === "HOME") {
      continue;
    }
    childEnv[key] = value;
  }
  childEnv.USERPROFILE = canonicalProfile;
  childEnv.HOME = canonicalProfile;

  const localAppData = baseEnv.LOCALAPPDATA || baseEnv.LocalAppData;
  if (localAppData !== undefined) {
    childEnv.LOCALAPPDATA = localAppData;
  }

  return childEnv;
}
