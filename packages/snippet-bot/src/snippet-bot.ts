// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable node/no-extraneous-import */

import {Probot, Context} from 'probot';
import {EventPayloads} from '@octokit/webhooks';

import {Configuration, ConfigurationOptions} from './configuration';
import {DEFAULT_CONFIGURATION, CONFIGURATION_FILE_PATH} from './configuration';
import {
  parseRegionTags,
  parseRegionTagsInPullRequest,
  ParseResult,
} from './region-tag-parser';
import {
  formatBody,
  formatExpandable,
  formatRegionTag,
  formatViolations,
  formatMatchingViolation,
} from './utils';
import {invalidateCache} from './snippets';
import {
  Violation,
  checkProductPrefixViolations,
  checkRemovingUsedTagViolations,
} from './violations';

import {logger, addOrUpdateIssueComment} from 'gcf-utils';
import fetch from 'node-fetch';
import tmp from 'tmp-promise';
import tar from 'tar';
import util from 'util';
import fs from 'fs';
import {promises as pfs} from 'fs';
import path from 'path';

const streamPipeline = util.promisify(require('stream').pipeline);

type Conclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | undefined;

// Solely for avoid using `any` type.
interface Label {
  name: string;
}

interface File {
  content: string | undefined;
}

function isFile(file: File | unknown): file is File {
  return (file as File).content !== undefined;
}

const FULL_SCAN_ISSUE_TITLE = 'snippet-bot full scan';

const REFRESH_LABEL = 'snippet-bot:force-run';

const REFRESH_UI = '- [ ] Refresh this comment';
const REFRESH_STRING = '- [x] Refresh this comment';

async function downloadFile(url: string, file: string) {
  const response = await fetch(url);
  if (response.ok) {
    return streamPipeline(response.body, fs.createWriteStream(file));
  }
  throw new Error(`unexpected response ${response.statusText}`);
}

async function getFiles(dir: string, allFiles: string[]) {
  const files = (await pfs.readdir(dir)).map(f => path.join(dir, f));
  for (const f of files) {
    if (!(await pfs.stat(f)).isDirectory()) {
      allFiles.push(f);
    }
  }
  await Promise.all(
    files.map(
      async f => (await pfs.stat(f)).isDirectory() && getFiles(f, allFiles)
    )
  );
  return allFiles;
}

async function getConfigOptions(
  context: Context
): Promise<ConfigurationOptions | null> {
  let configOptions: ConfigurationOptions | null = null;
  try {
    configOptions = await context.config<ConfigurationOptions>(
      CONFIGURATION_FILE_PATH
    );
  } catch (err) {
    err.message = `Error reading configuration: ${err.message}`;
    logger.error(err);
  }
  return configOptions;
}

async function fullScan(context: Context, configuration: Configuration) {
  const installationId = context.payload.installation.id;
  const commentMark = `<!-- probot comment [${installationId}]-->`;
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;
  const defaultBranch = context.payload.repository.default_branch;

  if (!context.payload.issue?.title.includes(FULL_SCAN_ISSUE_TITLE)) {
    return;
  }
  // full scan start
  const issueNumber = context.payload.issue.number;

  const url = `https://github.com/${owner}/${repo}/tarball/${defaultBranch}`;
  const tmpDir = tmp.dirSync();
  logger.info(`working directory: ${tmpDir.name}`);

  const file = `${tmpDir.name}/${repo}.tar.gz`;
  // Download the default branch tarball and run full scan.
  try {
    await downloadFile(url, file);
    logger.info(`Downloaded to ${file}`);
    tar.x({
      file: file,
      cwd: tmpDir.name,
      sync: true,
    });
    let archiveDir!: string;
    for (const f of await pfs.readdir(tmpDir.name)) {
      const cur = tmpDir.name + '/' + f;
      const stat = await pfs.lstat(cur);
      if (stat.isDirectory()) {
        archiveDir = cur;
      }
    }
    if (archiveDir === undefined) {
      throw new Error('Failed to extract the archive');
    }
    // Determine the short commit hash from the directory name.
    // We'll use the hash for creating permalink.
    let commitHash = defaultBranch; // Defaulting to the default branch.
    const lastDashIndex = archiveDir.lastIndexOf('-');
    if (lastDashIndex !== -1) {
      commitHash = archiveDir.substr(lastDashIndex + 1);
    }
    logger.info(`Using commit hash "${commitHash}"`);
    const files = await getFiles(archiveDir, []);

    let mismatchedTags = false;
    const failureMessages: string[] = [];

    for (const file of files) {
      if (configuration.ignoredFile(file)) {
        logger.info('ignoring file from configuration: ' + file);
        continue;
      }
      try {
        const fileContents = await pfs.readFile(file, 'utf-8');
        const parseResult = parseRegionTags(
          fileContents,
          file.replace(archiveDir + '/', ''),
          owner,
          repo,
          commitHash
        );
        if (!parseResult.result) {
          mismatchedTags = true;
          for (const violation of parseResult.violations) {
            const formatted = formatMatchingViolation(violation);
            failureMessages.push(`- [ ] ${formatted}`);
          }
        }
      } catch (err) {
        err.message = `Failed to read the file: ${err.message}`;
        logger.error(err);
        continue;
      }
    }
    let bodyDetail = 'Great job! No unmatching region tags found!';
    if (mismatchedTags) {
      bodyDetail = failureMessages.join('\n');
    }
    await context.octokit.issues.update({
      owner: owner,
      repo: repo,
      issue_number: issueNumber,
      body: formatBody(
        context.payload.issue.body,
        commentMark,
        `## snippet-bot scan result
Life is too short to manually check unmatched region tags.
Here is the result:
${bodyDetail}`
      ),
    });
  } catch (err) {
    err.message = `Failed to scan files: ${err.message}`;
    logger.error(err);
    await context.octokit.issues.update({
      owner: owner,
      repo: repo,
      issue_number: issueNumber,
      body: formatBody(
        context.payload.issue.body,
        commentMark,
        `## snippet-bot scan result\nFailed running the full scan: ${err}.`
      ),
    });
  } finally {
    // Clean up the directory.
    await pfs.rmdir(tmpDir.name, {recursive: true});
  }
}

