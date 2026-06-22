import {
  assertSkillMutationAllowed,
  assertSkillPathAllowedByPolicy,
  buildSkillAccessDeniedMessage,
  isSkillAccessPolicyRestrictive,
  type SkillAccessPolicy,
} from "./skillAccessPolicy";

export type PathScope = "workspace" | "skill" | "external" | "temp" | "artifact";

export type PathIntent =
  | "read"
  | "write"
  | "edit"
  | "delete"
  | "list"
  | "search"
  | "cwd"
  | "image";

export type ResolvedPath = {
  scope: PathScope;
  input: string;
  absolutePath: string;
  relativePath?: string;
  displayPath: string;
  pathRef: string;
  workdir: string;
  intent: PathIntent;
  skillBaseDir?: string;
};

type ResolveOptions = {
  label: string;
  intent: PathIntent;
  required?: boolean;
  allowExternal?: boolean;
  preferSkill?: boolean;
};

type ResolverOptions = {
  workdir: string;
  skillsRootEnabled?: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  resolveSkillsRootDir?: () => Promise<string>;
};

function normalizeUnicode(value: string) {
  return typeof value.normalize === "function" ? value.normalize("NFC") : value;
}

function normalizeWindowsExtendedPrefix(value: string) {
  if (/^\/\/[?.]\/UNC\//i.test(value)) {
    return `//${value.slice("//?/UNC/".length)}`;
  }
  if (/^\/\/[?.]\/[a-zA-Z]:\//.test(value)) {
    return value.slice("//?/".length);
  }
  return value;
}

function collapseDuplicateSeparators(value: string) {
  if (value.startsWith("//")) {
    return `//${value.slice(2).replace(/\/{2,}/g, "/")}`;
  }
  return value.replace(/\/{2,}/g, "/");
}

export function normalizeComparablePath(path: string) {
  const normalized = collapseDuplicateSeparators(
    normalizeWindowsExtendedPrefix(normalizeUnicode(String(path || "")).trim().replace(/\\/g, "/")),
  );
  if (/^[a-zA-Z]:\/?$/.test(normalized)) return normalized.replace(/\/?$/, "/");
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/g, "");
}

function isWindowsDrivePath(value: string) {
  return /^[a-zA-Z]:\//.test(value);
}

function isAbsolutePath(value: string) {
  return value.startsWith("/") || isWindowsDrivePath(value);
}

function isUncPath(value: string) {
  return value.startsWith("//");
}

function normalizeRootPath(rootDir: string) {
  const normalized = normalizeComparablePath(rootDir);
  if (!normalized) throw new Error("Workspace root is not configured");
  if (isUncPath(normalized)) throw new Error(`Workspace root cannot be a UNC path: ${rootDir}`);
  return normalized;
}

export function relativePathFromAbsolute(rawPath: string, rootDir: string) {
  const path = normalizeComparablePath(rawPath);
  const root = normalizeComparablePath(rootDir);
  if (!path || !root) return null;

  const windowsCompare = isWindowsDrivePath(path) || isWindowsDrivePath(root);
  const comparablePath = windowsCompare ? path.toLowerCase() : path;
  const comparableRoot = windowsCompare ? root.toLowerCase() : root;

  if (comparablePath === comparableRoot) return "";
  return comparablePath.startsWith(`${comparableRoot}/`) ? path.slice(root.length + 1) : null;
}

function inferHomeDirFromKnownRoot(rootDir: string | undefined) {
  const value = normalizeComparablePath(rootDir || "");
  if (!value) return null;
  const unixHome = value.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (unixHome) return unixHome[1];
  const windowsHome = value.match(/^([a-zA-Z]:\/Users\/[^/]+)/);
  return windowsHome ? windowsHome[1] : null;
}

function parseFileUrl(value: string) {
  if (!/^file:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
      throw new Error(`Invalid file URL: UNC paths are not supported: ${value}`);
    }
    let pathname = decodeURIComponent(url.pathname || "");
    if (pathname.startsWith("//")) {
      throw new Error(`Invalid file URL: UNC paths are not supported: ${value}`);
    }
    if (/^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
    return normalizeComparablePath(pathname);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid file URL:")) {
      throw error;
    }
    throw new Error(`Invalid file URL: ${value}`);
  }
}

