/**
 * Keep this fork current with the repository it was forked from.
 *
 * Every morning (see `.github/workflows/upstream-sync.yml`) this fetches the
 * upstream default branch and, when it carries commits our `main` does not,
 * rewrites the `sync/upstream` branch and opens or updates ONE pull request
 * from it. The branch is `main` plus a merge of upstream when that merge is
 * clean; when it conflicts, the branch is the raw upstream tip so the pull
 * request shows the conflicts and a person resolves them on the branch.
 *
 * The pull request body carries an `<!-- upstream-sync:<sha> -->` marker naming
 * the upstream commit it was built from. While upstream still sits at that
 * commit the run leaves the branch alone, so a manual conflict resolution
 * pushed to `sync/upstream` survives until upstream moves again.
 *
 * Commands:
 *   run [--dry-run]   Fetch, compare, push the branch, create or update the PR.
 *                     `--dry-run` stops before pushing and prints the plan.
 *   self-check        Exercise the pure helpers. No network.
 *
 * Environment (all optional): UPSTREAM_REPOSITORY (`owner/name`, default: the
 * fork's parent from the GitHub API), UPSTREAM_BRANCH (default: upstream's
 * default branch), BASE_BRANCH (default `main`), GH_TOKEN for `gh`.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const SYNC_BRANCH = "sync/upstream";
const MARKER_PATTERN = /<!-- upstream-sync:([0-9a-f]{40}) -->/;
const MAX_LISTED_COMMITS = 60;

export type MergeState = "clean" | "conflicts";

export interface UpstreamCommit {
  author: string;
  sha: string;
  subject: string;
}

export interface SyncReport {
  baseBranch: string;
  baseSha: string;
  commits: UpstreamCommit[];
  count: number;
  mergeState: MergeState;
  runUrl: string | null;
  upstreamBranch: string;
  upstreamRepository: string;
  upstreamSha: string;
}

function sh(command: string, args: string[], options: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const detail = error as { stderr?: string; status?: number };
    throw new Error(
      `${command} ${args.join(" ")} failed (${detail.status ?? "?"}): ${(detail.stderr ?? "").trim().slice(-2_000)}`,
    );
  }
}

const git = (args: string[], options?: { allowFailure?: boolean }) => sh("git", args, options);
const gh = (args: string[], options?: { allowFailure?: boolean }) => sh("gh", args, options);

export function renderMarker(upstreamSha: string): string {
  return `<!-- upstream-sync:${upstreamSha} -->`;
}

export function readMarker(body: string | null | undefined): string | null {
  const match = MARKER_PATTERN.exec(body ?? "");
  return match?.[1] ?? null;
}

/** Parses `git log --format=%H%x1f%s%x1f%an%x1e`. */
export function parseCommitLog(raw: string): UpstreamCommit[] {
  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", subject = "", author = ""] = record.split("\x1f");
      return { author, sha, subject };
    });
}

export function renderPrTitle(report: Pick<SyncReport, "count" | "mergeState" | "upstreamRepository">): string {
  const noun = report.count === 1 ? "commit" : "commits";
  const suffix = report.mergeState === "conflicts" ? " (conflicts to resolve)" : "";
  return `chore(sync): ${report.count} new upstream ${noun} from ${report.upstreamRepository}${suffix}`;
}