async function scanPullRequest(
  context: Context,
  pull_request: EventPayloads.WebhookPayloadPullRequestPullRequest,
  configuration: Configuration,
  refreshing = false
) {
  const installationId = context.payload.installation.id;
  const owner = context.payload.repository.owner.login;
  const repo = context.payload.repository.name;

  // Parse the PR diff and recognize added/deleted region tags.
  const result = await parseRegionTagsInPullRequest(
    pull_request.diff_url,
    pull_request.base.repo.owner.login,
    pull_request.base.repo.name,
    pull_request.base.sha,
    pull_request.head.repo.owner.login,
    pull_request.head.repo.name,
    pull_request.head.sha
  );

  let mismatchedTags = false;
  let tagsFound = false;
  const failureMessages: string[] = [];

  // Keep track of start tags in all the files.
  const parseResults = new Map<string, ParseResult>();

  // If we found any new files, verify they all have matching region tags.
  for (const file of result.files) {
    if (configuration.ignoredFile(file)) {
      logger.info('ignoring file from configuration: ' + file);
      continue;
    }
    try {
      const blob = await context.octokit.repos.getContent({
        owner: pull_request.head.repo.owner.login,
        repo: pull_request.head.repo.name,
        path: file,
        ref: pull_request.head.sha,
      });
      if (!isFile(blob.data)) {
        continue;
      }
      const fileContents = Buffer.from(blob.data.content, 'base64').toString(
        'utf8'
      );
      const parseResult = parseRegionTags(
        fileContents,
        file,
        owner,
        repo,
        pull_request.head.sha
      );
      parseResults.set(file, parseResult);
      if (!parseResult.result) {
        mismatchedTags = true;
        for (const violation of parseResult.violations) {
          failureMessages.push(formatMatchingViolation(violation));
        }
      }
      if (parseResult.tagsFound) {
        tagsFound = true;
      }
    } catch (err) {
      // Ignoring 403/404 errors.
      if (err.status === 403 || err.status === 404) {
        logger.info(
          `ignoring 403/404 errors upon fetching ${file}: ${err.message}`
        );
      } else {
        throw err;
      }
    }
  }

  const checkParams = context.repo({
    name: 'Mismatched region tag',
    conclusion: 'success' as Conclusion,
    head_sha: pull_request.head.sha,
    output: {
      title: 'Region tag check',
      summary: 'Region tag successful',
      text: 'Region tag successful',
    },
  });

  if (mismatchedTags) {
    checkParams.conclusion = 'failure';
    checkParams.output = {
      title: 'Mismatched region tag detected.',
      summary: 'Some new files have mismatched region tag',
      text: failureMessages.join('\n'),
    };
  }

  // post the status of commit linting to the PR, using:
  // https://developer.github.com/v3/checks/
  if (tagsFound) {
    await context.octokit.checks.create(checkParams);
  }

  let commentBody = '';

  if (result.changes.length === 0) {
    if (!refreshing) {
      return;
    }
    commentBody += 'No region tags are edited in this PR.\n';
  }

  // Add or update a comment on the PR.
  const prNumber = pull_request.number;

  // First check product prefix for added region tags.
  const productPrefixViolations = await checkProductPrefixViolations(
    result,
    configuration
  );
  const removingUsedTagsViolations = await checkRemovingUsedTagViolations(
    result,
    configuration,
    parseResults,
    pull_request.base.repo.full_name,
    pull_request.base.ref
  );
  const removeUsedTagViolations = removingUsedTagsViolations.get(
    'REMOVE_USED_TAG'
  ) as Violation[];
  const removeConflictingTagViolations = removingUsedTagsViolations.get(
    'REMOVE_CONFLICTING_TAG'
  ) as Violation[];
  const removeSampleBrowserViolations = removingUsedTagsViolations.get(
    'REMOVE_SAMPLE_BROWSER_PAGE'
  ) as Violation[];
  const removeFrozenRegionTagViolations = removingUsedTagsViolations.get(
    'REMOVE_FROZEN_REGION_TAG'
  ) as Violation[];

  if (
    productPrefixViolations.length > 0 ||
    removeUsedTagViolations.length > 0 ||
    removeConflictingTagViolations.length > 0
  ) {
    commentBody += 'Here is the summary of possible violations 😱';

    // Rendering prefix violations
    if (productPrefixViolations.length > 0) {
      let summary = '';
      if (productPrefixViolations.length === 1) {
        summary =
          'There is a possible violation for not having product prefix.';
      } else {
        summary = `There are ${productPrefixViolations.length} possible violations for not having product prefix.`;
      }
      commentBody += formatViolations(productPrefixViolations, summary);
    }

    // Rendering used tag violations
    if (removeUsedTagViolations.length > 0) {
      let summary = '';
      if (removeUsedTagViolations.length === 1) {
        summary =
          'There is a possible violation for removing region tag in use.';
      } else {
        summary = `There are ${removeUsedTagViolations.length} possible violations for removing region tag in use.`;
      }

      commentBody += formatViolations(removeUsedTagViolations, summary);
    }

    if (removeConflictingTagViolations.length > 0) {
      let summary = '';
      if (removeConflictingTagViolations.length === 1) {
        summary =
          'There is a possible violation for removing conflicting region tag in use.';
      } else {
        summary = `There are ${removeConflictingTagViolations.length} possible violations for removing conflicting region tag in use.`;
      }
      commentBody += formatViolations(removeConflictingTagViolations, summary);
    }
    commentBody +=
      '**The end of the violation section. All the stuff below is FYI purposes only.**\n\n';
    commentBody += '---\n';
  }

  if (removeSampleBrowserViolations.length > 0) {
    let summary = 'You are about to delete the following sample browser page';
    if (removeSampleBrowserViolations.length > 1) {
      summary += 's';
    }
    summary += '.';
    commentBody += formatViolations(removeSampleBrowserViolations, summary);
    commentBody += '---\n';
  }

  if (removeFrozenRegionTagViolations.length > 0) {
    let summary = 'You are about to delete the following frozen region tag';
    if (removeFrozenRegionTagViolations.length > 1) {
      summary += 's';
    }
    summary += '.';
    commentBody += formatViolations(removeFrozenRegionTagViolations, summary);
    commentBody += '---\n';
  }

  if (result.added > 0 || result.deleted > 0) {
    commentBody += 'Here is the summary of changes.\n';
  }

  if (result.added > 0) {
    const plural = result.added === 1 ? '' : 's';
    const summary = `You are about to add ${result.added} region tag${plural}.`;
    let detail = '';
    for (const change of result.changes) {
      if (change.type === 'add') {
        detail += `- ${formatRegionTag(change)}\n`;
      }
    }
    commentBody += formatExpandable(summary, detail);
  }
  if (result.deleted > 0) {
    const plural = result.deleted === 1 ? '' : 's';
    const summary = `You are about to delete ${result.deleted} region tag${plural}.\n`;
    let detail = '';
    for (const change of result.changes) {
      if (change.type === 'del') {
        detail += `- ${formatRegionTag(change)}\n`;
      }
    }
    commentBody += formatExpandable(summary, detail);
  }

  commentBody += `---
This comment is generated by [snippet-bot](https://github.com/apps/snippet-bot).
If you find problems with this result, please file an issue at:
https://github.com/googleapis/repo-automation-bots/issues.
To update this comment, add \`${REFRESH_LABEL}\` label or use the checkbox below:
${REFRESH_UI}
`;

  await addOrUpdateIssueComment(
    context.octokit,
    owner,
    repo,
    prNumber,
    installationId,
    commentBody
  );

  // emit metrics
  logger.metric('snippet-bot-violations', {
    target: pull_request.url,
    violation_type: 'UNMATCHED_REGION_TAG',
    count: failureMessages.length,
  });
  logger.metric('snippet-bot-violations', {
    target: pull_request.url,
    violation_type: 'MISSING_PRODUCT_PREFIX',
    count: productPrefixViolations.length,
  });
  logger.metric('snippet-bot-violations', {
    target: pull_request.url,
    violation_type: 'REMOVING_USED_TAG',
    count:
      removeConflictingTagViolations.length + removeUsedTagViolations.length,
  });
}