function normalizeRawPathInput(input: unknown, label: string) {
  if (typeof input !== "string") return "";
  const value = normalizeWindowsExtendedPrefix(normalizeUnicode(input.trim()).replace(/\\/g, "/"));
  if (value.includes("\0")) {
    throw new Error(`${label} contains a NUL byte and cannot be resolved`);
  }
  return value;
}

function isWindowsReservedPathComponent(input: string) {
  const stem = input
    .split(".")
    .at(0)
    ?.trim()
    .replace(/[ .]+$/g, "")
    .toUpperCase();
  if (!stem) return false;
  return (
    stem === "CON" ||
    stem === "PRN" ||
    stem === "AUX" ||
    stem === "NUL" ||
    (/^(COM|LPT)[1-9]$/.test(stem))
  );
}

function sanitizeRelativePath(input: string, label: string, required: boolean) {
  const normalized = normalizeUnicode(input.trim()).replace(/\\/g, "/");
  if (!normalized) {
    if (required) throw new Error(`${label} is required`);
    return undefined;
  }
  if (isUncPath(normalized)) throw new Error(`${label} cannot be a UNC path`);
  if (isAbsolutePath(normalized)) {
    throw new Error(`${label} cannot escape its resolved scope`);
  }

  const segments: string[] = [];
  for (const rawSegment of normalized.split("/")) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new Error(`${label} cannot contain .. segments`);
    if (segment.includes(":")) throw new Error(`${label} cannot contain ':' path segments`);
    if (segment.includes("\0")) throw new Error(`${label} contains a NUL byte`);
    if (isWindowsReservedPathComponent(segment)) {
      throw new Error(`${label} contains a Windows reserved path component: ${segment}`);
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    if (required) throw new Error(`${label} must identify a file or directory`);
    return undefined;
  }
  return segments.join("/");
}

function joinNormalizedPath(rootDir: string, relativePath?: string) {
  const root = normalizeRootPath(rootDir);
  if (!relativePath) return root;
  if (root === "/") return `/${relativePath}`;
  return `${root.replace(/\/+$/g, "")}/${relativePath}`;
}

function firstPathSegment(path: string | undefined) {
  return path?.split("/").find(Boolean) ?? "";
}

function pathRefFor(scope: PathScope, relativePath: string | undefined, absolutePath: string) {
  if (scope === "workspace") return `workspace:${relativePath ?? ""}`;
  if (scope === "skill") return `skill:${relativePath ?? ""}`;
  return fileUrlForAbsolutePath(absolutePath);
}

function fileUrlForAbsolutePath(absolutePath: string) {
  const normalized = normalizeComparablePath(absolutePath);
  const parts = normalized.split("/").map((segment, index) => {
    if (index === 0 && /^[a-zA-Z]:$/.test(segment)) return segment;
    return encodeURIComponent(segment);
  });
  const encodedPath = parts.join("/");
  return isWindowsDrivePath(normalized) ? `file:///${encodedPath}` : `file://${encodedPath}`;
}

function displayPathFor(scope: PathScope, relativePath: string | undefined, absolutePath: string) {
  if (scope === "workspace") return relativePath || ".";
  if (scope === "skill") return `skill://${relativePath || ""}`;
  return absolutePath;
}

function parseScopedPathRef(value: string) {
  const match = value.match(/^(workspace|skill):(.*)$/i);
  if (!match) return null;
  return {
    scope: match[1].toLowerCase() as "workspace" | "skill",
    relativePath: match[2].replace(/^\/+/, ""),
  };
}

