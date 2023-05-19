import os from 'node:os';
import path from 'node:path';
import { getMetadata } from '../components/metadata.js';

import {
  runAsync, runSync, forceRunAsync
} from './run.js';
import { writeFile } from './file.js';
import {
  shortSha, getEditor
} from './utils.js';
import { getNcuDir } from './config.js';

const isWindows = process.platform === 'win32';

const LINT_RESULTS = {
  SKIPPED: 'skipped',
  FAILED: 'failed',
  SUCCESS: 'success'
};

export default class CheckPick {
  constructor(prid, owner, repo, dir, cli, {
    lint, oneCommitMax
  } = {}) {
    this.prid = prid;
    this.cli = cli;
    this.owner = owner;
    this.repo = repo;
    this.dir = dir;
    this.lint = lint;
    this.oneCommitMax = oneCommitMax;
    this.expectedCommitShas = [];
    this.metadata = undefined;
  }

  getUpstreamHead() {
    const { upstream, branch } = this;
    return runSync('git', ['rev-parse', `${upstream}/${branch}`]).trim();
  }

  getCurrentRev() {
    return runSync('git', ['rev-parse', 'HEAD']).trim();
  }

  get ncuDir() {
    return getNcuDir(this.dir);
  }

  get pullDir() {
    return path.join(this.ncuDir, `${this.prid}`);
  }

  getMessagePath(rev) {
    return path.join(this.pullDir, `${shortSha(rev)}.COMMIT_EDITMSG`);
  }

  saveMessage(rev, message) {
    const file = this.getMessagePath(rev);
    writeFile(file, message);
    return file;
  }

  async start() {
    const { cli } = this;

    const metadata = await getMetadata({
      prid: this.prid,
      owner: this.owner,
      repo: this.repo
    }, false, cli);
    const expectedCommitShas =
      metadata.data.commits.map(({ commit }) => commit.oid);

    try {
      const commitInfo = await this.downloadAndPatch(expectedCommitShas);
      const cleanLint = await this.validateLint();
      if (cleanLint === LINT_RESULTS.FAILED) {
        cli.error('Patch still contains lint errors. ' +
          'Please fix manually before proceeding');
        return false;
      } else if (cleanLint === LINT_RESULTS.SUCCESS) {
        cli.ok('Lint passed cleanly');
      }

      return this.amend(metadata.metadata, commitInfo);
    } catch (e) {
      cli.error(e.message);
      return false;
    }
  }

  async downloadAndPatch(expectedCommitShas) {
    const { cli, repo, owner, prid } = this;

    cli.startSpinner(`Downloading patch for ${prid}`);
    // fetch via ssh to handle private repo
    await runAsync('git', [
      'fetch', `git@github.com:${owner}/${repo}.git`,
      `refs/pull/${prid}/merge`]);
    // We fetched the commit that would result if we used `git merge`.
    // ^1 and ^2 refer to the PR base and the PR head, respectively.
    const [base, head] = await runAsync('git',
      ['rev-parse', 'FETCH_HEAD^1', 'FETCH_HEAD^2'],
      { captureStdout: 'lines' });
    const commitShas = await runAsync('git',
      ['rev-list', `${base}..${head}`],
      { captureStdout: 'lines' });
    cli.stopSpinner(`Fetched commits as ${shortSha(base)}..${shortSha(head)}`);
    cli.separator();

    const mismatchedCommits = [
      ...commitShas.filter((sha) => !expectedCommitShas.includes(sha))
        .map((sha) => `Unexpected commit ${sha}`),
      ...expectedCommitShas.filter((sha) => !commitShas.includes(sha))
        .map((sha) => `Missing commit ${sha}`)
    ].join('\n');
    if (mismatchedCommits.length > 0) {
      throw new Error(`Mismatched commits:\n${mismatchedCommits}`);
    }

    const commitInfo = { base, head, shas: commitShas };

    try {
      await forceRunAsync('git', ['cherry-pick', `${base}..${head}`], {
        ignoreFailure: false
      });
    } catch (ex) {
      await forceRunAsync('git', ['cherry-pick', '--abort']);
      throw new Error('Failed to apply patches');
    }

    cli.ok('Patches applied');
    return commitInfo;
  }

  async validateLint() {
    // The linter is currently only run on non-Windows platforms.
    if (os.platform() === 'win32') {
      return LINT_RESULTS.SKIPPED;
    }

    if (!this.lint) {
      return LINT_RESULTS.SKIPPED;
    }

    try {
      await runAsync('make', ['lint']);
      return LINT_RESULTS.SUCCESS;
    } catch {
      return LINT_RESULTS.FAILED;
    }
  }