/**
 * Creates a comment mark used for addOrupdateissuecomment.
 * I'll move this function to gcf-utils later.
 */
function getCommentMark(installationId: number | undefined): string {
  return `<!-- probot comment [${installationId}]-->`;
}

export = (app: Probot) => {
  app.on('issue_comment.edited', async context => {
    const commentMark = getCommentMark(context.payload.installation?.id);

    // If the comment is made by bots, and the comment has the refresh
    // checkbox checked, we'll proceed.
    if (
      !context.payload.comment.body.includes(commentMark) ||
      !context.payload.comment.body.includes(REFRESH_STRING)
    ) {
      return;
    }
    const repoUrl = context.payload.repository.full_name;
    const configOptions = await getConfigOptions(context);

    if (configOptions === null) {
      logger.info(`snippet-bot is not configured for ${repoUrl}.`);
      return;
    }
    const configuration = new Configuration({
      ...DEFAULT_CONFIGURATION,
      ...configOptions,
    });
    logger.info({config: configuration});
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const prNumber = context.payload.issue.number;
    const prResponse = await context.octokit.pulls.get({
      owner: owner,
      repo: repo,
      pull_number: prNumber,
    });
    // Invalidate the cache for Snippets.
    invalidateCache();

    // Examine the pull request.
    await scanPullRequest(
      context,
      prResponse.data as EventPayloads.WebhookPayloadPullRequestPullRequest,
      configuration,
      true
    );
  });

  app.on(['issues.opened', 'issues.reopened'], async context => {
    const repoUrl = context.payload.repository.full_name;
    const configOptions = await getConfigOptions(context);

    if (configOptions === null) {
      logger.info(`snippet-bot is not configured for ${repoUrl}.`);
      return;
    }
    const configuration = new Configuration({
      ...DEFAULT_CONFIGURATION,
      ...configOptions,
    });
    logger.info({config: configuration});
    await fullScan(context, configuration);
  });

  app.on('pull_request.labeled', async context => {
    const repoUrl = context.payload.repository.full_name;
    const configOptions = await getConfigOptions(context);

    if (configOptions === null) {
      logger.info(`snippet-bot is not configured for ${repoUrl}.`);
      return;
    }
    const configuration = new Configuration({
      ...DEFAULT_CONFIGURATION,
      ...configOptions,
    });
    logger.info({config: configuration});
    // Only proceeds if `snippet-bot:force-run` label is added.
    if (context.payload.pull_request.labels === undefined) {
      return;
    }
    // Exits when there's no REFRESH_LABEL
    const labelFound = context.payload.pull_request.labels.some(
      (label: Label) => {
        return label.name === REFRESH_LABEL;
      }
    );
    if (!labelFound) {
      return;
    }
    // Remove the label and proceed.
    try {
      await context.octokit.issues.removeLabel(
        context.issue({name: REFRESH_LABEL})
      );
    } catch (err) {
      // Ignoring 404 errors.
      if (err.status !== 404) {
        throw err;
      }
    }
    // Also invalidate the cache for Snippets.
    invalidateCache();

    // Examine the pull request.
    await scanPullRequest(
      context,
      context.payload.pull_request,
      configuration,
      true
    );
  });

  app.on(
    [
      'pull_request.opened',
      'pull_request.reopened',
      'pull_request.edited',
      'pull_request.synchronize',
    ],
    async context => {
      // Exit if the PR is closed.
      if (context.payload.pull_request.state === 'closed') {
        logger.info(
          `The pull request ${context.payload.pull_request.url} is closed, exiting.`
        );
        return;
      }
      // If the head repo is null, we can not proceed.
      if (
        context.payload.pull_request.head.repo === undefined ||
        context.payload.pull_request.head.repo === null
      ) {
        logger.info(
          `The head repo is undefined for ${context.payload.pull_request.url}, exiting.`
        );
        return;
      }

      const repoUrl = context.payload.repository.full_name;
      const configOptions = await getConfigOptions(context);

      if (configOptions === null) {
        logger.info(`snippet-bot is not configured for ${repoUrl}.`);
        return;
      }
      const configuration = new Configuration({
        ...DEFAULT_CONFIGURATION,
        ...configOptions,
      });
      logger.info({config: configuration});
      await scanPullRequest(
        context,
        context.payload.pull_request,
        configuration
      );
    }
  );
};
