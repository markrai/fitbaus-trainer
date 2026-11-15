"use strict";

const { spawnSync } = require("child_process");
const { fail } = require("./common.cjs");

/**
 * GitHub Actions workflow-run `path` is often ".github/workflows/release.yml@main".
 * Accept bare paths and path@ref; validate both halves when present.
 */
function parseWorkflowRunPath(pathValue) {
  const text = String(pathValue || "").trim();
  if (!text) return { workflowFile: "", ref: null, raw: text };
  const at = text.lastIndexOf("@");
  if (at <= 0) {
    return { workflowFile: text, ref: null, raw: text };
  }
  return {
    workflowFile: text.slice(0, at),
    ref: text.slice(at + 1),
    raw: text,
  };
}

function ghApiJson(args, { runner } = {}) {
  // `gh api` does not accept --repo. Use fully qualified repos/{owner}/{repo}/... endpoints.
  if (args[0] !== "api") fail(`assert-candidate-run expected gh api args, got: ${args.join(" ")}`);
  if (args.includes("--repo") || args.includes("-R")) {
    fail("gh api must not receive --repo; use a fully qualified repos/... endpoint");
  }
  const result = runner
    ? runner(args)
    : spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`gh ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || "null");
}

function assertTrustedWorkflowPath(pathValue, { expectedWorkflowFile, defaultBranch, runId }) {
  const parsed = parseWorkflowRunPath(pathValue);
  if (!parsed.workflowFile) {
    fail(`Candidate run ${runId} missing workflow path`);
  }
  if (parsed.workflowFile !== expectedWorkflowFile) {
    fail(
      `Candidate run ${runId} workflow file ${parsed.workflowFile} != ${expectedWorkflowFile} ` +
        `(raw path=${parsed.raw})`,
    );
  }
  if (parsed.ref != null && parsed.ref !== defaultBranch) {
    fail(
      `Candidate run ${runId} workflow path ref ${parsed.ref} != ${defaultBranch} ` +
        `(raw path=${parsed.raw})`,
    );
  }
  return parsed;
}

/**
 * Ensure candidate_run_id is a successful inspect run of the trusted Release workflow
 * on the default branch — not an arbitrary artifact upload.
 */
function assertCandidateRun({
  repo,
  runId,
  defaultBranch,
  expectedWorkflowFile = ".github/workflows/release.yml",
  runner = null,
}) {
  if (!repo) fail("repo is required");
  if (!runId) fail("runId is required");
  if (!defaultBranch) fail("defaultBranch is required");

  const run = ghApiJson(["api", `repos/${repo}/actions/runs/${runId}`], { runner });

  if (run.conclusion !== "success") {
    fail(`Candidate run ${runId} conclusion is ${run.conclusion}, expected success`);
  }
  if (run.status !== "completed") {
    fail(`Candidate run ${runId} status is ${run.status}, expected completed`);
  }
  if (run.event !== "workflow_dispatch") {
    fail(`Candidate run ${runId} event is ${run.event}, expected workflow_dispatch`);
  }
  if (run.head_branch !== defaultBranch) {
    fail(`Candidate run ${runId} head_branch is ${run.head_branch}, expected ${defaultBranch}`);
  }

  const workflowPath = run.path || "";
  const workflowName = run.name || "";
  let parsedPath = null;
  if (workflowPath) {
    parsedPath = assertTrustedWorkflowPath(workflowPath, {
      expectedWorkflowFile,
      defaultBranch,
      runId,
    });
  } else if (workflowName !== "Release") {
    fail(
      `Candidate run ${runId} is not the trusted Release workflow (path=${workflowPath || "n/a"} name=${workflowName || "n/a"})`,
    );
  }

  // Job display name is "${mode} ${tag}" from release.yml — require an inspect job.
  const jobsPayload = ghApiJson(["api", `repos/${repo}/actions/runs/${runId}/jobs`], { runner });
  const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
  const inspectJob = jobs.find((job) => /^inspect\b/i.test(String(job.name || "")));
  if (!inspectJob) {
    const names = jobs.map((job) => job.name).filter(Boolean).join(", ") || "(none)";
    fail(
      `Candidate run ${runId} has no inspect job (found: ${names}). ` +
        `Refuse publish from non-inspect or foreign workflow runs.`,
    );
  }
  if (inspectJob.conclusion && inspectJob.conclusion !== "success") {
    fail(`Inspect job on run ${runId} conclusion is ${inspectJob.conclusion}, expected success`);
  }

  return {
    id: run.id,
    conclusion: run.conclusion,
    headBranch: run.head_branch,
    path: workflowPath || expectedWorkflowFile,
    workflowFile: parsedPath ? parsedPath.workflowFile : expectedWorkflowFile,
    workflowRef: parsedPath ? parsedPath.ref : null,
    name: workflowName,
    inspectJobName: inspectJob.name,
    htmlUrl: run.html_url || null,
  };
}

function parseArgs(argv) {
  const options = {
    repo: process.env.GH_REPO || null,
    runId: null,
    defaultBranch: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--run-id") options.runId = argv[++i];
    else if (arg === "--default-branch") options.defaultBranch = argv[++i];
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.repo || !options.runId || !options.defaultBranch) {
    fail("Usage: assert-candidate-run.cjs --repo owner/name --run-id N --default-branch main");
  }
  return options;
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const result = assertCandidateRun(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  assertCandidateRun,
  parseWorkflowRunPath,
  assertTrustedWorkflowPath,
};