  async amend(metadata, commitInfo) {
    const { cli } = this;
    const subjects = await runAsync('git',
      ['log', '--pretty=format:%s', `${commitInfo.base}..${commitInfo.head}`],
      { captureStdout: 'lines' });

    if (commitInfo.shas.length !== 1) {
      const fixupAll = await cli.prompt(
        `There are ${subjects.length} commits in the PR. ` +
        'Would you like to fixup everything into first commit?');
      if (!fixupAll) {
        // TODO: add this support?
        throw new Error(`There are ${subjects.length} commits in the PR ` +
          'and the ammend were not able to succeed');
      }
      await runAsync('git', ['reset', '--soft', `HEAD~${subjects.length - 1}`]);
      await runAsync('git', ['commit', '--amend', '--no-edit']);
    }

    await this._amend(metadata);
    return this.validateCommitAndFinish();
  }

  async _amend(metadataStr) {
    const { cli } = this;

    const rev = this.getCurrentRev();
    const original = runSync('git', [
      'show', 'HEAD', '-s', '--format=%B'
    ]).trim();
    // git has very specific rules about what is a trailer and what is not.
    // Instead of trying to implement those ourselves, let git parse the
    // original commit message and see if it outputs any trailers.
    const originalHasTrailers = runSync('git', [
      'interpret-trailers', '--parse', '--no-divider'
    ], {
      input: `${original}\n`
    }).trim().length !== 0;
    const metadata = metadataStr.trim().split('\n');
    const amended = original.split('\n');

    // If the original commit message already contains trailers (such as
    // "Co-authored-by"), we simply add our own metadata after those. Otherwise,
    // we have to add an empty line so that git recognizes our own metadata as
    // trailers in the amended commit message.
    if (!originalHasTrailers) {
      amended.push('');
    }

    const BACKPORT_RE = /BACKPORT-PR-URL\s*:\s*(\S+)/i;
    const PR_RE = /PR-URL\s*:\s*(\S+)/i;
    const REVIEW_RE = /Reviewed-By\s*:\s*(\S+)/i;

    for (const line of metadata) {
      if (line.length !== 0 && original.includes(line)) {
        if (originalHasTrailers) {
          cli.warn(`Found ${line}, skipping..`);
        } else {
          throw new Error(
            'Git found no trailers in the original commit message, ' +
            `but '${line}' is present and should be a trailer.`);
        }
      } else {
        if (line.match(BACKPORT_RE)) {
          let prIndex = amended.findIndex(datum => datum.match(PR_RE));
          if (prIndex === -1) {
            prIndex = amended.findIndex(datum => datum.match(REVIEW_RE)) - 1;
          }
          amended.splice(prIndex + 1, 0, line);
        } else {
          amended.push(line);
        }
      }
    }
    const message = amended.join('\n');
    const messageFile = this.saveMessage(rev, message);
    cli.separator('New Message');
    cli.log(message.trim());
    const takeMessage = await cli.prompt('Use this message?');
    if (takeMessage) {
      await runAsync('git', ['commit', '--amend', '-F', messageFile]);
      return true;
    }

    const editor = await getEditor({ git: true });
    if (editor) {
      try {
        await forceRunAsync(
          editor,
          [`"${messageFile}"`],
          { ignoreFailure: false, spawnArgs: { shell: true } }
        );
        await runAsync('git', ['commit', '--amend', '-F', messageFile]);
        return true;
      } catch {
        cli.warn(`Please manually edit ${messageFile}, then run\n` +
          `\`git commit --amend -F ${messageFile}\` ` +
          'to finish amending the message');
        throw new Error(
          'Failed to edit the message using the configured editor');
      }
    }
  }

  async validateCommitAndFinish() {
    const { cli } = this;

    const stray = this.getStrayCommits();
    if (stray.length > 1) {
      cli.error(
        'There is more than one commit in the PR. ' +
        'CherryPick currently do not support it.');
      return false;
    }

    const validateCommand = new URL(
      '../node_modules/.bin/core-validate-commit' + (isWindows ? '.cmd' : ''),
      import.meta.url
    );

    try {
      await forceRunAsync(validateCommand, stray, { ignoreFailure: false });
    } catch (e) {
      let forceLand = false;
      if (e.code === 1) {
        forceLand = await cli.prompt(
          'The commit did not pass the validation. ' +
          'Do you still want to land it?',
          { defaultAnswer: false });
      }

      if (!forceLand) {
        cli.info('Please fix the commit message and try again.');
        return false;
      }
    }

    cli.separator();
    let willBeLanded = shortSha(stray[stray.length - 1]);
    if (stray.length > 1) {
      const head = shortSha(this.getUpstreamHead());
      willBeLanded = `${head}...${willBeLanded}`;
    }
    cli.log(`Done in ${willBeLanded}`);
    return true;
  }
}
