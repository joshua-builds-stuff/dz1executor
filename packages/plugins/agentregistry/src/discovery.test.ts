import { describe, expect, it } from "@effect/vitest";

import { parseGitHubUrl, repositoryUrl } from "./github";
import {
  directoryOf,
  manifestPaths,
  parseFrontmatter,
  toCandidate,
  toManifest,
  toManifestStream,
  toRegistryName,
} from "./discovery";

describe("parseGitHubUrl", () => {
  it("accepts the shapes people paste", () => {
    for (const input of [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/",
      "https://github.com/owner/repo.git",
      "github.com/owner/repo",
      "www.github.com/owner/repo",
      "git@github.com:owner/repo.git",
      "owner/repo",
    ]) {
      const parsed = parseGitHubUrl(input);
      expect(parsed.ok, input).toBe(true);
      expect(parsed.ok && parsed.target).toEqual({ owner: "owner", repo: "repo" });
    }
  });

  it("reads the branch and directory out of a /tree/ link", () => {
    const parsed = parseGitHubUrl("https://github.com/owner/repo/tree/main/skills/deploy");
    expect(parsed.ok && parsed.target).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "main",
      subfolder: "skills/deploy",
    });
  });

  it("resolves a /blob/ link to the directory holding the file", () => {
    const parsed = parseGitHubUrl("https://github.com/owner/repo/blob/v2/skills/deploy/SKILL.md");
    expect(parsed.ok && parsed.target).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "v2",
      subfolder: "skills/deploy",
    });
  });

  it("accepts a bare owner/repo whose name contains a dot", () => {
    const parsed = parseGitHubUrl("owner/repo.js");
    expect(parsed.ok && parsed.target).toEqual({ owner: "owner", repo: "repo.js" });
  });

  it("rejects non-GitHub and malformed input with an actionable message", () => {
    for (const input of ["", "https://gitlab.com/owner/repo", "https://github.com/owner"]) {
      const parsed = parseGitHubUrl(input);
      expect(parsed.ok, input).toBe(false);
      expect(!parsed.ok && parsed.error.length).toBeGreaterThan(0);
    }
  });

  it("refuses a path that tries to escape the repository", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/tree/main/../../etc").ok).toBe(false);
  });

  it("canonicalizes the clone URL regardless of what was pasted", () => {
    expect(repositoryUrl({ owner: "owner", repo: "repo" })).toBe("https://github.com/owner/repo");
  });
});

describe("parseFrontmatter", () => {
  it("reads scalars, quoted values, and block scalars", () => {
    const fields = parseFrontmatter(
      [
        "---",
        "name: deploy-helper",
        'title: "Deploy Helper"',
        "description: >",
        "  Ship the service safely.",
        "  Covers rollback too.",
        "allowed-tools: Bash, Read",
        "---",
        "",
        "# Deploy Helper",
      ].join("\n"),
    );
    expect(fields).toEqual({
      name: "deploy-helper",
      title: "Deploy Helper",
      description: "Ship the service safely. Covers rollback too.",
      "allowed-tools": "Bash, Read",
    });
  });

  it("returns nothing when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\n")).toEqual({});
    expect(parseFrontmatter("---\nname: unterminated\n")).toEqual({});
  });
});

describe("toRegistryName", () => {
  it("slugifies to a registry-safe name", () => {
    expect(toRegistryName("Deploy Helper")).toBe("deploy-helper");
    expect(toRegistryName("  weird__name!! ")).toBe("weird-name");
    expect(toRegistryName("!!!")).toBe("unnamed");
    expect(toRegistryName("a".repeat(80)).length).toBe(63);
  });
});

describe("manifestPaths", () => {
  const listing = [
    { path: "SKILL.md", type: "blob" },
    { path: "skills/deploy/SKILL.md", type: "blob" },
    { path: "skills/review/SKILL.md", type: "blob" },
    { path: "skills/review/reference.md", type: "blob" },
    { path: "node_modules/pkg/SKILL.md", type: "blob" },
    { path: "skills", type: "tree" },
    { path: ".claude-plugin/plugin.json", type: "blob" },
  ];

  it("finds every SKILL.md outside ignored directories", () => {
    expect(manifestPaths("skills", listing)).toEqual([
      "SKILL.md",
      "skills/deploy/SKILL.md",
      "skills/review/SKILL.md",
    ]);
  });

  it("narrows to a linked subdirectory", () => {
    expect(manifestPaths("skills", listing, "skills/review")).toEqual(["skills/review/SKILL.md"]);
  });

  it("finds plugin manifests for the plugins kind", () => {
    expect(manifestPaths("plugins", listing)).toEqual([".claude-plugin/plugin.json"]);
  });
});

