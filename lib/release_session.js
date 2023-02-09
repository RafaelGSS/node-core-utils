import path from 'node:path';
import fs from 'node:fs';

import rimraf from 'rimraf';

import { getMergedConfig, getNcuDir } from './config.js';
import { readJson, writeJson, readFile, writeFile } from './file.js';
import {
  runAsync, runSync, forceRunAsync
} from './run.js';
import {
  shortSha
} from './utils.js';

const APPLYING = 'APPLYING';
const STARTED = 'STARTED';
const AMENDING = 'AMENDING';

export default class ReleaseSession {
  constructor(cli, dir) {
    this.cli = cli;
    this.dir = dir;
    this.config = getMergedConfig(this.dir);

    if (this.warnForMissing()) {
      throw new Error('Failed to create new session');
    }
  }

  get session() {
    return readJson(this.sessionPath);
  }

  get gitDir() {
    return path.join(this.dir, '.git');
  }

  get ncuDir() {
    return getNcuDir(this.dir);
  }

  get sessionPath() {
    return path.join(this.ncuDir, 'release');
  }

  get owner() {
    return this.config.owner || 'nodejs';
  }

  get repo() {
    return this.config.repo || 'node';
  }

  get username() {
    return this.config.username;
  }

  get upstream() {
    return this.config.upstream;
  }

  get branch() {
    return this.config.branch;
  }

  get readme() {
    return this.config.readme;
  }

  startReleasing() {
    writeJson(this.sessionPath, {
      state: STARTED,
      prid: this.prid,
      config: this.config
    });
  }

  cleanFiles() {
    let sess;
    try {
      sess = this.session;
    } catch (err) {
      return rimraf.sync(this.sessionPath);
    }

    if (sess.prid && sess.prid === this.prid) {
      rimraf.sync(this.pullDir);
    }
    rimraf.sync(this.sessionPath);
  }

  updateSession(update) {
    const old = this.session;
    writeJson(this.sessionPath, Object.assign(old, update));
  }

  hasStarted() {
    return !!this.session.prid && this.session.prid === this.prid;
  }

  isApplying() {
    return this.session.state === APPLYING;
  }

  cherryPickInProgress() {
    const cpPath = path.join(this.gitDir, 'CHERRY_PICK_HEAD');
    return fs.existsSync(cpPath);
  }

  restore() {
    const sess = this.session;
    if (sess.prid) {
      this.prid = sess.prid;
      this.config = sess.config;
    }
    return this;
  }

  async tryAbortCherryPick() {
    const { cli } = this;
    if (!this.cherryPickInProgress()) {
      return cli.ok('No git cherry-pick in progress');
    }
    const shouldAbortCherryPick = await cli.prompt(
      'Abort previous git cherry-pick sessions?');
    if (shouldAbortCherryPick) {
      await forceRunAsync('git', ['cherry-pick', '--abort']);
      cli.ok('Aborted previous git cherry-pick sessions');
    }
  }

  getCurrentRev() {
    return runSync('git', ['rev-parse', 'HEAD']).trim();
  }

  getCurrentBranch() {
    return runSync('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  }

  getUpstreamHead() {
    const { upstream, branch } = this;
    return runSync('git', ['rev-parse', `${upstream}/${branch}`]).trim();
  }

  getStrayCommits(verbose) {
    const { upstream, branch } = this;
    const ref = `${upstream}/${branch}...HEAD`;
    const gitCmd = verbose
      ? ['log', '--oneline', '--reverse', ref]
      : ['rev-list', '--reverse', ref];
    const revs = runSync('git', gitCmd).trim();
    return revs ? revs.split('\n') : [];
  }

  async tryResetHead() {
    const { cli, upstream, branch } = this;
    const branchName = `${upstream}/${branch}`;
    cli.startSpinner(`Bringing ${branchName} up to date...`);
    await runAsync('git', ['fetch', upstream, branch]);
    cli.stopSpinner(`${branchName} is now up-to-date`);
    const stray = this.getStrayCommits(true);
    if (!stray.length) {
      return;
    }
    cli.log(`${branch} is out of sync with ${branchName}. ` +
            'Mismatched commits:\n' +
      ` - ${stray.join('\n - ')}`);
    const shouldReset = await cli.prompt(`Reset to ${branchName}?`);
    if (shouldReset) {
      await runAsync('git', ['reset', '--hard', branchName]);
      cli.ok(`Reset to ${branchName}`);
    }
  }

  warnForMissing() {
    const { cli, upstream, username } = this;

    const missing = !username || !upstream;
    if (!upstream) {
      cli.warn('You have not told git-node the remote you want to sync with.');
      cli.separator();
      cli.info(
        'For example, if your remote pointing to nodejs/node is' +
        ' `remote-upstream`, you can run:\n\n' +
        '  $ ncu-config set upstream remote-upstream');
      cli.separator();
      cli.setExitCode(1);
    }
    if (!username) {
      cli.warn('You have not told git-node your username.');
      cli.separator();
      cli.info(
        'To fix this, you can run: ' +
        '  $ ncu-config set username <your_username>');
      cli.separator();
      cli.setExitCode(1);
    }

    return missing;
  }
}