export function renderPrBody(report: SyncReport): string {
  const upstreamUrl = `https://github.com/${report.upstreamRepository}`;
  const compareUrl = `${upstreamUrl}/compare/${report.baseSha.slice(0, 12)}...${report.upstreamSha.slice(0, 12)}`;
  const listed = report.commits.slice(0, MAX_LISTED_COMMITS);
  const lines = [
    `Automated sync with [${report.upstreamRepository}](${upstreamUrl}) \`${report.upstreamBranch}\`.`,
    "",
    `- Upstream tip: [\`${report.upstreamSha.slice(0, 12)}\`](${upstreamUrl}/commit/${report.upstreamSha})`,
    `- Fork \`${report.baseBranch}\`: \`${report.baseSha.slice(0, 12)}\``,
    `- New upstream commits: ${report.count} ([compare](${compareUrl}))`,
    report.mergeState === "clean"
      ? `- Branch \`${SYNC_BRANCH}\`: \`${report.baseBranch}\` plus a clean merge of upstream. Merge this PR to take the changes.`
      : `- Branch \`${SYNC_BRANCH}\`: the raw upstream tip, because merging it into \`${report.baseBranch}\` **conflicts**. Resolve on the branch (\`git fetch origin ${SYNC_BRANCH} && git checkout ${SYNC_BRANCH} && git merge ${report.baseBranch}\`), push, and the next run keeps your resolution until upstream moves again.`,
    "",
    "## Upstream commits",
    "",
    ...listed.map(
      (commit) => `- [\`${commit.sha.slice(0, 10)}\`](${upstreamUrl}/commit/${commit.sha}) ${commit.subject} (${commit.author})`,
    ),
    ...(report.count > listed.length ? ["", `…and ${report.count - listed.length} more.`] : []),
    "",
    report.runUrl ? `Built by [upstream-sync](${report.runUrl}). This PR is rewritten whenever upstream moves; do not push unrelated work to its branch.` : "Built by upstream-sync. This PR is rewritten whenever upstream moves; do not push unrelated work to its branch.",
    "",
    renderMarker(report.upstreamSha),
    "",
  ];
  return lines.join("\n");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function summarize(markdown: string): void {
  process.stdout.write(`${markdown}\n`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);
}

interface OpenPullRequest {
  body: string;
  number: number;
  url: string;
}

function findSyncPullRequest(baseBranch: string): OpenPullRequest | null {
  const raw = gh(["pr", "list", "--head", SYNC_BRANCH, "--base", baseBranch, "--state", "open", "--limit", "1", "--json", "number,body,url"]);
  const parsed = JSON.parse(raw || "[]") as OpenPullRequest[];
  return parsed[0] ?? null;
}

async function run(dryRun: boolean): Promise<void> {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const baseBranch = process.env.BASE_BRANCH?.trim() || "main";
  const upstreamRepository =
    process.env.UPSTREAM_REPOSITORY?.trim() || gh(["api", `repos/${repository}`, "--jq", ".parent.full_name // empty"]);
  if (!upstreamRepository) {
    summarize(`**upstream-sync**: \`${repository}\` is not a fork and \`UPSTREAM_REPOSITORY\` is not set; nothing to do.`);
    return;
  }
  const upstreamBranch =
    process.env.UPSTREAM_BRANCH?.trim() || gh(["api", `repos/${upstreamRepository}`, "--jq", ".default_branch"]);

  if (!git(["remote"], { allowFailure: true }).split("\n").includes("upstream")) {
    git(["remote", "add", "upstream", `https://github.com/${upstreamRepository}.git`]);
  }
  git(["fetch", "--no-tags", "upstream", upstreamBranch]);
  git(["fetch", "--no-tags", "origin", baseBranch]);
  const upstreamRef = `upstream/${upstreamBranch}`;
  const baseRef = `origin/${baseBranch}`;
  const upstreamSha = git(["rev-parse", upstreamRef]);
  const baseSha = git(["rev-parse", baseRef]);
  const commits = parseCommitLog(git(["log", "--no-merges", "--format=%H%x1f%s%x1f%an%x1e", `${baseRef}..${upstreamRef}`]));
  const count = Number(git(["rev-list", "--count", `${baseRef}..${upstreamRef}`]));

  const existing = findSyncPullRequest(baseBranch);
  if (count === 0) {
    summarize(
      `**upstream-sync**: \`${baseBranch}\` already contains every commit of ${upstreamRepository} \`${upstreamBranch}\` (\`${upstreamSha.slice(0, 12)}\`).` +
        (existing ? ` The open sync PR ${existing.url} was left untouched.` : ""),
    );
    return;
  }
  if (existing && readMarker(existing.body) === upstreamSha) {
    summarize(`**upstream-sync**: ${existing.url} is already built from upstream \`${upstreamSha.slice(0, 12)}\`; nothing to do.`);
    return;
  }

  git(["checkout", "-q", "-B", SYNC_BRANCH, baseRef]);
  let mergeState: MergeState = "clean";
  const mergeMessage = `chore(sync): merge ${upstreamRepository} ${upstreamBranch} at ${upstreamSha.slice(0, 12)}`;
  try {
    git(["merge", "--no-ff", "--no-edit", "-m", mergeMessage, upstreamRef]);
  } catch {
    git(["merge", "--abort"], { allowFailure: true });
    git(["reset", "-q", "--hard", upstreamRef]);
    mergeState = "conflicts";
  }

  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const report: SyncReport = { baseBranch, baseSha, commits, count, mergeState, runUrl, upstreamBranch, upstreamRepository, upstreamSha };
  const title = renderPrTitle(report);
  const body = renderPrBody(report);

  if (dryRun) {
    summarize(`**upstream-sync (dry run)**: would push \`${SYNC_BRANCH}\` (${mergeState}) and ${existing ? `update ${existing.url}` : "open a PR"} titled "${title}".\n\n${body}`);
    return;
  }

  git(["push", "--force", "origin", `${SYNC_BRANCH}:${SYNC_BRANCH}`]);
  let url: string;
  if (existing) {
    gh(["pr", "edit", String(existing.number), "--title", title, "--body", body]);
    url = existing.url;
  } else {
    url = gh(["pr", "create", "--base", baseBranch, "--head", SYNC_BRANCH, "--title", title, "--body", body]);
  }
  summarize(`**upstream-sync**: ${existing ? "updated" : "opened"} ${url} with ${count} upstream commit(s), merge ${mergeState}.`);
}

function selfCheck(): void {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  if (readMarker(renderMarker(sha)) !== sha) throw new Error("self-check: marker does not round-trip");
  if (readMarker("no marker here") !== null) throw new Error("self-check: marker false positive");
  const commits = parseCommitLog(`${sha}\x1ffix(web): one\x1fAda\x1e\n${sha}\x1ffeat: two\x1fGrace\x1e\n`);
  if (commits.length !== 2 || commits[1]?.subject !== "feat: two" || commits[1]?.author !== "Grace") {
    throw new Error("self-check: commit log parsing");
  }
  const report: SyncReport = {
    baseBranch: "main",
    baseSha: sha,
    commits,
    count: 2,
    mergeState: "conflicts",
    runUrl: null,
    upstreamBranch: "main",
    upstreamRepository: "nexu-io/open-design",
    upstreamSha: sha,
  };
  const body = renderPrBody(report);
  if (readMarker(body) !== sha) throw new Error("self-check: body lost the marker");
  if (!body.includes("feat: two") || !body.includes("**conflicts**")) throw new Error("self-check: body content");
  const title = renderPrTitle(report);
  if (title !== "chore(sync): 2 new upstream commits from nexu-io/open-design (conflicts to resolve)") {
    throw new Error(`self-check: title ${title}`);
  }
  if (renderPrTitle({ ...report, count: 1, mergeState: "clean" }) !== "chore(sync): 1 new upstream commit from nexu-io/open-design") {
    throw new Error("self-check: clean title");
  }
  process.stdout.write("upstream-sync self-check passed\n");
}

const [command, ...rest] = process.argv.slice(2);
if (command === "self-check") {
  selfCheck();
} else if (command === "run") {
  await run(rest.includes("--dry-run"));
} else {
  process.stderr.write("usage: upstream-sync.ts <run [--dry-run] | self-check>\n");
  process.exit(2);
}