describe("directoryOf", () => {
  it("maps a manifest path to its installable directory", () => {
    expect(directoryOf("SKILL.md", "skills")).toBeUndefined();
    expect(directoryOf("skills/deploy/SKILL.md", "skills")).toBe("skills/deploy");
    expect(directoryOf(".claude-plugin/plugin.json", "plugins")).toBeUndefined();
    expect(directoryOf("packs/a/.claude-plugin/plugin.json", "plugins")).toBe("packs/a");
  });
});

describe("toCandidate", () => {
  it("prefers frontmatter over the directory name for skills", () => {
    const candidate = toCandidate({
      kind: "skills",
      manifestPath: "skills/deploy/SKILL.md",
      body: "---\nname: Deploy Helper\ndescription: Ships things.\n---\n",
      repoName: "repo",
      repoDescription: "repo description",
    });
    expect(candidate).toEqual({
      name: "deploy-helper",
      description: "Ships things.",
      subfolder: "skills/deploy",
      manifestPath: "skills/deploy/SKILL.md",
      harnesses: [],
    });
  });

  it("falls back to the directory name and repo description", () => {
    const candidate = toCandidate({
      kind: "skills",
      manifestPath: "skills/review/SKILL.md",
      body: "# no frontmatter\n",
      repoName: "repo",
      repoDescription: "repo description",
    });
    expect(candidate.name).toBe("review");
    expect(candidate.description).toBe("repo description");
  });

  it("reads a plugin manifest and defaults its harness", () => {
    const candidate = toCandidate({
      kind: "plugins",
      manifestPath: ".claude-plugin/plugin.json",
      body: JSON.stringify({ name: "Formatter", description: "Formats code." }),
      repoName: "repo",
      repoDescription: "",
    });
    expect(candidate.name).toBe("formatter");
    expect(candidate.harnesses).toEqual(["claude-code"]);
  });

  it("survives a malformed plugin manifest", () => {
    const candidate = toCandidate({
      kind: "plugins",
      manifestPath: "packs/a/.claude-plugin/plugin.json",
      body: "{ not json",
      repoName: "repo",
      repoDescription: "fallback",
    });
    expect(candidate.name).toBe("a");
    expect(candidate.description).toBe("fallback");
  });
});

describe("toManifest", () => {
  const candidate = {
    name: "deploy-helper",
    description: "Ships things.",
    subfolder: "skills/deploy",
    manifestPath: "skills/deploy/SKILL.md",
    harnesses: [],
  };
  const shared = {
    namespace: "default",
    tag: "latest",
    repositoryUrl: "https://github.com/owner/repo",
    branch: "main",
    commit: "abc123",
    author: "octocat",
  };

  it("pins the commit and records provenance for a skill", () => {
    const manifest = toManifest({ ...shared, kind: "skills", candidate });
    expect(manifest).toMatchObject({
      apiVersion: "ar.dev/v1alpha1",
      kind: "Skill",
      metadata: {
        name: "deploy-helper",
        namespace: "default",
        tag: "latest",
        annotations: {
          "executor.dev/source-commit": "abc123",
          "executor.dev/source-branch": "main",
          "executor.dev/source-author": "octocat",
          "executor.dev/source-subfolder": "skills/deploy",
        },
      },
      spec: {
        description: "Ships things.",
        source: {
          repository: {
            url: "https://github.com/owner/repo",
            branch: "main",
            commit: "abc123",
            subfolder: "skills/deploy",
          },
        },
      },
    });
  });

  it("nests the git source and keeps harnesses for a plugin", () => {
    const manifest = toManifest({
      ...shared,
      kind: "plugins",
      candidate: { ...candidate, harnesses: ["claude-code"] },
    });
    expect(manifest).toMatchObject({
      kind: "Plugin",
      spec: {
        harnesses: ["claude-code"],
        source: { type: "git", git: { repository: { commit: "abc123" } } },
      },
    });
  });

  it("emits a multi-document stream the apply endpoint accepts", () => {
    const stream = toManifestStream([
      toManifest({ ...shared, kind: "skills", candidate }),
      toManifest({ ...shared, kind: "skills", candidate: { ...candidate, name: "other" } }),
    ]);
    expect(stream.split("\n---\n")).toHaveLength(2);
  });
});