function parseSkillUrl(value: string) {
  if (!/^skill:\/\//i.test(value)) return null;
  const rest = value.replace(/^skill:\/\//i, "").replace(/^\/+/, "");
  return rest;
}

function fixedSkillsRelativePathFromAbsolute(value: string) {
  const normalized = normalizeComparablePath(value);
  const marker = "/.liveagent/skills/";
  const index = normalized.indexOf(marker);
  if (index < 0) return null;
  return normalized.slice(index + marker.length);
}

function operationForIntent(intent: PathIntent, label: string) {
  switch (intent) {
    case "write":
      return `Write(${label})`;
    case "edit":
      return `Edit(${label})`;
    case "delete":
      return `Delete(${label})`;
    case "list":
      return `List(${label})`;
    case "search":
      return `Search(${label})`;
    case "cwd":
      return `Bash(${label})`;
    case "image":
      return `Image(${label})`;
    case "read":
    default:
      return `Read(${label})`;
  }
}

export function formatResolvedTarget(path: Pick<ResolvedPath, "displayPath"> | undefined) {
  return path?.displayPath || ".";
}

export class ToolPathResolver {
  private readonly workdir: string;
  private readonly skillsRootEnabled: boolean;
  private readonly skillAccessPolicy?: SkillAccessPolicy;
  private readonly resolveSkillsRootDir?: () => Promise<string>;
  private skillsRootDir: string;

  constructor(options: ResolverOptions) {
    this.workdir = normalizeRootPath(options.workdir);
    this.skillsRootEnabled = options.skillsRootEnabled === true;
    this.skillsRootDir =
      typeof options.skillsRootDir === "string" ? normalizeComparablePath(options.skillsRootDir) : "";
    this.skillAccessPolicy = options.skillAccessPolicy;
    this.resolveSkillsRootDir = options.resolveSkillsRootDir;
  }

  setSkillsRootDir(rootDir: string | undefined) {
    this.skillsRootDir = typeof rootDir === "string" ? normalizeComparablePath(rootDir) : "";
  }

  private async getSkillsRootDir() {
    if (!this.skillsRootEnabled) return "";
    if (this.skillsRootDir) return this.skillsRootDir;
    const resolved = await this.resolveSkillsRootDir?.();
    this.skillsRootDir = typeof resolved === "string" ? normalizeComparablePath(resolved) : "";
    return this.skillsRootDir;
  }

  private inferHomeDir() {
    return inferHomeDirFromKnownRoot(this.skillsRootDir) ?? inferHomeDirFromKnownRoot(this.workdir);
  }

  private expandTilde(value: string) {
    if (value !== "~" && !value.startsWith("~/")) return value;
    const home = this.inferHomeDir();
    if (!home) {
      throw new Error("Cannot resolve ~/ because the user home directory is unknown");
    }
    return normalizeComparablePath(`${home}${value === "~" ? "" : value.slice(1)}`);
  }

  private async resolveSkillRelativePath(
    relativePath: string | undefined,
    options: ResolveOptions,
  ): Promise<ResolvedPath> {
    const skillsRootDir = await this.getSkillsRootDir();
    if (!skillsRootDir) {
      throw new Error(`${options.label} points to a Skill path, but Skills are not enabled`);
    }
    const sanitized = sanitizeRelativePath(relativePath ?? "", options.label, options.required === true);
    if (!sanitized && isSkillAccessPolicyRestrictive(this.skillAccessPolicy)) {
      throw new Error(
        buildSkillAccessDeniedMessage({
          operation: operationForIntent(options.intent, options.label),
          allowedSkillNames: this.skillAccessPolicy?.allowedSkillNames,
        }),
      );
    }
    const operation = operationForIntent(options.intent, options.label);
    if (sanitized) {
      assertSkillPathAllowedByPolicy(this.skillAccessPolicy, sanitized, operation);
      if (options.intent === "write" || options.intent === "edit" || options.intent === "delete") {
        assertSkillMutationAllowed(this.skillAccessPolicy, operation, sanitized);
      }
    }
    const absolutePath = joinNormalizedPath(skillsRootDir, sanitized);
    return {
      scope: "skill",
      input: relativePath ?? "",
      absolutePath,
      relativePath: sanitized,
      displayPath: displayPathFor("skill", sanitized, absolutePath),
      pathRef: pathRefFor("skill", sanitized, absolutePath),
      workdir: skillsRootDir,
      intent: options.intent,
      skillBaseDir: firstPathSegment(sanitized),
    };
  }

  private resolveWorkspaceRelativePath(
    relativePath: string | undefined,
    options: ResolveOptions,
  ): ResolvedPath {
    const sanitized = sanitizeRelativePath(relativePath ?? "", options.label, options.required === true);
    const absolutePath = joinNormalizedPath(this.workdir, sanitized);
    return {
      scope: "workspace",
      input: relativePath ?? "",
      absolutePath,
      relativePath: sanitized,
      displayPath: displayPathFor("workspace", sanitized, absolutePath),
      pathRef: pathRefFor("workspace", sanitized, absolutePath),
      workdir: this.workdir,
      intent: options.intent,
    };
  }

  private resolveExternalAbsolutePath(value: string, options: ResolveOptions): ResolvedPath {
    if (!options.allowExternal) {
      throw new Error(
        `${options.label} resolves outside the workspace and enabled Skills. Use a workspace path, an enabled skill:// path, or a pathRef returned by a previous tool.`,
      );
    }
    const absolutePath = normalizeComparablePath(value);
    return {
      scope: "external",
      input: value,
      absolutePath,
      displayPath: displayPathFor("external", undefined, absolutePath),
      pathRef: pathRefFor("external", undefined, absolutePath),
      workdir: absolutePath,
      intent: options.intent,
    };
  }

  private async resolveAbsolutePath(value: string, options: ResolveOptions): Promise<ResolvedPath> {
    const absolutePath = normalizeComparablePath(value);
    const workspaceRel = relativePathFromAbsolute(absolutePath, this.workdir);
    if (workspaceRel !== null) {
      return this.resolveWorkspaceRelativePath(workspaceRel, options);
    }

    const skillsRootDir = await this.getSkillsRootDir();
    if (skillsRootDir) {
      const skillRel = relativePathFromAbsolute(absolutePath, skillsRootDir);
      if (skillRel !== null) {
        return this.resolveSkillRelativePath(skillRel, options);
      }
    }

    const fixedSkillRel = fixedSkillsRelativePathFromAbsolute(absolutePath);
    if (fixedSkillRel !== null) {
      if (!this.skillsRootEnabled) {
        throw new Error(
          `${options.label} points to installed Skill files, but Skills are not enabled for this conversation. Enable the Skill, then use skill://${fixedSkillRel} or a pathRef returned by a file tool.`,
        );
      }
      return this.resolveSkillRelativePath(fixedSkillRel, options);
    }

    return this.resolveExternalAbsolutePath(absolutePath, options);
  }

  async resolvePath(input: unknown, options: ResolveOptions): Promise<ResolvedPath> {
    const raw = normalizeRawPathInput(input, options.label);
    if (!raw) {
      if (options.required) throw new Error(`${options.label} is required`);
      return this.resolveWorkspaceRelativePath(undefined, options);
    }

    if (isUncPath(raw)) throw new Error(`${options.label} cannot be a UNC path`);

    const scopedRef = parseScopedPathRef(raw);
    if (scopedRef?.scope === "workspace") {
      return this.resolveWorkspaceRelativePath(scopedRef.relativePath, options);
    }
    if (scopedRef?.scope === "skill") {
      return this.resolveSkillRelativePath(scopedRef.relativePath, options);
    }

    const skillUrlPath = parseSkillUrl(raw);
    if (skillUrlPath !== null) {
      return this.resolveSkillRelativePath(skillUrlPath, options);
    }

    const fileUrlPath = parseFileUrl(raw);
    if (fileUrlPath !== null) {
      return this.resolveAbsolutePath(fileUrlPath, options);
    }

    const expanded = raw.startsWith("~") ? this.expandTilde(raw) : raw;
    if (isUncPath(expanded)) throw new Error(`${options.label} cannot be a UNC path`);
    if (isAbsolutePath(expanded)) {
      return this.resolveAbsolutePath(expanded, options);
    }

    if (options.preferSkill) {
      return this.resolveSkillRelativePath(expanded, options);
    }
    return this.resolveWorkspaceRelativePath(expanded, options);
  }
}
