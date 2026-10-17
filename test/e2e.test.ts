// The whole loop: an agent stages a pull request with the CLI, a reviewer comments
// through the API (as the web UI does), the agent rewrites history, and the reviewer publishes.
import './helpers/env.ts';
import { fakes, restoreFakes, withFakes } from './helpers/fakes.ts';
import { until } from './helpers/until.ts';
import { after, afterEach, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createServer, type AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { startServer } from '../src/server/server.ts';
import { Db, now, type PullRow } from '../src/server/db.ts';
import { readSettings, saveSettings } from '../src/server/settings.ts';
import { AUTHOR_STALL_MS, Service, type ChangeEvent } from '../src/server/service.ts';
import { CodexReviewer } from '../src/server/reviewers/codex.ts';
import { ClaudeReviewer } from '../src/server/reviewers/claude.ts';
import { doneForAutoPublish } from '../src/server/reviewers/head-status.ts';
import { Repo } from '../src/server/git.ts';

const BIN = join(import.meta.dirname, '..', 'bin', 'galley.ts');

/** Whether /tmp is writable here: not in a reviewer agent's sandbox. */
function slashTmpWritable(): boolean {
  try {
    rmSync(mkdtempSync('/tmp/lx-'), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

const exec = promisify(execFile);

let dir: string;
let repo: string;
let remote: string;
let server: Awaited<ReturnType<typeof startServer>>;
/** The FAKE_* variables every test starts with. */
let startingFakes: Record<string, string>;

// Keep the user's git config out of the test, and use settings that change diff output,
// which the server must override.
// The reviewer signs with an SSH key, like a user with commit.gpgsign = true; agents commit unsigned.
// Nothing reaches GitHub: the server's fetches from the github.com remotes fail at once on a proxy
// that is not there, as from a remote it can not reach (pushes go to local bare repositories). The
// server allows https whatever the config says, so it can not be turned off that way.
const configDir = mkdtempSync(join(tmpdir(), 'galley-gitconfig-'));
const gitconfig = join(configDir, 'config');
const signingKey = join(configDir, 'id_ed25519');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'reviewer', '-f', signingKey]);
writeFileSync(
  gitconfig,
  '[diff]\n\tnoprefix = true\n\tmnemonicPrefix = true\n\tinterHunkContext = 10\n[log]\n\tshowSignature = true\n' +
    `[user]\n\tname = Reviewer\n\temail = reviewer@example.com\n\tsigningkey = ${signingKey}\n[gpg]\n\tformat = ssh\n[commit]\n\tgpgsign = true\n` +
    '[http]\n\tproxy = http://127.0.0.1:1\n',
);
delete process.env.NO_PROXY;
delete process.env.no_proxy;
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

/** A commit on top of `parent` whose short SHA is all digits, as about one commit in 27 has by chance. */
function digitCommit(parent: string): string {
  const tree = git('rev-parse', `${parent}^{tree}`);
  for (let i = 0; ; i++) {
    const body = `tree ${tree}\nparent ${parent}\nauthor Dev <dev@example.com> 1700000000 +0000\ncommitter Dev <dev@example.com> 1700000000 +0000\n\nDigits ${i}\n`;
    const sha = createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex');
    if (!/^[1-9]\d{6}/.test(sha)) continue;
    assert.equal(execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: body, encoding: 'utf8' }).trim(), sha);
    return sha;
  }
}

async function cli(args: string[], opts: { input?: string; actor?: string; cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = execFile(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? repo,
    env: { ...process.env, GALLEY_URL: server.url, GALLEY_ACTOR: opts.actor ?? 'agent', NO_COLOR: '1' },
  });
  if (opts.input !== undefined) child.stdin!.end(opts.input);
  else child.stdin!.end();
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  return { stdout, stderr, code };
}

/**
 * The wait that says the reviewer agents are done with the head, so the author asks the reviewer
 * to review it. It comes once per commit, before a wait that waits for the reviewer.
 */
async function handedOver(n?: number, opts: { actor?: string } = {}): Promise<string> {
  const r = await cli(['pr', 'wait', ...(n === undefined ? [] : [String(n)]), '--timeout', '20s'], opts);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /; ask the user to review it: /);
  return r.stdout;
}

/** Requests without an actor header act as the human reviewer, like the web UI. */
async function human(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(server.url + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'galley-test-'));
  remote = join(dir, 'remote.git');
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  // Pushes go to the local bare repository; the fetch URL still says GitHub.
  git('config', `url.${remote}.pushInsteadOf`, 'https://github.com/acme/widgets.git');
  writeFileSync(join(repo, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'Initial commit');
  git('push', '-q', 'origin', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  git('checkout', '-qb', 'feature/mul');
  writeFileSync(join(repo, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n\nexport function mul(a, b) {\n  return a * b;\n}\n');
  git('commit', '-qam', 'Add mul', '-m', 'Multiplication.');

  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    // FAKE_GH_FAIL makes `gh pr ...` fail with its value as the error, FAKE_GH_API_FAIL `gh api ...`. A file gh-merge-fail makes
    // the next `gh pr merge` fail with its contents. `gh pr view` answers FAKE_GH_VIEW, or an open pull request. With
    // FAKE_GH_GATE, `gh pr create` answers once that file exists, and with FAKE_GH_EDIT_GATE, `gh pr edit`.
    // The repository allows auto-merge and squash merges unless FAKE_GH_AUTO_MERGE or FAKE_GH_SQUASH is false. What GitHub
    // says about published pull requests comes from gh-pulls.json (see githubSays), an earlier page of their review threads
    // from gh-pulls-earlier.json. With FAKE_GH_NO_READ_ORG, GitHub refuses to name requested teams, as for a token without read:org.
    `#!/bin/sh\necho "$@" >> "${join(dir, 'gh.log')}"\ncat >> "${join(dir, 'gh-stdin.log')}"\nif [ -n "$FAKE_GH_GATE" ] && [ "$1 $2" = "pr create" ]; then while [ ! -f "$FAKE_GH_GATE" ]; do sleep 0.05; done; fi\nif [ -n "$FAKE_GH_EDIT_GATE" ] && [ "$1 $2" = "pr edit" ]; then while [ ! -f "$FAKE_GH_EDIT_GATE" ]; do sleep 0.05; done; fi\nif [ -n "$FAKE_GH_FAIL" ] && [ "$1" = pr ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi\nif [ -n "$FAKE_GH_API_FAIL" ] && [ "$1" = api ]; then echo "$FAKE_GH_API_FAIL" >&2; exit 1; fi\ncase "$1 $2" in\n  "pr create") echo "https://github.com/acme/widgets/pull/7" ;;\n` +
      `  "pr merge") if [ -f "${join(dir, 'gh-merge-fail')}" ]; then cat "${join(dir, 'gh-merge-fail')}" >&2; rm "${join(dir, 'gh-merge-fail')}"; exit 1; fi ;;\n` +
      `  "pr view") if [ -n "$FAKE_GH_VIEW" ]; then echo "$FAKE_GH_VIEW"; else echo '{"state":"OPEN"}'; fi ;;\n` +
      `  "api graphql") case "$4" in\n    *issueOrPullRequest*) echo '{"data":{"repository":{"i12":{"__typename":"Issue","title":"Widgets wobble","state":"OPEN","stateReason":null}}}}' ;;\n    *before:*) cat "${join(dir, 'gh-pulls-earlier.json')}" ;;\n    *"pullRequest("*) case "$4" in *combinedSlug*) if [ -n "$FAKE_GH_NO_READ_ORG" ]; then echo '{"errors":[{"type":"INSUFFICIENT_SCOPES","message":"Your token has not been granted the required scopes to execute this query."}]}'; echo 'gh: Your token has not been granted the required scopes to execute this query.' >&2; exit 1; fi ;; esac; cat "${join(dir, 'gh-pulls.json')}" 2>/dev/null || echo '{"data":{"repository":{}}}' ;;\n    *) printf '{"data":{"repository":{"autoMergeAllowed":%s,"squashMergeAllowed":%s,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}}}\\n' "\${FAKE_GH_AUTO_MERGE:-true}" "\${FAKE_GH_SQUASH:-true}" ;;\n  esac ;;\nesac\n`,
  );
  chmodSync(gh, 0o755);

  // A stand-in for the Codex CLI: a model catalog, `sandbox` standing in for the package manager
  // it runs (failing with FAKE_INSTALL_FAIL), and `exec` answering with FAKE_CODEX_REVIEW (or
  // failing, with FAKE_CODEX_FAIL), after FAKE_CODEX_SLEEP milliseconds or once the file
  // FAKE_CODEX_GATE exists. Where it may run the
  // tests, it leaves a read-only directory behind, as Go's module cache does. With --json it
  // prints what it does as `codex exec --json` does: it thinks, says something, reads math.js and
  // starts a git diff before it waits, and the diff ends when it answers. FAKE_CODEX_BIG makes the
  // read print 100 kB.
  const codex = join(dir, 'codex');
  process.env.FAKE_CODEX_LOG = join(dir, 'codex.log');
  process.env.FAKE_CODEX_SANDBOX_LOG = join(dir, 'codex-sandbox.log');
  writeFileSync(
    codex,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({ models: [
    { slug: 'gpt-test', display_name: 'GPT Test', description: 'For tests', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }], default_reasoning_level: 'low', visibility: 'list' },
    { slug: 'internal', visibility: 'hide' },
  ] }));
  process.exit(0);
}
if (args[0] === 'sandbox') {
  fs.appendFileSync(process.env.FAKE_CODEX_SANDBOX_LOG, JSON.stringify({ args, cwd: process.cwd(), store: process.env.npm_config_store_dir }) + '\\n');
  if (process.env.FAKE_INSTALL_FAIL) { console.error('ERR_PNPM_OUTDATED_LOCKFILE'); process.exit(1); }
  console.log('Packages: +3\\nDone in 1s');
  process.exit(0);
}
if (args[0] !== 'exec') process.exit(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, sawFile: fs.existsSync('codex.js'), tmpdir: process.env.TMPDIR, npmCache: process.env.npm_config_cache }) + '\\n');
if (args.includes('workspace-write')) {
  fs.mkdirSync('.cache/mod', { recursive: true });
  fs.chmodSync('.cache/mod', 0o555);
  fs.chmodSync('.cache', 0o555);
}
const say = (e) => args.includes('--json') && console.log(JSON.stringify(e));
const command = (id, cmd, status, output, exit_code) => say({ type: status === 'in_progress' ? 'item.started' : 'item.completed', item: { id, type: 'command_execution', command: cmd, aggregated_output: output, exit_code, status } });
say({ type: 'thread.started', thread_id: 'thread-1' });
say({ type: 'turn.started' });
say({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Reading the change**' } });
say({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'I will read math.js and the diff.' } });
const read = "/bin/zsh -lc \\"sed -n '2,20p' math.js\\"";
command('item_2', read, 'in_progress', '', null);
command('item_2', read, 'completed', process.env.FAKE_CODEX_BIG ? 'a'.repeat(50000) + 'x'.repeat(50000) : fs.readFileSync('math.js', 'utf8'), 0);
command('item_3', "/bin/zsh -lc 'git diff HEAD~1 HEAD'", 'in_progress', '', null);
const answer = () => {
  if (process.env.FAKE_CODEX_FAIL) { console.error('model overloaded'); process.exit(3); }
  command('item_3', "/bin/zsh -lc 'git diff HEAD~1 HEAD'", 'completed', '+export const answer = 41;\\n', 0);
  say({ type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: process.env.FAKE_CODEX_REVIEW } });
  say({ type: 'turn.completed', usage: { input_tokens: 12000, cached_input_tokens: 8000, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100 } });
  fs.writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_CODEX_REVIEW);
};
const gate = process.env.FAKE_CODEX_GATE;
if (gate) {
  const t = setInterval(() => fs.existsSync(gate) && (clearInterval(t), answer()), 20);
} else setTimeout(answer, Number(process.env.FAKE_CODEX_SLEEP || 0));
`,
  );
  chmodSync(codex, 0o755);

  // A stand-in for Claude Code: `claude -p` answering with FAKE_CLAUDE_REVIEW and what the run
  // cost, after FAKE_CLAUDE_SLEEP milliseconds or once the file FAKE_CLAUDE_GATE exists; with
  // FAKE_CLAUDE_FAIL, the error result Claude Code gives. Every server in this file uses it. As
  // `--output-format stream-json` does, it prints its messages first: it reads math.js (by its
  // full path) and says something before it waits, and gives its answer with StructuredOutput.
  const claude = join(dir, 'claude');
  process.env.GALLEY_CLAUDE = claude;
  process.env.FAKE_CLAUDE_LOG = join(dir, 'claude.log');
  writeFileSync(
    claude,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] !== '-p') process.exit(2);
const prompt = fs.readFileSync(0, 'utf8');
const env = process.env;
fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), sawFile: fs.existsSync('claude.js'), tmpdir: env.TMPDIR, claudeTmpdir: env.CLAUDE_CODE_TMPDIR, claudeTmpdirExists: fs.existsSync(env.CLAUDE_CODE_TMPDIR), session: env.CLAUDECODE ?? env.CLAUDE_CODE_SESSION_ID ?? null }) + '\\n');
// As a test run can (Go's module cache): a read-only directory with a file in it.
fs.mkdirSync(env.CLAUDE_CODE_TMPDIR + '/mod/cache', { recursive: true });
fs.writeFileSync(env.CLAUDE_CODE_TMPDIR + '/mod/cache/file', 'x');
fs.chmodSync(env.CLAUDE_CODE_TMPDIR + '/mod/cache', 0o555);
fs.chmodSync(env.CLAUDE_CODE_TMPDIR + '/mod', 0o555);
const say = (e) => console.log(JSON.stringify({ ...e, parent_tool_use_id: null, session_id: 'session-1' }));
const usage = (output_tokens) => ({ input_tokens: 2, cache_creation_input_tokens: 7000, cache_read_input_tokens: 0, output_tokens });
say({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Bash', 'Glob', 'Grep', 'Read', 'StructuredOutput'], model: 'claude-haiku-5-5' });
say({ type: 'assistant', message: { id: 'msg_1', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: process.cwd() + '/math.js', offset: 2 } }], usage: usage(20) } });
say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '2\\t  return a + b;' }] } });
say({ type: 'assistant', message: { id: 'msg_2', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text: 'The answer is off by one.' }], usage: usage(10) } });
if (env.FAKE_CLAUDE_FAIL) {
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded', num_turns: 2, total_cost_usd: 0.004, usage: { input_tokens: 5, output_tokens: 300 } }));
  process.exit(1);
}
const answer = () => console.log(
  JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_3', model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'StructuredOutput', input: JSON.parse(env.FAKE_CLAUDE_REVIEW) }], usage: usage(200) } }) + '\\n' +
  JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Structured output provided successfully' }] } }) + '\\n' +
  JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 7, duration_ms: 4200, total_cost_usd: 0.0123,
  usage: { input_tokens: 12, cache_creation_input_tokens: 15000, cache_read_input_tokens: 30000, output_tokens: 2100 },
  modelUsage: { 'claude-haiku-5-5': { costUSD: 0.0123 } },
  structured_output: JSON.parse(env.FAKE_CLAUDE_REVIEW),
}));
const gate = env.FAKE_CLAUDE_GATE;
if (gate) {
  const t = setInterval(() => fs.existsSync(gate) && (clearInterval(t), answer()), 20);
} else setTimeout(answer, Number(env.FAKE_CLAUDE_SLEEP || 0));
`,
  );
  chmodSync(claude, 0o755);
  // A stand-in for sandbox-exec, which installs dependencies for Claude: it logs and runs nothing.
  const sandboxExec = join(dir, 'sandbox-exec');
  process.env.FAKE_SANDBOX_LOG = join(dir, 'sandbox-exec.log');
  writeFileSync(
    sandboxExec,
    `#!${process.execPath}
require('fs').appendFileSync(process.env.FAKE_SANDBOX_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), store: process.env.npm_config_store_dir }) + '\\n');
console.log('Packages: +1\\nDone in 1s');
`,
  );
  chmodSync(sandboxExec, 0o755);
  // Tests ask GitHub and fetch base branches themselves (followGithub, page loads, publishing), so its
  // timer does not run in between; it has a test of its own.
  server = await startServer({ port: 0, dataDir: join(dir, 'data'), ghBin: gh, codexBin: codex, claudeBin: claude, sandboxExec, reviewersDir: join(dir, 'reviewers'), viewerLogin: 'reviewer', pollMs: 50, followMs: 60 * 60_000 });
  startingFakes = fakes();
});

// A test leaves no review running or about to start on the shared server, where it would answer
// with the fakes of the tests after it, and leaves the fakes as it found them. Checked after each
// test, not each step: a step may leave a review or a fake to the next.
afterEach((t) => {
  if (t.fullName !== t.name) return;
  const pulls = server.service.db.all<PullRow>('SELECT * FROM pulls');
  const atWork = server.service.reviewerAgents().flatMap((r) => pulls.filter((p) => r.atWork(p)).map((p) => `${r.key} on s#${p.number}`));
  const left = fakes();
  restoreFakes(startingFakes);
  assert.deepEqual(atWork, [], 'reviews still running or about to start');
  assert.deepEqual(left, startingFakes, 'FAKE_* variables the test changed');
});

after(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test('the agent loop, from staging to publishing', async (t) => {
  await t.test('pr create stages the current branch', async () => {
    const r = await cli(['pr', 'create', '--title', 'Add multiplication', '--body-file', '-'], { input: 'Adds `mul`.' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), `${server.url}/acme/widgets/pull/1`);
    const again = await cli(['pr', 'create', '--fill']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already exists/);
  });

  await t.test('pr create without a title fails like gh does when not interactive', async () => {
    const r = await cli(['pr', 'create']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /must provide `--title`/);
  });

  await t.test('pr view --json and --jq', async () => {
    const r = await cli(['pr', 'view', '--json', 'number,title,state,author,headRefName,isDraft']);
    assert.deepEqual(JSON.parse(r.stdout), { number: 1, title: 'Add multiplication', state: 'STAGED', author: { login: 'agent', is_bot: true }, headRefName: 'feature/mul', isDraft: false });
    const jq = await cli(['pr', 'view', '1', '--json', 'commits', '--jq', '.commits[].messageHeadline']);
    assert.equal(jq.code, 0, jq.stderr);
    assert.equal(jq.stdout.trim(), 'Add mul');
    const list = await cli(['pr', 'list']);
    assert.match(list.stdout, /^s#1\tAdd multiplication\tfeature\/mul\tSTAGED\t/);
  });

  await t.test('a staged pull request is s#1: the CLI takes s1, s#1 and, as gh, 1 and #1, and its page is at /pull/s1 too', async () => {
    for (const arg of ['s1', 's#1', 'S1', '1', '#1', `${server.url}/acme/widgets/pull/s1`, `${server.url}/acme/widgets/pull/1/files`]) {
      const r = await cli(['pr', 'view', arg, '--json', 'number,ref']);
      assert.equal(r.code, 0, `${arg}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), { number: 1, ref: 's1' }, arg);
    }
    assert.match((await cli(['pr', 'view', '1'])).stdout, /^number:\ts#1$/m);
    const res = await fetch(`${server.url}/acme/widgets/pull/s1/files?diff=split`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/acme/widgets/pull/1/files?diff=split');
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /<title>Add multiplication by agent · Pull Request s#1 · acme\/widgets<\/title>/);
    assert.match(page, /<span class="gh-header-number">s#1<\/span>/);
  });

  await t.test('pr wait says when the reviewer agents are done with a commit, once', async () => {
    // Codex is off in settings, so no reviewer agent reviews it: the reviewer's turn at once. The
    // API tells it apart from feedback, and says it again until the author confirms it.
    const earlier: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls/1/wait?timeout=5`, { headers: { 'x-galley-actor': 'agent' } });
      const body = await res.json();
      assert.deepEqual([body.status, body.reviews, body.comments, body.agents_done], ['agents_done', [], [], { sha: git('rev-parse', 'HEAD'), reviewers: [] }]);
      earlier.push(body.seen_at);
    }
    const r = await cli(['pr', 'wait', '--timeout', '20s']);
    assert.equal(r.code, 0, r.stderr);
    const sha = git('rev-parse', '--short=7', 'HEAD');
    assert.equal(r.stdout, `No reviewer agent reviews ${sha}; ask the user to review it: ${server.url}/acme/widgets/pull/1\nThen run \`galley pr wait s1\` to wait for the review.\n`);
    // A confirmation that arrives late, from an earlier wait about an earlier commit (overlapping
    // waits, a retry), does not take back the newer one.
    const late = await fetch(`${server.url}/api/repos/acme/widgets/pulls/1/seen`, {
      method: 'PUT',
      headers: { 'x-galley-actor': 'agent', 'content-type': 'application/json' },
      body: JSON.stringify({ at: earlier[0], agents_done: git('rev-parse', 'main') }),
    });
    assert.equal(late.status, 204);
    // Once per commit: the next wait waits for the reviewer.
    assert.equal((await cli(['pr', 'wait', '--timeout', '1s'])).code, 124);
  });

  await t.test('pr wait returns the review the reviewer submits', async () => {
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    // Wait until the server sees the agent waiting, as the UI would show it.
    await until(async () => (await human('GET', '/api/repos/acme/widgets/pulls/1')).author_waiting, 'the server sees the agent waiting');
    await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', {
      event: 'REQUEST_CHANGES',
      body: 'Almost.',
      comments: [{ path: 'math.js', line: 6, side: 'RIGHT', body: 'Add a doc comment.', priority: 'high' }],
    });
    const r = await waiting;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /reviewer reviewed: changes requested/);
    assert.match(r.stdout, /thread \d+ on math\.js:6 \[unresolved\] \(high priority\)/);
    // The priority is the thread's: it shows once, at the right end of the thread's header.
    const files = await (await fetch(`${server.url}/acme/widgets/pull/1/files`)).text();
    assert.match(files, /<summary class="review-thread-header">[^]*?<span class="Label Label--priority Label--priority-high" title="Priority">High<\/span>\s*<span class="review-thread-toggle">[^]*?<\/summary>/);
    assert.equal(files.match(/Label--priority-high/g)?.length, 1);
    assert.match(r.stdout, /Add a doc comment\./);
    // Seen feedback is not returned twice.
    const again = await cli(['pr', 'wait', '--timeout', '1s']);
    assert.equal(again.code, 124);
  });

  await t.test('an approval without text still reaches the agent', async () => {
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await new Promise((r) => setTimeout(r, 300));
    const review = await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', { event: 'APPROVE' });
    const r = await waiting;
    assert.match(r.stdout, /reviewer reviewed: approved/);
    // Put the decision back to "changes requested" for the tests that follow.
    await human('POST', '/api/repos/acme/widgets/pulls/1/reviews', { event: 'REQUEST_CHANGES', body: 'Actually, not yet.' });
    await cli(['pr', 'view', '--comments']);
    assert.ok(review.id);
  });

  await t.test('threads follow their lines when the agent rewrites history', async () => {
    writeFileSync(join(repo, 'math.js'), '// math\n\nexport function add(a, b) {\n  return a + b;\n}\n\n/** Multiply. */\nexport function mul(a, b) {\n  return a * b;\n}\n');
    git('commit', '-q', '--amend', '-am', 'Add mul');
    const r = await cli(['pr', 'view', '--json', 'reviewThreads,headRefOid']);
    const { reviewThreads, headRefOid } = JSON.parse(r.stdout);
    assert.equal(headRefOid, git('rev-parse', 'HEAD'));
    assert.equal(reviewThreads[0].line, 9);
    assert.equal(reviewThreads[0].originalLine, 6);
    assert.equal(reviewThreads[0].isOutdated, false);
    // The old head is kept reachable for the revision history.
    const pins = git('for-each-ref', '--format=%(refname)', `refs/galley/${server.service.db.instance}/pull/1/`);
    assert.deepEqual(pins.split('\n'), [1, 2].map((seq) => `refs/galley/${server.service.db.instance}/pull/1/${seq}`));
    const timeline = await human('GET', '/api/repos/acme/widgets/issues/1/timeline');
    assert.ok(timeline.some((e: any) => e.event === 'pushed' && e.forced === true));
  });

  await t.test('a range comment is outdated when a line inside it changes', async () => {
    const review = await human('POST', '/api/repos/acme/widgets/pulls/1/comments', { path: 'math.js', start_line: 8, line: 10, side: 'RIGHT', body: 'Range.' });
    writeFileSync(join(repo, 'math.js'), '// math\n\nexport function add(a, b) {\n  return a + b;\n}\n\n/** Multiply. */\nexport function mul(a, b) {\n  return b * a;\n}\n');
    git('commit', '-q', '--amend', '-am', 'Add mul');
    const threads = JSON.parse((await cli(['pr', 'view', '--json', 'reviewThreads'])).stdout).reviewThreads;
    const range = threads.find((th: any) => th.databaseId === review.id);
    assert.equal(range.isOutdated, true);
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page.match(new RegExp(`id="thread-${review.id}"[^]*?</summary>`))![0], /<span class="review-thread-range">L8–10<\/span>/);
    // Seen by the agent so it does not show up in the next wait.
    await cli(['pr', 'view', '--comments']);
  });

  await t.test('pending review comments stay private', async () => {
    const pending = await human('POST', '/api/repos/acme/widgets/pulls/1/pending-comments', { path: 'math.js', line: 9, body: 'Draft thought.' });
    const asAgent = await cli(['api', `repos/{owner}/{repo}/pulls/comments/${pending.id}`]);
    assert.equal(asAgent.code, 1);
    const reply = await cli(['pr', 'comment', '--reply-to', String(pending.id), '-b', 'Sneaky.']);
    assert.equal(reply.code, 1);
    const reviews = await human('GET', '/api/repos/acme/widgets/pulls/1/reviews');
    const review = reviews.find((r: any) => r.state === 'PENDING').id;
    // The Commits tab tells its comment forms (public/app.js, from #main) to add to the pending review.
    const commits = async () => (await (await fetch(`${server.url}/acme/widgets/pull/1/commits`)).text()).match(/<div id="main"[^>]*>/)![0];
    assert.match(await commits(), new RegExp(` data-pending-review="${review}"`));
    await human('DELETE', `/api/repos/acme/widgets/pulls/1/reviews/${review}`);
    assert.match(await commits(), / data-pending-review=""/);
  });

  await t.test('the agent replies to a thread and edits the pull request', async () => {
    const threads = JSON.parse((await cli(['pr', 'view', '--json', 'reviewThreads'])).stdout).reviewThreads;
    const id = threads[0].databaseId;
    const reply = await cli(['pr', 'comment', '--reply-to', String(id), '-b', 'Done.']);
    assert.equal(reply.code, 0, reply.stderr);
    const edit = await cli(['pr', 'edit', '--title', 'Add multiplication helper']);
    assert.equal(edit.code, 0, edit.stderr);
    const api = await cli(['api', 'repos/{owner}/{repo}/pulls/1/comments', '--jq', '.[] | "\\(.user.login): \\(.body)"']);
    assert.equal(api.code, 0, api.stderr);
    assert.equal(api.stdout, 'reviewer: Add a doc comment.\nreviewer: Range.\nagent: Done.\n');
    // The reply is feedback for nobody: it is the agent's own.
    const pr = await human('GET', '/api/repos/acme/widgets/pulls/1');
    assert.equal(pr.title, 'Add multiplication helper');
  });

  await t.test('api accepts gh-style fields', async () => {
    const r = await cli(['api', 'repos/{owner}/{repo}/issues/1/comments', '-f', 'body=From the API']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).user.login, 'agent');
    writeFileSync(join(dir, 'body.md'), "app.get('/repos/:owner/:repo') {owner}");
    const file = await cli(['api', 'repos/{owner}/{repo}/issues/1/comments', '-F', `body=@${join(dir, 'body.md')}`]);
    assert.equal(JSON.parse(file.stdout).body, "app.get('/repos/:owner/:repo') {owner}");
    const urgent = await cli(['api', 'repos/{owner}/{repo}/pulls/1/comments', '-f', 'body=x', '-f', 'path=math.js', '-F', 'line=9', '-f', 'priority=urgent']);
    assert.equal(urgent.code, 1);
    assert.match(urgent.stderr, /priority must be one of high, medium, low/);
    // Any reviewer that writes the priority into the text gets it moved into the field.
    const prefixed = await cli(['api', 'repos/{owner}/{repo}/pulls/1/comments', '-f', 'body=[P1] Fix this', '-f', 'path=math.js', '-F', 'line=9']);
    assert.equal(prefixed.code, 0, prefixed.stderr);
    assert.deepEqual((({ priority, body }) => ({ priority, body }))(JSON.parse(prefixed.stdout)), { priority: 'high', body: 'Fix this' });
    const missing = await cli(['api', 'repos/{owner}/{repo}/pulls/99']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /HTTP 404/);
  });

  await t.test('the publish button offers to sign, checked when git signs by default', async () => {
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /<input type="checkbox" name="sign" checked> Sign the commit as <strong>Reviewer<\/strong> &lt;reviewer@example\.com&gt;/);
  });

  await t.test('the agent resolves a thread it fixed in the same command as its reply', async () => {
    const r = await cli(['pr', 'comment', '--resolve', '-b', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--resolve needs --reply-to/);
    const open = JSON.parse((await cli(['pr', 'view', '--json', 'reviewThreads'])).stdout).reviewThreads.filter((th: any) => !th.isResolved);
    const target = open[0].databaseId;
    const fixed = await cli(['pr', 'comment', '--reply-to', String(target), '--resolve', '-b', 'Fixed in the last commit.']);
    assert.equal(fixed.code, 0, fixed.stderr);
    const after = JSON.parse((await cli(['pr', 'view', '--json', 'reviewThreads'])).stdout).reviewThreads.find((th: any) => th.databaseId === target);
    assert.equal(after.isResolved, true);
    assert.equal(after.comments.at(-1).body, 'Fixed in the last commit.');
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /Resolved by agent</);
    // The collapsed header shows the priority, not a "Resolved" label.
    const header = page.match(new RegExp(`id="thread-${target}"[^]*?</summary>`))![0];
    assert.match(header, /Label--priority-high/);
    assert.doesNotMatch(header, />Resolved</);
  });

  await t.test('agents cannot publish, and stale pages cannot publish', async () => {
    const r = await cli(['pr', 'publish']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /only the user can publish/);
    const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls/1/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected: 'deadbeef:0000' }),
    });
    assert.equal(res.status, 412);
  });

  await t.test('publishing pushes the reviewed commit and opens the pull request', async () => {
    await handedOver();
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await new Promise((r) => setTimeout(r, 300));
    const pr = await human('POST', '/api/repos/acme/widgets/pulls/1/publish', {});
    assert.equal(pr.published_url, 'https://github.com/acme/widgets/pull/7');
    assert.equal(pr.staging_state, 'published');
    // GitHub gets signed copies: same tree, message and author, the reviewer as committer.
    const remoteHead = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    assert.notEqual(remoteHead, git('rev-parse', 'HEAD'));
    const copy = execFileSync('git', ['--git-dir', remote, 'cat-file', 'commit', remoteHead], { encoding: 'utf8' });
    assert.match(copy, /^gpgsig -----BEGIN SSH SIGNATURE-----/m);
    assert.match(copy, /^author Dev <dev@example\.com> /m);
    assert.match(copy, /^committer Reviewer <reviewer@example\.com> /m);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${remoteHead}^{tree}`], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD^{tree}'));
    assert.equal(copy.slice(copy.indexOf('\n\n') + 2), git('cat-file', 'commit', 'HEAD').split('\n\n').slice(1).join('\n\n') + '\n');
    // The agent's branch is left alone.
    assert.doesNotMatch(git('cat-file', 'commit', 'HEAD'), /^gpgsig/m);
    const log = readFileSync(join(dir, 'gh.log'), 'utf8');
    assert.match(log, /^pr create --repo acme\/widgets --base main --head feature\/mul --title Add multiplication helper --body-file -$/m);
    assert.equal(readFileSync(join(dir, 'gh-stdin.log'), 'utf8'), 'Adds `mul`.');
    const r = await waiting;
    assert.match(r.stdout, /Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7/);
  });

  await t.test('publishing new commits signs only those and fast-forwards GitHub', async () => {
    const before = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    writeFileSync(join(repo, 'README.md'), '# widgets\n');
    git('add', 'README.md');
    git('commit', '-qm', 'Add a readme');
    await human('POST', '/api/repos/acme/widgets/pulls/1/publish', {});
    const after = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${after}^`], { encoding: 'utf8' }).trim(), before);
    // The signed copies are kept from garbage collection: the ref moves from the earlier ones.
    assert.equal(git('rev-parse', `refs/galley/${server.service.db.instance}/pull/1/published`), after);
    const timeline = await human('GET', '/api/repos/acme/widgets/issues/1/timeline');
    assert.equal(timeline.filter((e: any) => e.event === 'published').at(-1).signed, 1);
    // The signed copies count as the staged commits: nothing is left to publish.
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /GitHub has the same commits, title and description/);
  });

  await t.test('a rewritten branch needs force to publish again', async () => {
    git('commit', '-q', '--amend', '-m', 'Add mul', '-m', 'Reworded.');
    await assert.rejects(human('POST', '/api/repos/acme/widgets/pulls/1/publish', {}), /409|rejected|git push failed/);
    // A published ref at a commit galley did not sign is not its to move.
    const published = `refs/galley/${server.service.db.instance}/pull/1/published`;
    const unsigned = git('rev-parse', 'main');
    git('update-ref', published, unsigned);
    const errors = mock.method(console, 'error', () => {});
    try {
      await human('POST', '/api/repos/acme/widgets/pulls/1/publish', { force: true });
    } finally {
      errors.mock.restore();
    }
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr edit https:\/\/github\.com\/acme\/widgets\/pull\/7 --title/m);
    assert.equal(git('rev-parse', published), unsigned);
    const logged = errors.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(logged.some((line) => line.startsWith(`left ${published} alone in `) && line.endsWith(`it points at ${unsigned}, which galley did not sign`)), logged.join('\n'));
    git('update-ref', published, execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim());
  });

  await t.test('force-publishing never overwrites commits added on GitHub', async () => {
    // Someone commits on the published branch on GitHub ...
    const tip = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['--git-dir', remote, 'rev-parse', `${tip}^{tree}`], { encoding: 'utf8' }).trim();
    const theirs = execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-p', tip, '-m', 'Commit suggestion'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@example.com' },
    }).trim();
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/mul', theirs]);
    // ... while the agent rewrites history locally.
    git('commit', '-q', '--amend', '-m', 'Add mul', '-m', 'Reworded again.');
    await assert.rejects(human('POST', '/api/repos/acme/widgets/pulls/1/publish', { force: true }), /changed since it was last published/);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/mul'], { encoding: 'utf8' }).trim(), theirs);
  });

  await t.test('pr wait reports feedback that comes with a close', async () => {
    // The agent has seen everything so far (including the last publish).
    await cli(['pr', 'view', '--comments']);
    // Published, its wait pushes the rewritten history, which the commit added on GitHub refuses, once.
    assert.match((await cli(['pr', 'wait', '--timeout', '20s'])).stdout, /^Could not push [0-9a-f]{7} to GitHub: git push failed \(the branch on GitHub changed since it was last published/m);
    const waiting = cli(['pr', 'wait', '--timeout', '20s']);
    await new Promise((r) => setTimeout(r, 300));
    await human('POST', '/api/repos/acme/widgets/issues/1/comments', { body: 'Closing: we went another way.' });
    await human('PATCH', '/api/repos/acme/widgets/pulls/1', { state: 'closed' });
    const r = await waiting;
    assert.match(r.stdout, /Closing: we went another way\./);
    // A closed pull request does not leave the agent waiting forever.
    const again = await cli(['pr', 'wait', '--timeout', '5s']);
    assert.match(again.stdout, /closed .* without publishing/);
    await human('PATCH', '/api/repos/acme/widgets/pulls/1', { state: 'open' });
  });

  await t.test('the repository page links to the repository on GitHub', async () => {
    await server.service.refreshGithubRepo('acme/widgets');
    // Owner and name go as strings (-f): -F would make a repository called "123" a number.
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^api graphql -f query=.* -f owner=acme -f name=widgets$/m);
    const link = (slug: string) => new RegExp(`<h1 class="page-title">[^<]*</h1><a class="page-title-github" href="https://github\\.com/${slug}" target="_blank" rel="noopener" title="${slug} on GitHub"><svg class="octicon octicon-mark-github"[^]*?</svg> ${slug} <svg class="octicon octicon-link-external"`);
    assert.match(await (await fetch(`${server.url}/acme/widgets`)).text(), link('acme/widgets'));
    // No tabs for the repository under the header; the breadcrumbs lead back to its page.
    const { head } = await human('GET', '/api/repos/acme/widgets/pulls/1');
    for (const path of ['/acme/widgets', '/acme/widgets/pull/1', `/acme/widgets/tree/${head.sha}`]) {
      const page = await (await fetch(server.url + path)).text();
      assert.doesNotMatch(page, /UnderlineNav|github\.com\/acme\/widgets\/(pulls|issues)/, path);
      assert.match(page, /<nav class="app-header-context">[^]*?<a href="\/acme\/widgets"><strong>acme\/widgets<\/strong><\/a>/, path);
    }
    // Without a GitHub remote, no link; with one added later, it names the repository there, and
    // the repository takes its name.
    const elsewhere = join(dir, 'elsewhere');
    execFileSync('git', ['init', '-q', '-b', 'main', elsewhere]);
    execFileSync('git', ['-C', elsewhere, 'remote', 'add', 'origin', 'https://gitlab.com/acme/elsewhere.git']);
    const local = await human('POST', '/api/repos', { path: elsewhere });
    assert.doesNotMatch(await (await fetch(`${server.url}/${local.full_name}`)).text(), /page-title-github/);
    execFileSync('git', ['-C', elsewhere, 'remote', 'set-url', 'origin', 'https://github.com/acme/moved.git']);
    assert.equal((await human('POST', '/api/repos', { path: elsewhere })).full_name, 'acme/moved');
    assert.match(await (await fetch(`${server.url}/${local.full_name}`)).text(), link('acme/moved'));
  });

  await t.test('web pages render', async () => {
    // Published by now, it is on the Published tab.
    for (const path of ['/?state=published', '/acme/widgets?state=published', '/acme/widgets/pull/1', '/acme/widgets/pull/1/commits', '/acme/widgets/pull/1/files', '/acme/widgets/pull/1/files?diff=split']) {
      const res = await fetch(server.url + path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /Add multiplication helper/, path);
    }
    // Its number here, and where it is on GitHub.
    const page = await (await fetch(`${server.url}/acme/widgets/pull/1`)).text();
    assert.match(page, /<span class="gh-header-number">s#1 → <a href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">acme\/widgets#7<\/a><\/span>/);
  });

  await t.test('cross-site writes and foreign Host headers are refused', async () => {
    const cross = await fetch(server.url + '/api/repos/acme/widgets/pulls/1/publish', { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
  });
});

test('Markdown links issues, mentions and commits the way GitHub does', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/links');
  writeFileSync(join(repo, 'links.js'), 'export {};\n');
  git('add', 'links.js');
  git('commit', '-qm', 'First try');
  const replaced = git('rev-parse', 'HEAD');
  git('commit', '-q', '--amend', '-m', 'Add links.js');
  const own = git('rev-parse', 'HEAD');
  const pushed = git('rev-parse', 'origin/main');
  const body = `Fixes #12. Thanks @laat. Builds on ${pushed.slice(0, 7)}; ${own.slice(0, 7)} replaces ${replaced.slice(0, 7)}, not deadbeef. \`#13\``;
  const created = await cli(['pr', 'create', '--title', 'Links', '--body', body]);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const events: string[] = [];
  const listen = (e: { type: string }) => events.push(e.type);
  server.service.bus.on('change', listen);

  // "#12" is issue 12 on GitHub, not staged pull request 12; the page never waits for its title.
  const first = await page();
  assert.match(first, /Fixes <a class="issue-link" href="https:\/\/github\.com\/acme\/widgets\/issues\/12" target="_blank" rel="noopener noreferrer">#12<\/a>\./);
  assert.match(first, /<a class="user-mention" href="https:\/\/github\.com\/laat" target="_blank" rel="noopener noreferrer">@laat<\/a>/);
  assert.match(first, new RegExp(`<a class="commit-link" href="https://github\\.com/acme/widgets/commit/${pushed}" target="_blank" rel="noopener noreferrer"><code>${pushed.slice(0, 7)}</code></a>`));
  assert.match(first, new RegExp(`<a class="commit-link" href="/acme/widgets/pull/${number}/files\\?commit=${own}" title="Add links\\.js"><code>${own.slice(0, 7)}</code></a>`));
  assert.match(first, new RegExp(`replaces <a class="commit-link" href="/acme/widgets/pull/${number}/files\\?commit=${replaced}"><code>`));
  assert.match(first, /, not deadbeef\. <code>#13<\/code>/);
  // The publish box says what merging on GitHub closes (its title may have come in by the time the box renders).
  assert.match(first, /<strong>Merging on GitHub closes <a href="https:\/\/github\.com\/acme\/widgets\/issues\/12" target="_blank" rel="noopener"( title="[^"]*")?>#12<\/a><\/strong>/);

  // The title arrives in the background, and open pages hear about it.
  const titled = /<a class="issue-link" href="https:\/\/github\.com\/acme\/widgets\/issues\/12" title="Widgets wobble · Open issue"/;
  assert.doesNotMatch(first, titled);
  await until(async () => titled.test(await page()), 'the page has the title of issue 12');
  server.service.bus.off('change', listen);
  assert.ok(events.includes('github_issues'), 'a change event when titles arrive');
  assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^api graphql -f query=.*i12:issueOrPullRequest\(number:12\).* -f owner=acme -f name=widgets$/m);

  // The editor's preview links the same way when it says which pull request it is on.
  const preview = async (text: string, pull?: string) =>
    (await fetch(`${server.url}/api/markdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, pull }) })).text();
  const api = `/api/repos/acme/widgets/pulls/${number}`;
  assert.match(await preview(`Fixes #12 in ${own.slice(0, 7)}`, api), new RegExp(`Fixes <a class="issue-link" href="https://github\\.com/acme/widgets/issues/12" title="Widgets wobble · Open issue"[^>]*>#12</a> in <a class="commit-link" href="/acme/widgets/pull/${number}/files\\?commit=${own}"`));
  assert.equal(await preview(`Fixes #12 in ${own.slice(0, 7)}`), `<p>Fixes #12 in ${own.slice(0, 7)}</p>\n`);
  // It takes titles from the cache alone: the answer to a lookup would refresh the page under the preview.
  assert.match(await preview('See #77', api), /<a class="issue-link" href="https:\/\/github\.com\/acme\/widgets\/issues\/77"/);
  await new Promise((r) => setTimeout(r, 100));
  assert.doesNotMatch(readFileSync(join(dir, 'gh.log'), 'utf8'), /issueOrPullRequest\(number:77\)/);
  // s#N is a staged pull request here, with its title; one there is none of stays text.
  assert.match(await preview(`Follows s#${number} and s#999`, api), new RegExp(`Follows <a class="issue-link" href="/acme/widgets/pull/${number}" title="Links · staged">s#${number}</a> and s#999`));
});

test('codex-review reviews when the author waits, within the limits in settings', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/codex');
  writeFileSync(join(repo, 'codex.js'), 'export const answer = 41;\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git('add', 'codex.js', 'pnpm-lock.yaml');
  git('commit', '-qm', 'Add the answer');
  const created = await cli(['pr', 'create', '--title', 'Add the answer', '--body', 'It is 42.']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const review = {
    summary: 'Off by one.',
    comments: [
      // Models often write a one-line comment as start_line == line.
      { path: 'codex.js', line: 1, start_line: 1, side: 'RIGHT', priority: 'high', body: '```suggestion\nexport const answer = 42;\n```' },
      // The priority written into the text the way Codex likes to: it becomes the field.
      { path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: null, body: '[P2] Not in this diff.' },
    ],
  };
  await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    // Settings belong to the reviewer, and the effort has to suit the model.
    const asAgent = await cli(['api', '-X', 'PUT', 'settings/codex', '-F', 'enabled=true']);
    assert.equal(asAgent.code, 1);
    await assert.rejects(human('PUT', '/api/settings/codex', { model: 'gpt-test', effort: 'ultra' }), /does not support effort \\?"ultra"?/);
    await human('PUT', '/api/settings/codex', { enabled: true, model: 'gpt-test', effort: 'high', maxIterations: 1 });
    const settingsPage = await (await fetch(`${server.url}/settings`)).text();
    assert.match(settingsPage, /<option value="gpt-test"[^>]* selected>GPT Test/);
    assert.doesNotMatch(settingsPage, /internal/);
    assert.match(settingsPage, /<div class="Subhead" id="codex">/);
    assert.match(settingsPage, /<input type="checkbox" name="runTests" checked> Let Codex install dependencies and run tests/);

    // The agent waits; Codex reviews first and its review wakes the agent.
    const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /codex-review reviewed: commented/);
    assert.match(r.stdout, /Off by one\./);
    assert.match(r.stdout, /thread \d+ on codex\.js:1 \[unresolved\] \(high priority\)/);
    assert.match(r.stdout, /`math\.js:1` \(medium priority\): Not in this diff\./);
    const call = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.equal(call.args[call.args.indexOf('-m') + 1], 'gpt-test');
    assert.ok(call.args.includes('model_reasoning_effort="high"'));
    assert.match(call.prompt, /Title: Add the answer/);
    assert.equal(call.sawFile, true, 'codex runs in a checkout of the head commit');
    // By default galley installs the dependencies from the lockfile first, in Codex's sandbox with
    // network and without the repository's scripts. Then Codex may run the tests, without network,
    // writing only to the checkout and a temporary directory beside it, whatever the user's
    // config.toml says, and ignoring the checkout's own .codex/config.toml.
    const checkout = call.args[call.args.indexOf('-C') + 1];
    const workspaceWrite = (network: boolean) => [
      '-c',
      `sandbox_workspace_write.network_access=${network}`,
      '-c',
      'sandbox_workspace_write.writable_roots=[]',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
      '-c',
      'sandbox_workspace_write.exclude_tmpdir_env_var=false',
    ];
    const untrusted = ['-c', `projects={${JSON.stringify(checkout)}={trust_level="untrusted"}}`];
    const installs = () => readFileSync(process.env.FAKE_CODEX_SANDBOX_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(installs(), [
      {
        args: [
          'sandbox',
          '-c',
          'sandbox_mode="workspace-write"',
          ...workspaceWrite(true),
          ...untrusted,
          '--',
          'pnpm',
          'install',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--ignore-pnpmfile',
          '--config.manage-package-manager-versions=false',
        ],
        cwd: checkout,
        store: join(dirname(checkout), 'tmp', 'pnpm-store'),
      },
    ]);
    assert.deepEqual(call.args.slice(call.args.indexOf('-s'), call.args.indexOf('-C')), ['-s', 'workspace-write', ...workspaceWrite(false), ...untrusted]);
    assert.equal(call.tmpdir, join(dirname(checkout), 'tmp'));
    assert.equal(call.npmCache, join(call.tmpdir, 'npm'));
    assert.match(call.prompt, /galley installed the dependencies with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile [^`]*`, which runs no install scripts/);
    assert.match(call.prompt, /\n    Packages: \+3\n    Done in 1s\n/);
    // Its sandbox can not let the tests serve on localhost without opening more (README).
    assert.match(call.prompt, /you may run the typecheck, tests or build/);
    assert.match(call.prompt, /There is no network, so you can not install anything/);
    assert.match(call.prompt, /changes you make to it are lost/);
    assert.doesNotMatch(call.prompt, /Do not modify any files/);
    // Removed afterwards, read-only directories and all. The review is posted before the cleanup finishes.
    await server.service.codex!.settle((await human('GET', base)).id);
    assert.equal(existsSync(dirname(checkout)), false);
    assert.doesNotMatch(git('worktree', 'list'), /galley-review-/);

    // The cap: after one automatic review, a new commit and another wait start nothing. The
    // reviewer agents are done with it, and the wait says so.
    writeFileSync(join(repo, 'codex.js'), 'export const answer = 42;\n');
    git('commit', '-qam', 'Fix the answer');
    const capped = await cli(['pr', 'wait', String(number), '--timeout', '2s']);
    assert.equal(capped.code, 0, capped.stderr);
    assert.match(capped.stdout, new RegExp(`^The reviewer agents are done with ${git('rev-parse', '--short=7', 'HEAD')} \\(codex-review used 1 of 1 automatic reviews\\); ask the user to review it: `));

    // Raising this pull request's limit lets Codex go on, at once when the author is waiting.
    assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(), /data-limit="1"[^]*js-codex-step[^]*js-codex-step/);
    // This time the install fails; Codex reviews anyway and is told why.
    const second = await withFakes({ FAKE_INSTALL_FAIL: '1' }, async () => {
      const resumed = cli(['pr', 'wait', String(number), '--timeout', '20s']);
      await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
      const selfRaise = await cli(['api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${number}/reviewers/codex`, '-F', 'max_iterations=9']);
      assert.equal(selfRaise.code, 1, 'agents cannot raise their own limit');
      assert.deepEqual(await human('PATCH', `${base}/reviewers/codex`, { max_iterations: '2' }), { enabled: true, max_iterations: 2, overrides: { enabled: null, max_iterations: 2 } });
      return resumed;
    });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /automatic review 2 of 2/);
    const failedInstall = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.match(failedInstall.prompt, /galley could not install the dependencies: `pnpm install [^`]*` exited with 1\. Its output ended with:\n\n    ERR_PNPM_OUTDATED_LOCKFILE\n/);

    // Asking from the page ignores the cap, and a failed run keeps its error. With running the
    // tests turned off, Codex gets today's read-only sandbox and is told not to modify files.
    await human('PUT', '/api/settings/codex', { runTests: false });
    // In the Codex section, which comes before Claude's.
    assert.doesNotMatch((await (await fetch(`${server.url}/settings`)).text()).split('id="claude"')[0], /name="runTests" checked/);
    const pull = await human('GET', base);
    await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
      await human('POST', `${base}/reviewers/codex`);
      await server.service.codex!.settle(pull.id);
    });
    const readOnly = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.deepEqual(readOnly.args.slice(readOnly.args.indexOf('-s'), readOnly.args.indexOf('-C')), [
      '-s',
      'read-only',
      '-c',
      `projects={${JSON.stringify(readOnly.args[readOnly.args.indexOf('-C') + 1])}={trust_level="untrusted"}}`,
    ]);
    assert.equal(installs().length, 2, 'nothing is installed for a read-only review');
    assert.equal(readOnly.tmpdir, process.env.TMPDIR);
    assert.match(readOnly.prompt, /Do not modify any files\./);
    assert.doesNotMatch(readOnly.prompt, /install the dependencies/);
    await human('PUT', '/api/settings/codex', { runTests: true });
    const { runs } = await human('GET', `${base}/reviewers/codex`);
    assert.deepEqual(runs.map((x: any) => [x.trigger, x.status]), [['auto', 'done'], ['auto', 'done'], ['manual', 'failed']]);
    assert.match(runs[2].error, /model overloaded/);
    const page = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
    assert.match(page, /failed/);
    assert.match(page, /<span class="agent-chunk">Automatic: 2 of 2<\/span>/);
    assert.match(page, /class="codex-limit" data-api="[^"]*\/reviewers\/codex" data-limit="2"/);
    assert.match(page, /js-codex-reset"[^>]* data-field="max_iterations"/);
    assert.doesNotMatch(page, /for this pull request/, 'following the setting, as without --reviewer');
    assert.deepEqual(await human('PATCH', `${base}/reviewers/codex`, { max_iterations: null }), { enabled: true, max_iterations: 1, overrides: { enabled: null, max_iterations: null } });

    // The reviewer is one identity: renaming it carries its earlier reviews along.
    await human('PUT', '/api/settings/codex', { name: 'codex-bot' });
    const reviews = await human('GET', `${base}/reviews`);
    assert.deepEqual([...new Set(reviews.map((rv: any) => rv.user.login))], ['codex-bot']);
    await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Looks right.' });
    const renamed = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
    assert.equal(renamed.match(/<span class="flex-auto">codex-bot<\/span>/g)?.length, 1, 'under Reviewers');
    assert.doesNotMatch(renamed, /<span class="flex-auto">codex<\/span>/);
    // Its name goes to its settings, under the new name too; a person's name does not.
    assert.match(renamed, /<a class="agent-name" href="\/settings#codex" title="Settings for codex-bot">codex-bot<\/a>/);
    assert.match(renamed, /<a class="author" href="\/settings#codex" title="Settings for codex-bot">codex-bot<\/a><span class="Label Label--bot">bot<\/span> reviewed/);
    assert.match(renamed, /<a class="author" href="#" title="reviewer">reviewer<\/a> commented/);
    // A name someone else uses is refused, and nobody can post as the reviewer.
    await assert.rejects(human('PUT', '/api/settings/codex', { name: 'agent' }), /already used by someone else/);
    const impostor = await cli(['pr', 'comment', String(number), '-b', 'hi'], { actor: 'codex-bot' });
    assert.equal(impostor.code, 1);
    assert.match(impostor.stderr, /is the name of the Codex reviewer/);
    await human('PUT', '/api/settings/codex', { name: 'codex-review' });

    // A pull request written by an agent running in Codex (the CLI calls it "codex-agent") is
    // reviewed too, and the review reaches that agent's wait.
    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'feature/by-codex');
    writeFileSync(join(repo, 'by-codex.js'), 'export {};\n');
    git('add', 'by-codex.js');
    git('commit', '-qm', 'Written in Codex');
    const byCodex = await cli(['pr', 'create', '--title', 'Written in Codex', '--body', 'x'], { actor: 'codex-agent' });
    assert.equal(byCodex.code, 0, byCodex.stderr);
    const waited = await cli(['pr', 'wait', byCodex.stdout.trim().split('/').pop()!, '--timeout', '20s'], { actor: 'codex-agent' });
    assert.equal(waited.code, 0, waited.stderr);
    assert.match(waited.stdout, /codex-review reviewed: commented/);
    // Without a lockfile nothing is installed, and Codex is told so.
    const noLockfile = JSON.parse(readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.match(noLockfile.prompt, /No dependencies are installed: the repository root has no lockfile/);
    assert.equal(installs().length, 2);
    await human('PUT', '/api/settings/codex', { enabled: false });
  });
});

test('claude reviews when the author waits, in its own sandbox, and says what it cost', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/claude');
  writeFileSync(join(repo, 'claude.js'), 'export const answer = 41;\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  git('add', 'claude.js', 'pnpm-lock.yaml');
  git('commit', '-qm', 'Add the answer for Claude');
  const created = await cli(['pr', 'create', '--title', 'Add the answer', '--body', 'It is 42.']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const lastCall = () => JSON.parse(readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n').at(-1)!);
  const review = { summary: 'Off by one.', comments: [{ path: 'claude.js', line: 1, start_line: null, side: 'RIGHT', priority: 'high', body: 'It should be 42.' }] };
  await withFakes({ FAKE_CLAUDE_REVIEW: JSON.stringify(review) }, async () => {
    // Its section of the settings is next to Codex's, with the same settings.
    await assert.rejects(human('PUT', '/api/settings/claude', { model: 'haiku', effort: 'extreme' }), /does not support effort \\?"extreme"?/);
    await human('PUT', '/api/settings/claude', { enabled: true, model: 'haiku', effort: 'low', maxIterations: 2 });
    const settingsPage = await (await fetch(`${server.url}/settings`)).text();
    assert.match(settingsPage, /<div class="Subhead" id="claude">/);
    assert.match(settingsPage, /posts its findings as a review from <strong>claude-review<\/strong>/);
    assert.match(settingsPage, /<option value="haiku"[^>]* selected>Haiku/);
    assert.match(settingsPage, /<input type="checkbox" name="skipOwnKind"> Skip pull requests by agents in Claude Code/);
    assert.match(settingsPage, /<input type="checkbox" name="skipOwnKind"> Skip pull requests by agents in Codex/);
    // Letting its tests listen on localhost is a setting of Claude's alone, off by default, and says
    // what it opens. Codex's sandbox can not do it without letting the tests connect to other hosts.
    assert.equal((await human('GET', '/api/settings')).claude.localhost, false);
    assert.match(settingsPage, /<input type="checkbox" name="localhost"> Let Claude's tests listen on localhost/);
    assert.match(settingsPage, /Code in the pull request can then reach anything on localhost, including galley, which takes any local caller for you and could publish as you/);
    assert.match(settingsPage, /other machines on your network can reach a server that does not listen on 127\.0\.0\.1 only/);
    assert.doesNotMatch(settingsPage.split('id="claude"')[0], /name="localhost"/);
    await assert.rejects(human('PUT', '/api/settings/codex', { localhost: true }), /Codex's sandbox can not let its tests listen on localhost/);

    const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /claude-review reviewed: commented/);
    assert.match(r.stdout, /Off by one\./);
    assert.match(r.stdout, /thread \d+ on claude\.js:1 \[unresolved\] \(high priority\)/);

    // Claude Code headless in a checkout of the head, with the user's own login (no --bare), the
    // prompt on stdin and the answer in the schema, as the reviewer bot asked for.
    const call = lastCall();
    const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
    assert.equal(call.sawFile, true, 'claude runs in a checkout of the head commit');
    assert.match(call.prompt, /Title: Add the answer/);
    assert.equal(flag('--model'), 'haiku');
    assert.equal(flag('--effort'), 'low');
    assert.equal(flag('--output-format'), 'stream-json');
    assert.ok(call.args.includes('--verbose'), 'stream-json needs --verbose');
    assert.deepEqual(JSON.parse(flag('--json-schema')).required, ['summary', 'comments']);
    // The checkout is untrusted: none of its settings (hooks), MCP servers, CLAUDE.md, skills or agents.
    for (const f of ['--restricted', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(call.args.includes(f), f);
    assert.equal(flag('--disallowedTools'), 'mcp__*');
    assert.ok(!call.args.includes('--bare'));
    // Tools for reading and for running commands, with nobody to ask: what is not allowed is denied.
    assert.equal(flag('--tools'), 'Read,Grep,Glob,Bash');
    assert.deepEqual(call.args.slice(call.args.indexOf('--allowedTools') + 1, call.args.indexOf('--disallowedTools')), ['Read', 'Grep', 'Glob']);
    assert.equal(flag('--permission-mode'), 'dontAsk');
    assert.equal(flag('--permission-prompts'), 'none');
    // Commands run in Claude Code's sandbox, never outside it: no network (not even localhost, by
    // default), writes to the checkout, Claude Code's own temporary directory and the review's, and
    // not to the user's repository (nor to /tmp/claude-<uid>, where the user's own Claude Code
    // sessions keep theirs).
    const checkout = call.cwd;
    const tmp = join(dirname(checkout), 'tmp');
    const uid = process.getuid!();
    const { git_dir } = await human('GET', '/api/repos/acme/widgets');
    assert.deepEqual(JSON.parse(flag('--settings')), {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: [],
        network: { allowedDomains: [], deniedDomains: ['*'], strictAllowlist: true, allowLocalBinding: false },
        filesystem: { allowWrite: [tmp], denyWrite: [join(checkout, '.git'), git_dir, `/tmp/claude-${uid}`, `/private/tmp/claude-${uid}`] },
      },
    });
    assert.equal(call.tmpdir, tmp);
    // Short, or Claude Code falls back to /tmp/claude-<uid>. Where /tmp is not writable, it is under
    // $TMPDIR, which may be longer.
    if (slashTmpWritable()) assert.ok(Buffer.byteLength(`${call.claudeTmpdir}/claude-${uid}`) <= 30, call.claudeTmpdir);
    else t.diagnostic(`not checking that ${call.claudeTmpdir} is short: /tmp is not writable here (in a reviewer agent's sandbox?), so it is under $TMPDIR`);
    assert.equal(call.claudeTmpdirExists, true);
    assert.equal(existsSync(call.claudeTmpdir), false, 'removed after the review');
    assert.equal(call.session, null, 'not taken for part of a Claude Code session the server was started from');
    // The dependencies were installed first, in galley's own sandbox: network, and writes only to the checkout and the review's TMPDIR.
    const install = JSON.parse(readFileSync(process.env.FAKE_SANDBOX_LOG!, 'utf8').trim().split('\n').at(-1)!);
    assert.match(install.args[1], /^\(version 1\)\n\(deny default\)/);
    assert.deepEqual(install.args.slice(2), [
      `-DWRITABLE_0=${checkout}`,
      `-DWRITABLE_1=${tmp}`,
      `-DREAD_ONLY_0=${join(checkout, '.git')}`,
      'pnpm',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--ignore-pnpmfile',
      '--config.manage-package-manager-versions=false',
    ]);
    assert.equal(install.cwd, checkout);
    assert.equal(install.store, join(tmp, 'pnpm-store'));
    assert.match(call.prompt, /galley installed the dependencies with `pnpm install [^`]*`[^]*\n    Packages: \+1\n/);
    assert.match(call.prompt, /There is no network, so you can not install anything/);
    assert.doesNotMatch(call.prompt, /localhost/);

    // The review is Claude's, and the run says what it cost, in the API and in the sidebar.
    const { runs } = await human('GET', `${base}/reviewers/claude`);
    assert.deepEqual(
      runs.map((x: any) => [x.trigger, x.status, x.findings, x.model, x.effort]),
      [['auto', 'done', 1, 'haiku', 'low']],
    );
    assert.deepEqual(runs[0].usage, {
      cost_usd: 0.0123,
      input_tokens: 12,
      cache_creation_input_tokens: 15000,
      cache_read_input_tokens: 30000,
      output_tokens: 2100,
      turns: 7,
      duration_ms: 4200,
      models: ['claude-haiku-5-5'],
    });
    assert.match((await human('GET', `${base}/reviews`)).at(-1).body, /<sub>Claude \(haiku, low effort\) reviewed `[0-9a-f]{7}`, automatic review 1 of 2\.<\/sub>$/);
    let html = await page();
    assert.match(html, /<a class="agent-name" href="\/settings#claude" title="Settings for claude-review">claude-review<\/a>/);
    // What its runs cost, and the latest in detail on hover.
    assert.match(html, /<span class="agent-chunk"><span title="Last run: \$0\.01 · 45k tokens in, 2k out · 7 turns\n[^"]*">\$0\.01<\/span><\/span>/);
    assert.match(html, /Ask Claude to review/);
    // Its transcript: the file it read by its full path, linked as the repository's own at the
    // reviewed commit, what it said, and its answer.
    const transcript = await (await fetch(`${server.url}/acme/widgets/pull/${number}/runs/${runs[0].id}`)).text();
    assert.match(transcript, new RegExp(`Read <a class="run-location" href="/acme/widgets/blob/${runs[0].head_sha}/math\\.js#L2"><code>math\\.js:2</code></a>`));
    assert.match(transcript, /The answer is off by one\./);
    assert.match(transcript, /&quot;summary&quot;: &quot;Off by one\.&quot;/);
    assert.match(transcript, /2 steps · \$0\.01 · 45k tokens in, 2k out · 7 turns/);
    // The first step was galley's: installing the dependencies.
    assert.match(transcript, /<code class="run-command">pnpm install --frozen-lockfile [^<]*<\/code><\/span> <svg[^>]*octicon-check[^]*?Packages: \+1/);

    // Without running the tests, it reads: Read, Grep, Glob and read-only git, with the checkout
    // read-only too, and nothing installed. Nothing listens on localhost, whatever that setting says.
    // A failed run keeps Claude Code's error.
    const installs = readFileSync(process.env.FAKE_SANDBOX_LOG!, 'utf8').trim().split('\n').length;
    await human('PUT', '/api/settings/claude', { runTests: false, localhost: true });
    const pull = await human('GET', base);
    await withFakes({ FAKE_CLAUDE_FAIL: '1' }, async () => {
      await human('POST', `${base}/reviewers/claude`);
      await server.service.claude!.settle(pull.id);
    });
    const readOnly = lastCall();
    const readOnlyFlag = (name: string) => readOnly.args[readOnly.args.indexOf(name) + 1];
    const allowed = readOnly.args.slice(readOnly.args.indexOf('--allowedTools') + 1, readOnly.args.indexOf('--disallowedTools'));
    assert.deepEqual(allowed.slice(0, 5), ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)']);
    assert.ok(allowed.every((t: string) => !t.startsWith('Bash') || t.startsWith('Bash(git ')));
    const { sandbox } = JSON.parse(readOnlyFlag('--settings'));
    assert.equal(sandbox.autoAllowBashIfSandboxed, false);
    assert.deepEqual(sandbox.filesystem.allowWrite, []);
    assert.ok(sandbox.filesystem.denyWrite.includes(readOnly.cwd));
    assert.equal(sandbox.network.allowLocalBinding, false);
    assert.match(readOnly.prompt, /Do not modify any files\./);
    assert.equal(readFileSync(process.env.FAKE_SANDBOX_LOG!, 'utf8').trim().split('\n').length, installs, 'nothing is installed for a read-only review');
    await human('PUT', '/api/settings/claude', { runTests: true });
    const failed = (await human('GET', `${base}/reviewers/claude`)).runs.at(-1);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /^claude stopped \(error_during_execution\):\nAPI Error: 529 overloaded$/);
    // What it cost before it failed counts too.
    assert.equal(failed.usage.cost_usd, 0.004);
    assert.equal(failed.usage.output_tokens, 300);
    assert.match(await page(), /<span title="2 runs: \$0\.02\nLast run: \$0\.0040 · 5 tokens in, 300 out · 2 turns\n[^"]*">\$0\.02<\/span>/);

    // With the tests and localhost on, the tests may start servers there, and Claude is told so.
    // They still can not connect to other hosts.
    await human('POST', `${base}/reviewers/claude`);
    await server.service.claude!.settle(pull.id);
    const serving = lastCall();
    assert.deepEqual(JSON.parse(serving.args[serving.args.indexOf('--settings') + 1]).sandbox.network, {
      allowedDomains: [],
      deniedDomains: ['*'],
      strictAllowlist: true,
      allowLocalBinding: true,
    });
    assert.match(serving.prompt, /you may run the typecheck, the whole test suite \(tests that start servers on localhost included\) or the build/);
    assert.match(serving.prompt, /There is no network beyond localhost, so you can not install anything/);
    await human('PUT', '/api/settings/claude', { localhost: false });

    // One identity whose name is a setting. It can not take an author agent's name, nor another
    // reviewer's, and nobody can post under it.
    await assert.rejects(human('PUT', '/api/settings/claude', { name: 'claude' }), /is what the CLI calls author agents/);
    await assert.rejects(human('PUT', '/api/settings/claude', { name: 'codex-review' }), /already used by someone else/);
    await assert.rejects(human('PUT', '/api/settings/codex', { name: 'claude-review' }), /already used by someone else/);
    await human('PUT', '/api/settings/claude', { name: 'claude-bot' });
    assert.deepEqual([...new Set((await human('GET', `${base}/reviews`)).map((rv: any) => rv.user.login))], ['claude-bot']);
    for (const actor of ['claude-bot', 'codex-review']) {
      const impostor = await cli(['pr', 'comment', String(number), '-b', 'hi'], { actor });
      assert.equal(impostor.code, 1);
      assert.match(impostor.stderr, new RegExp(`"${actor}" is the name of the ${actor === 'codex-review' ? 'Codex' : 'Claude'} reviewer`));
    }
    await human('PUT', '/api/settings/claude', { name: 'claude-review' });

    // Its own switch and limit on each pull request, in its menu in the sidebar as for Codex.
    html = await page();
    assert.match(html, new RegExp(`data-api="${base}/reviewers/claude" data-limit="2"`));
    assert.match(html, new RegExp(`class="dropdown-item js-reviewer-switch"[^>]* data-api="${base}/reviewers/claude" data-enabled="false">Turn off<`));
    assert.deepEqual(await human('PATCH', `${base}/reviewers/claude`, { enabled: false }), { enabled: false, max_iterations: 2, overrides: { enabled: false, max_iterations: null } });
    html = await page();
    // Only the automatic ones are off: the row may say Reviewing above, for a review asked for by hand.
    assert.match(html, /<span class="agent-chunk">Automatic: off for this pull request<\/span>/);
    assert.match(html, /data-field="enabled">Follow Settings<span class="dropdown-item-desc">On in Settings<\/span>/);
    assert.match(html, new RegExp(`js-reviewer-switch"[^>]* data-api="${base}/reviewers/claude" data-enabled="true">Turn on<`));
    assert.deepEqual(await human('PATCH', `${base}/reviewers/claude`, { enabled: null }), { enabled: true, max_iterations: 2, overrides: { enabled: null, max_iterations: null } });
    await human('PUT', '/api/settings/claude', { enabled: false, model: '', effort: '', maxIterations: 3 });
  });
});

test("a reviewer agent's progress shows while it runs, and its transcript stays", async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/progress');
  writeFileSync(join(repo, 'progress.js'), 'export const progress = 1;\n');
  git('add', 'progress.js');
  git('commit', '-qm', 'Add progress.js');
  const created = await cli(['pr', 'create', '--title', 'Show the progress', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const pullPath = `/acme/widgets/pull/${number}`;
  const page = async (path = '') => (await fetch(server.url + pullPath + path)).text();
  const pull = await human('GET', base);
  const gate = join(dir, 'codex-progress-gate');
  const review = { summary: 'One thing.', comments: [{ path: 'progress.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it better.' }] };
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_BIG: '1', FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { runTests: false });
    // Pages hear of progress on the stream they share, as their own kind of message.
    const listening = new AbortController();
    const heard = fetch(`${server.url}/events?pull=${pull.id}`, { signal: listening.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      let text = '';
      while (!/data: \{"type":"progress".*\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    });
    let runId: number;
    try {
      ({ run_id: runId } = await human('POST', `${base}/reviewers/codex`));
      // While Codex waits, the sidebar shows what it did: the file it read, at the reviewed commit,
      // the command it runs now, what it said and how many steps it took.
      await until(async () => (await page()).includes('git diff HEAD~1 HEAD'), 'the sidebar shows the running command');
      const html = await page();
      const box = `<div class="run-progress js-run-progress" data-run="${runId}" data-src="${pullPath}/runs/${runId}/progress">`;
      assert.ok(html.includes(box), html);
      assert.match(html, new RegExp(`run-step--completed">[^]*?<span class="run-step-label">Read <a class="run-location" href="/acme/widgets/blob/${pull.head.sha}/math\\.js#L2"><code>math\\.js:2</code></a></span>`));
      assert.match(html, /run-step--in_progress">[^]*?<code class="run-command">git diff HEAD~1 HEAD<\/code>/);
      assert.match(html, /<p class="run-said" title="What it last said">I will read math\.js and the diff\.<\/p>/);
      assert.match(html, new RegExp(`<a class="run-link" href="${pullPath}/runs/${runId}">.*Transcript \\(2 steps\\)</a>`));
      // The same box alone, which the page fetches again when it hears of progress.
      const part = await fetch(`${server.url}${pullPath}/runs/${runId}/progress`);
      assert.equal(part.status, 200);
      assert.ok((await part.text()).startsWith(box));
      assert.ok((await heard).includes(`data: {"type":"progress","event":{"pullId":${pull.id},"runId":${runId}}}\n`), 'a progress message');
      // The transcript page follows the run while it goes on.
      const live = await page(`/runs/${runId}`);
      assert.match(live, new RegExp(`<div id="main"[^>]* data-run-live="${runId}"`));
      assert.match(live, /Reviewing for <relative-time/);
      writeFileSync(gate, '');
      await server.service.codex!.settle(pull.id);
    } finally {
      listening.abort();
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { runTests: true });
    }

    // Once it is done, the box is gone, and the sidebar and the review link to the transcript.
    assert.equal((await fetch(`${server.url}${pullPath}/runs/${runId}/progress`)).status, 204);
    const html = await page();
    assert.doesNotMatch(html, /js-run-progress/);
    // Its row says what it found, with a comment in the attention colour: agent has not answered it.
    assert.match(html, new RegExp(`<a class="agent-state" href="${pullPath}/runs/${runId}" title="Found 1 problem in ${pull.head.sha.slice(0, 7)}; agent has not answered it"><svg class="octicon octicon-comment color-fg-attention"[^>]*>[^]*?</svg><span>1 finding · <code>${pull.head.sha.slice(0, 7)}</code></span></a>`));
    assert.match(html, new RegExp(`<a class="review-run-link" href="${pullPath}/runs/${runId}">`));
    // Codex says how many tokens it used.
    assert.match(html, /<span title="Last run: 12k tokens in, 300 out[^"]*">12k tokens<\/span>/);

    const transcript = await page(`/runs/${runId}`);
    assert.doesNotMatch(transcript, /data-run-live/);
    assert.match(transcript, /codex-review's review on request of <code>[0-9a-f]{7}<\/code>/);
    assert.match(transcript, new RegExp(`<a href="${pullPath}#pullrequestreview-\\d+">Posted its review</a>`));
    assert.match(transcript, /2 steps · 12k tokens in, 300 out/);
    assert.match(transcript, /The prompt galley gave it<\/summary><pre class="run-output">[^<]*Title: Show the progress/);
    assert.match(transcript, /run-thought[^]*<strong>Reading the change<\/strong>/);
    assert.match(transcript, /I will read math\.js and the diff\./);
    // The read links to the file at the reviewed commit, with the command that read it and its
    // output, of which only the start and the end are kept.
    assert.match(transcript, new RegExp(`Read <a class="run-location" href="/acme/widgets/blob/${pull.head.sha}/math\\.js#L2"><code>math\\.js:2</code></a></span> <svg[^>]*octicon-check[^]*?<pre class="run-output run-output--command">\\$ sed -n &#39;2,20p&#39; math\\.js</pre>`));
    assert.match(transcript, /<pre class="run-output">a{8192}\n… 83616 bytes left out …\nx{8192}<\/pre>/);
    assert.match(transcript, /<code class="run-command">git diff HEAD~1 HEAD<\/code><\/span> <svg[^>]*octicon-check[^]*?\+export const answer = 41;/);
    // Its answer, as code.
    assert.match(transcript, /&quot;summary&quot;: &quot;One thing\.&quot;/);
    // Stored as ACP session updates; the tokens are not among them.
    const stored = server.service.db.all<{ data: string }>('SELECT data FROM review_run_events WHERE run_id = ? ORDER BY id', runId).map((r) => JSON.parse(r.data).sessionUpdate);
    assert.deepEqual(stored, ['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
    // A run of another pull request is not this one's.
    assert.equal((await fetch(`${server.url}/acme/widgets/pull/1/runs/${runId}`)).status, 404);
  });
});

test('a reviewer can not take a name that --reviewer would take for the other one', async () => {
  // The other's kind or name, in any case: staging with it would turn on the other reviewer.
  const codex = server.service.codex!.actor().login;
  for (const name of ['CODEX', 'Codex', codex.toUpperCase()]) {
    await assert.rejects(human('PUT', '/api/settings/claude', { name }), new RegExp(`${name}\\\\?" would ask for the Codex reviewer \\(--reviewer ${name}\\)`));
  }
  await assert.rejects(human('PUT', '/api/settings/codex', { name: 'Claude-Review' }), /Claude-Review\\?" would ask for the Claude reviewer/);
  const { codex: codexSettings, claude: claudeSettings } = await human('GET', '/api/settings');
  assert.deepEqual([codexSettings.name, claudeSettings.name], [codex, 'claude-review']);
  assert.deepEqual([server.service.codex!.actor().login, server.service.claude!.actor().login], [codex, 'claude-review']);
});

test('runs of a Codex bot called "claude", from before there was a Claude reviewer, stay Codex\'s', async () => {
  const db = new Db(':memory:');
  try {
    const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
    const registered = await s.registerRepo(repo);
    const pull = await s.createPull(registered, { title: 'Reviewed by a bot called claude', head: 'feature/mul', base: 'main' }, db.actor('agent', 'Bot'));
    // An older version recorded the bot's login in its runs, and "claude" was a name it could have.
    const review = await s.createReview(await s.ctx(registered.owner, registered.name, pull.number), { event: 'COMMENT', body: 'Fine.' }, db.actor('claude', 'Bot'));
    const run = { pull_id: pull.id, head_sha: pull.head_sha, trigger: 'auto', status: 'done', review_id: review.id, findings: 0 };
    db.insert('review_runs', { ...run, reviewer: 'claude', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z' });
    const start = () => {
      s.codex = new CodexReviewer(s, join(dir, 'codex'));
      s.claude = new ClaudeReviewer(s, join(dir, 'claude'));
      for (const r of s.reviewerAgents()) r.start();
    };
    const reviewers = () => db.all<{ reviewer: string }>('SELECT reviewer FROM review_runs ORDER BY id').map((r) => r.reviewer);
    start();
    // Codex's run, counted as Codex's automatic review; Claude has not reviewed the head.
    const row = db.get<any>('SELECT * FROM pulls WHERE id = ?', pull.id);
    assert.deepEqual(reviewers(), ['codex']);
    assert.equal(s.codex!.automaticReviews(row), 1);
    assert.equal(s.claude!.headStatus(row).state, 'off');
    // A run of the Claude reviewer stays Claude's, also when the server starts again.
    db.insert('review_runs', { ...run, reviewer: 'claude', started_at: now(), finished_at: now() });
    for (const r of s.reviewerAgents()) await r.stop();
    start();
    assert.deepEqual(reviewers(), ['codex', 'claude']);
    for (const r of s.reviewerAgents()) await r.stop();
  } finally {
    db.sql.close();
  }
});

test('a reviewer can leave pull requests by its own kind of agent to the other', async (t) => {
  await withFakes({
    FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine by Codex.', comments: [] }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine by Claude.', comments: [] }),
  }, async () => {
    const stage = async (branch: string, file: string, actor: string, flags: string[] = []) => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', branch);
      writeFileSync(join(repo, file), 'export {};\n');
      git('add', file);
      git('commit', '-qm', `Add ${file}`);
      const r = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', ...flags], { actor });
      assert.equal(r.code, 0, r.stderr);
      return Number(r.stdout.trim().split('/').pop());
    };
    const config = async (n: number, kind: string) => {
      const { enabled, runs } = await human('GET', `/api/repos/acme/widgets/pulls/${n}/reviewers/${kind}`);
      return { enabled, runs: runs.length };
    };
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1, skipOwnKind: true });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 1, skipOwnKind: true });
    try {
      await t.test('Codex reviews what an agent in Claude Code wrote, and Claude does not', async () => {
        const n = await stage('feature/by-claude', 'by-claude.js', 'claude');
        const w = await cli(['pr', 'wait', String(n), '--timeout', '20s'], { actor: 'claude' });
        assert.equal(w.code, 0, w.stderr);
        assert.match(w.stdout, /codex-review reviewed: commented/);
        assert.doesNotMatch(w.stdout, /claude-review/);
        assert.deepEqual(await config(n, 'claude'), { enabled: false, runs: 0 });
        assert.deepEqual(await config(n, 'codex'), { enabled: true, runs: 1 });
        const html = await (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text();
        assert.match(html, /Settings leave pull requests by agents in Claude Code to other reviewers/);
      });
      await t.test('galley reviewers says which review the caller\'s pull requests on their own', async () => {
        const list = async (actor: string) => JSON.parse((await cli(['reviewers', '--json', 'name,automatic'], { actor })).stdout);
        assert.deepEqual(await list('claude'), [{ name: 'codex-review', automatic: true }, { name: 'claude-review', automatic: false }]);
        assert.deepEqual(await list('codex-agent'), [{ name: 'codex-review', automatic: false }, { name: 'claude-review', automatic: true }]);
      });
      await t.test('and the other way round', async () => {
        const n = await stage('feature/by-codex-agent', 'by-codex-agent.js', 'codex-agent');
        const w = await cli(['pr', 'wait', String(n), '--timeout', '20s'], { actor: 'codex-agent' });
        assert.equal(w.code, 0, w.stderr);
        assert.match(w.stdout, /claude-review reviewed: commented/);
        assert.deepEqual(await config(n, 'codex'), { enabled: false, runs: 0 });
      });
      await t.test('asked for when staging, it reviews all the same', async () => {
        const n = await stage('feature/by-claude-asked', 'by-claude-asked.js', 'claude', ['--reviewer', 'claude:1']);
        assert.deepEqual((await human('GET', `/api/repos/acme/widgets/pulls/${n}/reviewers/claude`)).overrides, { enabled: true, max_iterations: 1 });
        await human('PATCH', `/api/repos/acme/widgets/pulls/${n}/reviewers/codex`, { enabled: false });
        const w = await cli(['pr', 'wait', String(n), '--timeout', '20s'], { actor: 'claude' });
        assert.equal(w.code, 0, w.stderr);
        assert.match(w.stdout, /claude-review reviewed: commented/);
      });
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3, skipOwnKind: false });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3, skipOwnKind: false });
    }
  });
});

test('with two reviewer agents, pr wait hands the author both reviews of a commit together', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/two-reviewers');
  writeFileSync(join(repo, 'two-reviewers.js'), 'export const two = 1;\n');
  git('add', 'two-reviewers.js');
  git('commit', '-qm', 'Add two-reviewers.js');
  const created = await cli(['pr', 'create', '--title', 'Two reviewers', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const finished = async (kind: string, n: number) => (await human('GET', `${base}/reviewers/${kind}`)).runs.filter((r: any) => r.status === 'done').length === n;
  const comment = (body: string) => ({ path: 'two-reviewers.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body });
  const gate = join(dir, 'claude-gate');
  await withFakes({
    FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Codex has one thing.', comments: [comment('From Codex.')] }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Claude has another.', comments: [comment('From Claude.')] }),
    FAKE_CLAUDE_GATE: gate,
  }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 2 });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 2 });
    try {
      // Codex is done with the commit and Claude is still at it: the author keeps waiting.
      let returned = false;
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '30s']).finally(() => (returned = true));
      await until(() => finished('codex', 1), 'Codex has reviewed');
      await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS', 'Claude reviews');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(returned, false, 'pr wait returned before Claude reviewed');
      // Who is still reviewing: in pr view, its turn, and the sidebar.
      const view = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewRequests,turn'])).stdout);
      assert.deepEqual(view.reviewRequests.map((r: any) => [r.login, r.status]), [['claude-review', 'IN_PROGRESS']]);
      assert.equal(view.turn.whose, 'REVIEWER_AGENTS');
      const html = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
      assert.match(html, /<span class="flex-auto">claude-review<\/span> <span title="Reviewing [0-9a-f]{7}">/);
      assert.match(html, /<span class="flex-auto">codex-review<\/span> <svg[^>]*octicon-comment/);
      assert.match(html, /<strong>Claude is still reviewing this commit<\/strong>/);

      // Then both reviews come back together.
      writeFileSync(gate, '');
      const both = await waiting;
      assert.equal(both.code, 0, both.stderr);
      assert.match(both.stdout, /codex-review reviewed: commented/);
      assert.match(both.stdout, /claude-review reviewed: commented/);
      assert.match(both.stdout, /From Codex\.[^]*From Claude\.|From Claude\.[^]*From Codex\./);
      await server.service.claude!.settle(id);

      // Feedback from anyone else comes back at once, with what the reviewer agents posted so far
      // and who is still reviewing.
      rmSync(gate);
      writeFileSync(join(repo, 'two-reviewers.js'), 'export const two = 2;\n');
      git('commit', '-qam', 'Answer both');
      const second = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(() => finished('codex', 2), 'Codex has reviewed the new commit');
      await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS', 'Claude reviews the new commit');
      await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Looks better.' });
      const early = await second;
      assert.equal(early.code, 0, early.stderr);
      assert.match(early.stdout, /reviewer commented/);
      assert.match(early.stdout, /codex-review reviewed: commented/);
      assert.doesNotMatch(early.stdout, /claude-review reviewed/);
      assert.match(early.stdout, /^claude-review is reviewing [0-9a-f]{7} \(started [^)]*\)\.$/m);
      writeFileSync(gate, '');
      const last = await cli(['pr', 'wait', String(number), '--timeout', '30s']);
      assert.match(last.stdout, /claude-review reviewed: commented/);
      await server.service.claude!.settle(id);
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
    }
  });
});

test('pr wait says when the reviewer agents leave nothing to address, and which reviews are still to come', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/nothing-to-address');
  writeFileSync(join(repo, 'nothing.js'), 'export const nothing = 1;\n');
  git('add', 'nothing.js');
  git('commit', '-qm', 'Add nothing.js');
  const created = await cli(['pr', 'create', '--title', 'Add nothing.js', '--body', 'x', '--reviewer', 'codex:4']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const { id } = await human('GET', `/api/repos/acme/widgets/pulls/${number}`);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  // The author waits, and Codex answers `review`.
  const wait = (review: object = { summary: 'Fine.', comments: [] }) =>
    withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
      const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
      assert.equal(r.code, 0, r.stderr);
      await server.service.codex!.settle(id);
      return r.stdout;
    });
  const commit = async (n: number) => {
    writeFileSync(join(repo, 'nothing.js'), `export const nothing = ${n};\n`);
    git('commit', '-qam', `Count to ${n}`);
    await until(() => row().head_sha === git('rev-parse', 'HEAD'), 'the server has the new commit');
  };
  try {
    // A finding outside the diff has no thread to answer in, and asks something of the author all the same.
    const found = await wait({ summary: 'One thing.', comments: [{ path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' }] });
    assert.match(found, /`math\.js:1` \(low priority\): Not in this diff\./);
    assert.match(found, /^Address the feedback\./m);

    // Codex finds nothing in the next commit, and Claude's review of it is still to run, as after a restart.
    await commit(2);
    const interrupted = server.service.db.insert('review_runs', { pull_id: id, reviewer: 'claude', head_sha: row().head_sha, trigger: 'manual', status: 'interrupted', started_at: now(), finished_at: now() });
    const clean = await wait();
    assert.match(clean, /codex-review reviewed: commented/);
    assert.match(clean, new RegExp(`^Nothing to address\\. Run \`galley pr wait s${number}\` again for the review still to come \\(claude-review's review of ${sha()} was interrupted by a restart; it will run again\\)\\.$`, 'm'));
    assert.doesNotMatch(clean, /Address the feedback/);
    server.service.db.run('DELETE FROM review_runs WHERE id = ?', interrupted);
    assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(codex-review found nothing in ${sha()}\\); `));

    // A thread the author was shown and has not answered since its latest comment is still to address,
    // whatever the reviewer agents found.
    await human('POST', `/api/repos/acme/widgets/pulls/${number}/reviews`, { event: 'COMMENT', comments: [{ path: 'nothing.js', line: 1, side: 'RIGHT', body: 'Why a constant?' }] });
    const thread = (await human('GET', `/api/repos/acme/widgets/pulls/${number}/comments`)).at(-1).id;
    assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(thread), '-b', 'It is all it needs.'])).code, 0);
    await human('POST', `/api/repos/acme/widgets/pulls/${number}/comments/${thread}/replies`, { body: 'Is it?' });
    await cli(['pr', 'view', String(number), '--comments']);
    await commit(3);
    const open = await wait();
    assert.match(open, /codex-review reviewed: commented/);
    assert.match(open, /^Address the feedback\./m);
    assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(thread), '-b', 'Yes.'])).code, 0);
    assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} `));

    // Once answered, it may stay open. The only reviewer agent finds nothing: the next wait hands the commit over.
    await commit(4);
    const done = await wait();
    assert.match(done, new RegExp(`^Unresolved threads: ${thread}$`, 'm'));
    assert.match(done, new RegExp(`^Nothing to address\\. Run \`galley pr wait s${number}\` again\\.$`, 'm'));
    assert.doesNotMatch(done, /Address the feedback/);
    assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(codex-review found nothing in ${sha()}\\); `));
  } finally {
    await human('PATCH', `/api/repos/acme/widgets/pulls/${number}`, { state: 'closed' });
  }
});

test('stop iterating: a running review finishes, no new one starts, the author hands over, and Resume lets them go on', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-iterating');
  writeFileSync(join(repo, 'stop.js'), 'export const stop = 1;\n');
  git('add', 'stop.js');
  git('commit', '-qm', 'Add stop.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const { id } = await human('GET', base);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const runs = async (kind: string) => (await human('GET', `${base}/reviewers/${kind}`)).runs.map((r: any) => r.status);
  const ownLimits = async () => Promise.all(['codex', 'claude'].map(async (kind) => (await human('GET', `${base}/reviewers/${kind}`)).overrides.max_iterations));
  const comment = (body: string) => ({ path: 'stop.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body });
  const gate = join(dir, 'claude-gate');
  await withFakes({
    FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Codex has one thing.', comments: [comment('From Codex.')] }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Claude has another.', comments: [comment('From Claude.')] }),
    FAKE_CLAUDE_GATE: gate,
  }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 3 });
    try {
      // Codex has reviewed the first commit and Claude is still at it when the reviewer stops iterating.
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(async () => (await runs('codex'))[0] === 'done', 'Codex has reviewed');
      await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS', 'Claude reviews');
      assert.match(await page(), /<strong>1 automatic review round so far<\/strong>[^]*>Stop iterating<\/button>/);
      const agent = await fetch(`${server.url}${base}/stop-iterating`, { method: 'PUT', headers: { 'x-galley-actor': 'agent' } });
      assert.equal(agent.status, 403);
      const stopped = await human('PUT', `${base}/stop-iterating`);
      assert.equal(stopped.iterations_stopped.stopped_by.login, 'reviewer');
      assert.equal(stopped.iterations_stopped.round, 1);
      // The stop is the gate; the limits stay as they were.
      assert.deepEqual(await ownLimits(), [null, null]);

      // Nothing running is cut short: Claude's review reaches the author.
      assert.equal(server.service.claude!.atWork(row())?.status, 'IN_PROGRESS');
      writeFileSync(gate, '');
      const both = await waiting;
      assert.equal(both.code, 0, both.stderr);
      assert.match(both.stdout, /codex-review reviewed: commented/);
      assert.match(both.stdout, /claude-review reviewed: commented/);
      await server.service.claude!.settle(id);
      const box = await page();
      assert.match(box, /<strong>Iterations stopped by reviewer after round 1<\/strong>[^]*>Resume<\/button>/);
      assert.match(box, /stopped automatic reviews after round 1/);
      assert.doesNotMatch(box, />Stop iterating<\/button>/);

      // The author's next commit gets no automatic review: pr wait hands it to the reviewer, saying why.
      writeFileSync(join(repo, 'stop.js'), 'export const stop = 2;\n');
      git('commit', '-qam', 'Answer both');
      const sha = git('rev-parse', '--short=7', 'HEAD');
      const handed = await handedOver(number);
      assert.match(handed, new RegExp(`^The reviewer agents are done with ${sha} \\(reviewer stopped automatic reviews after round 1\\); ask the user to review it: `, 'm'));
      assert.deepEqual([await runs('codex'), await runs('claude')], [['done'], ['done']]);
      assert.ok(server.service.readiness(row()).reviewers.every((r) => doneForAutoPublish(r.status.state)));
      const { turn } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
      assert.deepEqual(turn.reasons.filter((r: string) => r.includes('stopped')), ['reviewer stopped automatic reviews after round 1']);

      // Resume lets them go on, and the waiting author's commit is reviewed at once (the gate is open).
      const again = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(() => (server.service.waiters.get(id) ?? 0) > 0, 'the author waits');
      await human('DELETE', `${base}/stop-iterating`);
      assert.equal((await human('GET', base)).iterations_stopped, null);
      const reviewed = await again;
      assert.equal(reviewed.code, 0, reviewed.stderr);
      assert.match(reviewed.stdout, /codex-review reviewed: commented/);
      assert.match(reviewed.stdout, /claude-review reviewed: commented/);
      await server.service.claude!.settle(id);
      assert.match(await page(), /resumed automatic reviews/);

      // A limit set by hand resumes them, as Resume does.
      await human('PUT', `${base}/stop-iterating`);
      await human('PATCH', `${base}/reviewers/codex`, { max_iterations: 3 });
      assert.equal((await human('GET', base)).iterations_stopped, null);
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
    }
  });
});

test('a review that fails after iterations stop holds nothing up, and the next commit gets no automatic review', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-then-fail');
  writeFileSync(join(repo, 'stop-fail.js'), 'export const fail = 1;\n');
  git('add', 'stop-fail.js');
  git('commit', '-qm', 'Add stop-fail.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop-fail.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const codex = server.service.codex!;
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const codexStatus = () => server.service.readiness(row()).reviewers.find((r) => r.engine === 'codex')!.status;
  const gate = join(dir, 'codex-gate');
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
  try {
    await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_FAIL: '1' }, async () => {
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(() => codex.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
      assert.equal((await human('PUT', `${base}/stop-iterating`)).iterations_stopped.round, 1);
      // Still running, it holds things up.
      assert.equal(codexStatus().state, 'reviewing');
      // The review fails, as one cut short by a server restart does, so no automatic review counts as done.
      writeFileSync(gate, '');
      const failed = await waiting;
      assert.equal(failed.code, 0, failed.stderr);
      await codex.settle(id);

      // On the same commit, the failure holds nothing up: Codex is done, the author hands over, and
      // a waiting author with nothing unseen is all auto-publish waits for. The sidebar still shows the failure.
      assert.match(failed.stdout, /\(reviewer stopped automatic reviews after round 1\); ask the user to review it: /);
      assert.equal(codexStatus().state, 'capped');
      const again = cli(['pr', 'wait', String(number), '--timeout', '2s']);
      await until(() => server.service.waiters.get(id), 'the author waits');
      assert.equal(server.service.readiness(row()).agentsDone, true);
      assert.equal((await again).code, 124);
      const html = await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
      assert.match(html, /title="Review of [0-9a-f]{7} failed"/);
      assert.match(html, /<span class="agent-chunk">Automatic: stopped at \d+ of \d+<\/span>/);

      // The next commit still gets no automatic review: pr wait hands it to the reviewer.
      writeFileSync(join(repo, 'stop-fail.js'), 'export const fail = 2;\n');
      git('commit', '-qam', 'Change stop-fail.js');
      const handed = await handedOver(number);
      assert.match(handed, /\(reviewer stopped automatic reviews after round 1\); ask the user to review it: /);
      assert.deepEqual((await human('GET', `${base}/reviewers/codex`)).runs.map((r: any) => r.status), ['failed']);
      assert.ok(server.service.readiness(row()).reviewers.every((r) => doneForAutoPublish(r.status.state)));
    });
  } finally {
    rmSync(gate, { force: true });
    await human('PUT', '/api/settings/codex', { enabled: false });
  }
});

test('setting a limit by hand while iterations are stopped resumes every reviewer agent', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-then-limit');
  writeFileSync(join(repo, 'stop-limit.js'), 'export const limit = 1;\n');
  git('add', 'stop-limit.js');
  git('commit', '-qm', 'Add stop-limit.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop-limit.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const pull = await human('GET', base);
  const runs = async (kind: string) => (await human('GET', `${base}/reviewers/${kind}`)).runs.length;
  // Codex has reviewed the head once; Claude, below its limit, has not reviewed it.
  server.service.db.insert('review_runs', { pull_id: pull.id, reviewer: 'codex', head_sha: pull.head.sha, trigger: 'auto', status: 'done', findings: 1, started_at: now(), finished_at: now() });
  await withFakes({ FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Claude has a look.', comments: [] }) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 3 });
    try {
      await human('PUT', `${base}/stop-iterating`);
      await handedOver(number);
      assert.equal(await runs('claude'), 0);

      // With the author waiting, Codex's limit set to the reviews it has done ends the stop, as Resume
      // does: Claude reviews at once, and the timeline says the reviews were resumed.
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '10s']);
      await until(() => server.service.waiters.get(pull.id), 'the author waits');
      await human('PATCH', `${base}/reviewers/codex`, { max_iterations: 1 });
      assert.equal((await human('GET', base)).iterations_stopped, null);
      const reviewed = await waiting;
      assert.equal(reviewed.code, 0, reviewed.stderr);
      assert.match(reviewed.stdout, /claude-review reviewed: commented/);
      assert.deepEqual([await runs('codex'), await runs('claude')], [1, 1]);
      assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(), /resumed automatic reviews/);
      await server.service.claude!.settle(pull.id);
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
    }
  });
});

test('after a stop, the handoff and the turn say so once, also when every reviewer agent found nothing or is off', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-clean');
  writeFileSync(join(repo, 'stop-clean.js'), 'export const clean = 1;\n');
  git('add', 'stop-clean.js');
  git('commit', '-qm', 'Add stop-clean.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop-clean.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const pull = await human('GET', base);
  const sha = pull.head.sha.slice(0, 7);
  // Codex found nothing in the head, with reviews to spare; Claude is off.
  server.service.db.insert('review_runs', { pull_id: pull.id, reviewer: 'codex', head_sha: pull.head.sha, trigger: 'auto', status: 'done', findings: 0, started_at: now(), finished_at: now() });
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
  try {
    await human('PUT', `${base}/stop-iterating`);
    const handed = await handedOver(number);
    assert.match(handed, new RegExp(`^The reviewer agents are done with ${sha} \\(codex-review found nothing in ${sha}; reviewer stopped automatic reviews after round 1\\); ask the user`, 'm'));
    const { turn } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
    assert.deepEqual(turn.reasons.filter((r: string) => r.includes('stopped')), ['reviewer stopped automatic reviews after round 1']);
  } finally {
    await human('PUT', '/api/settings/codex', { enabled: false });
  }
});

test('Stop iterating shows the round it records, also when a reviewer ahead of the others has used up its reviews', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/stop-round');
  writeFileSync(join(repo, 'stop-round.js'), 'export const round = 1;\n');
  git('add', 'stop-round.js');
  git('commit', '-qm', 'Add stop-round.js');
  const created = await cli(['pr', 'create', '--title', 'Add stop-round.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const pull = await human('GET', base);
  // Codex has used up its two automatic reviews; Claude, with three, has done one.
  for (const reviewer of ['codex', 'codex', 'claude']) {
    server.service.db.insert('review_runs', { pull_id: pull.id, reviewer, head_sha: pull.head.sha, trigger: 'auto', status: 'done', findings: 1, started_at: now(), finished_at: now() });
  }
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 2 });
  await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 3 });
  try {
    assert.match(await page(), /<strong>2 automatic review rounds so far<\/strong>[^]*>Stop iterating<\/button>/);
    assert.equal((await human('PUT', `${base}/stop-iterating`)).iterations_stopped.round, 2);
    assert.match(await page(), /<strong>Iterations stopped by reviewer after round 2<\/strong>/);
  } finally {
    await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
    await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
  }
});

test('beside Stop iterating and Resume, what each reviewer agent last found, by priority, and the round running', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/last-round');
  writeFileSync(join(repo, 'last-round.js'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  git('add', 'last-round.js');
  git('commit', '-qm', 'Add last-round.js');
  const created = await cli(['pr', 'create', '--title', 'Add last-round.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  // The summary line, as text, and where its links go.
  const found = async () => {
    const line = (await page()).match(/<div class="iterations-found">([^]*?)<\/div>/)?.[1] ?? '';
    return { text: line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), links: [...line.matchAll(/href="#pullrequestreview-(\d+)"/g)].map((m) => Number(m[1])) };
  };
  const reviewId = async (kind: string) => (await human('GET', `${base}/reviewers/${kind}`)).runs.at(-1).review_id;
  const comment = (line: number, priority: string | null, body: string, path = 'last-round.js') => ({ path, line, start_line: null, side: 'RIGHT', priority, body });
  // Codex finds things of every priority, one of them on a line outside the diff; Claude finds nothing.
  const gate = join(dir, 'claude-gate');
  await withFakes({
    FAKE_CODEX_REVIEW: JSON.stringify({
      summary: 'Codex has five things.',
      comments: [comment(1, 'high', 'One.'), comment(2, 'medium', 'Two.'), comment(3, 'medium', 'Three.'), comment(3, null, 'Four.'), comment(1, 'high', 'Five.', 'math.js')],
    }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Nothing to say.', comments: [] }),
    FAKE_CLAUDE_GATE: gate,
  }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    await human('PUT', '/api/settings/claude', { enabled: true, maxIterations: 3 });
    try {
      assert.deepEqual(await found(), { text: '', links: [] });
      // Codex is done and Claude is still at it: the round is running, beside what Codex found.
      const waiting = cli(['pr', 'wait', String(number), '--timeout', '30s']);
      await until(async () => (await human('GET', `${base}/reviewers/codex`)).runs[0]?.status === 'done', 'Codex has reviewed');
      await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS', 'Claude reviews');
      const codexReview = await reviewId('codex');
      assert.deepEqual(await found(), { text: 'Round 1 running · last round: codex-review 2 High 2 Medium 1 unprioritized', links: [codexReview] });
      assert.match(await page(), /<strong>1 automatic review round so far<\/strong><div class="iterations-found">[^]*>Stop iterating<\/button>/);

      // Claude found nothing; the round is over.
      writeFileSync(gate, '');
      assert.equal((await waiting).code, 0);
      await server.service.claude!.settle(id);
      const claudeReview = await reviewId('claude');
      const done = { text: 'Last round: codex-review 2 High 2 Medium 1 unprioritized · claude-review nothing', links: [codexReview, claudeReview] };
      assert.deepEqual(await found(), done);

      // A thread the author resolves still counts: it is what the round surfaced.
      const threads = await human('GET', `${base}/comments`);
      const high = threads.find((c: any) => c.body === 'One.');
      const resolved = await cli(['pr', 'comment', '--reply-to', String(high.id), '--resolve', '-b', 'Fixed.']);
      assert.equal(resolved.code, 0, resolved.stderr);
      assert.deepEqual(await found(), done);

      // After a stop, the Resume row says the same.
      await human('PUT', `${base}/stop-iterating`);
      assert.match(await page(), /<strong>Iterations stopped by reviewer after round 1<\/strong><div class="iterations-found">[^]*>Resume<\/button>/);
      assert.deepEqual(await found(), done);
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      await human('PUT', '/api/settings/claude', { enabled: false, maxIterations: 3 });
    }
  });
});

test('symlinks in a pull request lead the reviewer nowhere: not to /dev/zero, not outside the checkout', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'galley-outside-'));
  writeFileSync(join(outside, 'secret'), 'keep\n');
  chmodSync(join(outside, 'secret'), 0o444);
  chmodSync(outside, 0o555);
  try {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'feature/symlinks');
    // Read from the checkout, package.json would never end and the symlinked lockfile would win.
    symlinkSync('/dev/zero', join(repo, 'package.json'));
    symlinkSync(join(outside, 'secret'), join(repo, 'pnpm-lock.yaml'));
    symlinkSync(outside, join(repo, 'vendor'));
    writeFileSync(join(repo, 'package-lock.json'), '{}\n');
    git('add', 'package.json', 'pnpm-lock.yaml', 'vendor', 'package-lock.json');
    git('commit', '-qm', 'Link things');
    const created = await cli(['pr', 'create', '--title', 'Link things', '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const base = `/api/repos/acme/widgets/pulls/${created.stdout.trim().split('/').pop()}`;
    const pull = await human('GET', base);
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }) }, async () => {
      await human('POST', `${base}/reviewers/codex`);
      await server.service.codex!.settle(pull.id);
    });
    const { runs } = await human('GET', `${base}/reviewers/codex`);
    assert.deepEqual(runs.map((x: any) => x.status), ['done']);
    const install = readFileSync(process.env.FAKE_CODEX_SANDBOX_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(install.args.slice(install.args.indexOf('--') + 1, install.args.indexOf('--') + 3), ['npm', 'ci']);
    // Cleaning up the checkout made nothing outside it writable, and removed nothing there.
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'keep\n');
    assert.equal(statSync(join(outside, 'secret')).mode & 0o777, 0o444);
    assert.equal(statSync(outside).mode & 0o777, 0o555);
  } finally {
    chmodSync(outside, 0o755);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a review still running shows in pr view and pr wait, and publishing before it needs a confirmation', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/slow-review');
  writeFileSync(join(repo, 'slow.js'), 'export const slow = true;\n');
  git('add', 'slow.js');
  git('commit', '-qm', 'Add slow');
  const created = await cli(['pr', 'create', '--title', 'Add slow', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
  const head = git('rev-parse', 'HEAD');
  const sha = head.slice(0, 7);
  const gate = join(dir, 'codex-gate');
  const review = { summary: 'One thing.', comments: [{ path: 'slow.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it after what it means.' }] };
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1 });
    try {
      // An author starting to wait queues an automatic review, which shows before it runs.
      const pull = await human('GET', base);
      const codex = server.service.codex!;
      const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pull.id);
      codex.consider(pull.id);
      assert.deepEqual(codex.atWork(row()), { status: 'QUEUED', head_sha: head, started_at: null });
      await until(() => codex.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');

      const waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
      const { reviewRequests } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewRequests'])).stdout);
      assert.equal(reviewRequests.length, 1);
      const { startedAt, ...request } = reviewRequests[0];
      assert.deepEqual(request, { __typename: 'Bot', login: 'codex-review', status: 'IN_PROGRESS', commit: { oid: head } });
      assert.ok(Date.now() - Date.parse(startedAt) < 20_000);
      const view = await cli(['pr', 'view', String(number)]);
      assert.match(view.stdout, new RegExp(`^reviewers:\tcodex-review \\(reviewing ${sha}, started just now\\)$`, 'm'));
      const box = await page();
      assert.match(box, /<strong>Codex is still reviewing this commit<\/strong>/);
      assert.match(box, /class="btn btn-primary btn-publish" data-confirm="Click again to publish anyway"/);

      // The reviewer approves while Codex works: the agent hears that Codex is not done.
      await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
      await human('POST', `${base}/reviews`, { event: 'APPROVE' });
      const approved = await waiting;
      assert.equal(approved.code, 0, approved.stderr);
      assert.match(approved.stdout, /reviewer reviewed: approved/);
      assert.match(approved.stdout, new RegExp(`^codex-review is reviewing ${sha} \\(started just now\\)\\.$`, 'm'));
      assert.match(approved.stdout, new RegExp(`codex-review is still reviewing; run \`galley pr wait s${number}\` to get its review\\.`));
      assert.doesNotMatch(approved.stdout, /nothing left open/);

      // Its review wakes the next wait, which says the approval came before it.
      writeFileSync(gate, '');
      const reviewed = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
      assert.equal(reviewed.code, 0, reviewed.stderr);
      assert.match(reviewed.stdout, /codex-review reviewed: commented/);
      assert.match(reviewed.stdout, /^The approval from reviewer came before this review from codex-review\.$/m);
      assert.doesNotMatch(reviewed.stdout, /codex-review is (still )?reviewing/);
      await codex.settle(pull.id);
      assert.deepEqual(JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewRequests'])).stdout), { reviewRequests: [] });
      const stale = await page();
      assert.doesNotMatch(stale, /Codex is still reviewing/);
      assert.doesNotMatch(stale, /data-confirm/);

      // A page loaded before a review started does not know of it, so the server asks: publishing
      // with that page's fingerprint is refused while Codex works, unless it says to go ahead.
      const expected = stale.match(/name="expected" value="([^"]+)"/)![1];
      rmSync(gate);
      await human('POST', `${base}/reviewers/codex`);
      const refused = await fetch(`${server.url}${base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected }) });
      assert.equal(refused.status, 428);
      assert.match((await refused.json()).message, /^codex-review is still reviewing this commit, and its review may ask for changes\. Publishing now cancels it\.$/);
      const fromTerminal = await cli(['pr', 'publish', String(number)], { actor: 'reviewer' });
      assert.equal(fromTerminal.code, 1);
      assert.match(fromTerminal.stderr, new RegExp(`Run \`galley pr publish s${number} --during-review\` to publish anyway\\.`));
      const agent = await cli(['pr', 'publish', String(number), '--during-review']);
      assert.match(agent.stderr, /only the user can publish/);
      const published = await human('POST', `${base}/publish`, { expected, during_review: true });
      assert.equal(published.staging_state, 'published');
      writeFileSync(gate, '');
      await codex.settle(pull.id);
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false });
    }
  });
});

test('a running review is cancelled when the pull request is published, closed, merged on GitHub or pushed to', async (t) => {
  // Both fake reviewers answer once their gate exists; until then their reviews run.
  const gates = { codex: join(dir, 'cancel-codex-gate'), claude: join(dir, 'cancel-claude-gate') };
  await withFakes({
    FAKE_CODEX_GATE: gates.codex,
    FAKE_CLAUDE_GATE: gates.claude,
    FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }),
    FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }),
  }, async () => {
    const stage = async (branch: string, file: string, review = ['--no-review']) => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', branch);
      writeFileSync(join(repo, file), 'export {};\n');
      git('add', file);
      git('commit', '-qm', `Add ${file}`);
      const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', ...review]);
      assert.equal(created.code, 0, created.stderr);
      const number = Number(created.stdout.trim().split('/').pop());
      const base = `/api/repos/acme/widgets/pulls/${number}`;
      const { id } = await human('GET', base);
      return { number, base, id, page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text() };
    };
    type Pr = Awaited<ReturnType<typeof stage>>;
    const reviewer = (engine: 'codex' | 'claude') => server.service[engine]!;
    const row = (pr: Pr) => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id);
    /** Ask for a review by hand, and wait until it runs. */
    const ask = async (pr: Pr, engine: 'codex' | 'claude') => {
      await human('POST', `${pr.base}/reviewers/${engine}`);
      await until(() => reviewer(engine).atWork(row(pr))?.status === 'IN_PROGRESS', `${engine} reviews`);
    };
    const runs = async (pr: Pr, engine: 'codex' | 'claude') => (await human('GET', `${pr.base}/reviewers/${engine}`)).runs.map((r: any) => [r.status, r.reason]);
    const untilWaiting = async (pr: Pr) => {
      await until(async () => (await human('GET', pr.base)).author_waiting, 'the author waits');
    };

    try {
      await t.test('published: both reviewers stop, the wait hears only of the publish, and they do not review the commit again', async () => {
        const pr = await stage('feature/cancel-publish', 'cancel-publish.js');
        await ask(pr, 'codex');
        await ask(pr, 'claude');
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await untilWaiting(pr);
        await human('POST', `${pr.base}/publish`, { sign: false, during_review: true });
        const r = await waiting;
        assert.match(r.stdout, /^Published to GitHub: /m);
        assert.match(r.stdout, /^The user is done with this pull request\.$/m);
        await reviewer('codex').settle(pr.id);
        await reviewer('claude').settle(pr.id);
        assert.deepEqual(await runs(pr, 'codex'), [['cancelled', 'published']]);
        assert.deepEqual(await runs(pr, 'claude'), [['cancelled', 'published']]);
        // Done with the head: nothing waits for them.
        const { reviewers } = server.service.readiness(row(pr));
        assert.deepEqual(reviewers.map((x) => [x.status.state, x.status.cancelled]), [['cancelled', 'published'], ['cancelled', 'published']]);
        const page = await pr.page();
        assert.match(page, /title="Review of [0-9a-f]{7} cancelled">[^]*?<span class="agent-chunk">Published<\/span>/);
        assert.match(page, /codex-review<\/a><span class="Label Label--bot">bot<\/span> stopped reviewing <code>[0-9a-f]{7}<\/code> .*?: published/);
        // Turned on afterwards, Codex does not review the commit again when the author waits.
        await human('PATCH', `${pr.base}/reviewers/codex`, { enabled: true });
        assert.equal((await cli(['pr', 'wait', String(pr.number), '--timeout', '1s'])).code, 124);
        assert.equal((await runs(pr, 'codex')).length, 1);
      });

      await t.test('closed here', async () => {
        const pr = await stage('feature/cancel-close', 'cancel-close.js');
        await ask(pr, 'codex');
        // Until Codex has finished reading math.js and runs the diff, which the close cuts short.
        const steps = () => reviewer('codex').live(row(pr))?.progress.steps.map((s) => s.status).join() ?? '';
        await until(() => steps() === 'completed,in_progress', 'Codex has read math.js and runs the diff');
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await untilWaiting(pr);
        await human('PATCH', pr.base, { state: 'closed' });
        const r = await waiting;
        assert.match(r.stdout, /closed .* without publishing it/);
        await reviewer('codex').settle(pr.id);
        assert.deepEqual(await runs(pr, 'codex'), [['cancelled', 'closed']]);
        assert.match(await pr.page(), /title="Review of [0-9a-f]{7} cancelled">[^]*?<span class="agent-chunk">Closed here<\/span>/);
        // Its live box is gone, and its transcript keeps what it did until then, and why it stopped.
        const [{ id: runId }] = (await human('GET', `${pr.base}/reviewers/codex`)).runs;
        const runPath = `/acme/widgets/pull/${pr.number}/runs/${runId}`;
        const html = await pr.page();
        assert.doesNotMatch(html, /js-run-progress/);
        assert.ok(html.includes(`<a class="agent-state" href="${runPath}" title="Review of `), 'the sidebar links to its transcript');
        assert.equal((await fetch(server.url + runPath + '/progress')).status, 204);
        const transcript = await (await fetch(server.url + runPath)).text();
        assert.doesNotMatch(transcript, /data-run-live/);
        assert.match(transcript, /Cancelled \(closed here\) <relative-time/);
        // The read it finished, and the diff it was running, which never finished.
        assert.match(transcript, /Read <a class="run-location"[^>]*><code>math\.js:2<\/code><\/a><\/span> <svg[^>]*octicon-check/);
        assert.match(transcript, /<code class="run-command">git diff HEAD~1 HEAD<\/code><\/span> <svg[^>]*octicon-circle-slash[^>]*aria-label="Did not finish"/);
      });

      await t.test('merged on GitHub, after which it can not be asked for again', async () => {
        const pr = await stage('feature/cancel-merge', 'cancel-merge.js');
        await human('POST', `${pr.base}/publish`, { sign: false });
        // Published, it can still be reviewed, to check an update.
        await ask(pr, 'codex');
        const merged = { state: 'MERGED', mergedAt: '2026-10-16T09:00:00Z', closedAt: '2026-10-16T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: null, timelineItems: { nodes: [] } };
        writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: merged } } }));
        await server.service.followGithub();
        assert.equal(reviewer('codex').atWork(row(pr)), null);
        await reviewer('codex').settle(pr.id);
        assert.deepEqual(await runs(pr, 'codex'), [['cancelled', 'merged']]);
        assert.match(await pr.page(), /title="Review of [0-9a-f]{7} cancelled">[^]*?<span class="agent-chunk">Merged on GitHub<\/span>/);
        const again = await fetch(`${server.url}${pr.base}/reviewers/codex`, { method: 'POST' });
        assert.equal(again.status, 422);
        assert.match((await again.json()).message, /merged on GitHub/);
      });

      await t.test('pushed to: the review of the earlier commit stops, and the waiting author gets one of the new commit', async () => {
        const pr = await stage('feature/cancel-push', 'cancel-push.js', ['--reviewer', 'codex:2']);
        const first = git('rev-parse', 'HEAD');
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await until(() => reviewer('codex').atWork(row(pr))?.status === 'IN_PROGRESS', 'Codex reviews');
        writeFileSync(join(repo, 'cancel-push.js'), 'export const pushed = true;\n');
        git('commit', '-qam', 'Change cancel-push.js');
        const second = git('rev-parse', 'HEAD');
        // The poll finds the push, which cancels the review of the first commit and starts one of the second.
        const reviewing = () => reviewer('codex').atWork(row(pr));
        await until(() => reviewing()?.head_sha === second, 'Codex reviews the second commit');
        writeFileSync(gates.codex, '');
        const r = await waiting;
        assert.match(r.stdout, /codex-review reviewed/);
        await reviewer('codex').settle(pr.id);
        const all = (await human('GET', `${pr.base}/reviewers/codex`)).runs;
        assert.deepEqual(all.map((x: any) => [x.head_sha, x.status, x.reason]), [[first, 'cancelled', 'pushed'], [second, 'done', null]]);
        // The cancelled review did not count.
        const reviews = await human('GET', `${pr.base}/reviews`);
        assert.match(reviews.at(-1).body, /automatic review 1 of 2\./);
      });

      await t.test('pushed to while the author waits for two reviewers: the cancelled one reviews the new commit before the wait returns', async () => {
        for (const gate of Object.values(gates)) rmSync(gate, { force: true });
        const pr = await stage('feature/cancel-both', 'cancel-both.js', ['--reviewer', 'codex', '--reviewer', 'claude']);
        const first = git('rev-parse', 'HEAD');
        const at = (engine: 'codex' | 'claude') => reviewer(engine).atWork(row(pr));
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await until(() => at('codex')?.status === 'IN_PROGRESS' && at('claude')?.status === 'IN_PROGRESS', 'Codex and Claude review');
        // Codex's review of the first commit is in, and the wait waits for Claude's.
        writeFileSync(gates.codex, '');
        await reviewer('codex').settle(pr.id);
        writeFileSync(join(repo, 'cancel-both.js'), 'export const both = true;\n');
        git('commit', '-qam', 'Change cancel-both.js');
        const second = git('rev-parse', 'HEAD');
        await until(() => at('claude')?.head_sha === second, 'Claude reviews the second commit');
        const returned = await Promise.race([waiting.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
        assert.equal(returned, false, 'the wait goes on for Claude');
        writeFileSync(gates.claude, '');
        const r = await waiting;
        assert.match(r.stdout, /codex-review reviewed/);
        assert.match(r.stdout, /claude-review reviewed/);
        await reviewer('claude').settle(pr.id);
        const all = (await human('GET', `${pr.base}/reviewers/claude`)).runs;
        assert.deepEqual(all.map((x: any) => [x.head_sha, x.status, x.reason]), [[first, 'cancelled', 'pushed'], [second, 'done', null]]);
      });

      await t.test('published while a review of a newer commit runs: that review goes on', async () => {
        rmSync(gates.codex, { force: true });
        const pr = await stage('feature/cancel-newer', 'cancel-newer.js');
        const ghGate = join(dir, 'gh-gate');
        try {
          await withFakes({ FAKE_GH_GATE: ghGate }, async () => {
            // Publishing the first commit waits in `gh pr create` while a second is pushed and reviewed.
            const publishing = human('POST', `${pr.base}/publish`, { sign: false });
            const creating = () => readFileSync(join(dir, 'gh.log'), 'utf8').includes('--head feature/cancel-newer');
            await until(creating, 'publishing runs gh pr create');
            writeFileSync(join(repo, 'cancel-newer.js'), 'export const newer = true;\n');
            git('commit', '-qam', 'Change cancel-newer.js');
            const newer = git('rev-parse', 'HEAD');
            await until(() => row(pr).head_sha === newer, 'the server has the second commit');
            await ask(pr, 'codex');
            writeFileSync(ghGate, '');
            assert.equal((await publishing).staging_state, 'published');
          });
        } finally {
          rmSync(ghGate, { force: true });
        }
        assert.equal(reviewer('codex').headStatus(row(pr)).state, 'reviewing');
        writeFileSync(gates.codex, '');
        await reviewer('codex').settle(pr.id);
        assert.deepEqual(await runs(pr, 'codex'), [['done', null]]);
      });

      await t.test('closed while its review is being posted: nothing is posted, and it stays cancelled', async () => {
        rmSync(gates.codex, { force: true });
        const pr = await stage('feature/cancel-posting', 'cancel-posting.js');
        await ask(pr, 'codex');
        // Codex has answered, and galley is placing its comments when the pull request is closed.
        const createReview = server.service.createReview;
        server.service.createReview = async (...args: Parameters<Service['createReview']>) => {
          await human('PATCH', pr.base, { state: 'closed' });
          return createReview.apply(server.service, args);
        };
        try {
          writeFileSync(gates.codex, '');
          await reviewer('codex').settle(pr.id);
        } finally {
          server.service.createReview = createReview;
        }
        assert.deepEqual(await runs(pr, 'codex'), [['cancelled', 'closed']]);
        assert.deepEqual(await human('GET', `${pr.base}/reviews`), []);
      });
    } finally {
      for (const gate of Object.values(gates)) rmSync(gate, { force: true });
      rmSync(join(dir, 'gh-pulls.json'), { force: true });
    }
  });
});

test('pr create --reviewer and --no-review decide Codex reviews for that pull request', async (t) => {
  await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }) }, async () => {
    const branch = (name: string, file: string) => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', name);
      writeFileSync(join(repo, file), 'export {};\n');
      git('add', file);
      git('commit', '-qm', `Add ${file}`);
    };
    const create = (args: string[]) => cli(['pr', 'create', '--title', 'Review options', '--body', 'x', ...args]);
    const numberOf = (r: { stdout: string }) => Number(r.stdout.trim().split('/').pop());
    const api = (n: number) => `/api/repos/acme/widgets/pulls/${n}`;
    const page = async (n: number) => (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text();
    const authorWaiting = async (n: number) => {
      await until(async () => (await human('GET', api(n))).author_waiting, 'the author waits');
    };
    /** What Codex reports the moment it starts deciding about the pull request, as when its author waits. */
    const considered = async (n: number) => {
      const { id } = await human('GET', api(n));
      const codex = server.service.codex!;
      codex.consider(id);
      return codex.atWork(server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id));
    };

    await t.test('--reviewer codex:2 gets two reviews when automatic reviews are off in settings', async () => {
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      branch('feature/two-loops', 'two.js');
      // Repeated and comma-separated, as in gh; logins without a reviewer agent are ignored.
      const r = await create(['-r', 'octocat,codex:2', '--reviewer', 'alice']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /Ignored reviewer octocat: galley has no reviewer agent by that name/);
      assert.match(r.stderr, /Ignored reviewer alice/);
      assert.match(r.stderr, /^When you wait, codex-review reviews the code\.$/m);
      const n = numberOf(r);
      const { enabled, max_iterations, overrides } = await human('GET', `${api(n)}/reviewers/codex`);
      assert.deepEqual({ enabled, max_iterations, overrides }, { enabled: true, max_iterations: 2, overrides: { enabled: true, max_iterations: 2 } });
      const html = await page(n);
      assert.match(html, /data-field="enabled">Follow Settings<span class="dropdown-item-desc">Off in Settings<\/span>/);
      assert.match(html, /<span class="agent-chunk">Automatic: 0 of 2<\/span>/);
      assert.match(html, /class="codex-limit"[^>]*data-limit="2"/);
      // Queued as soon as Codex considers it, although automatic reviews are off in settings.
      assert.equal((await considered(n))?.status, 'QUEUED');
      for (const i of [1, 2]) {
        const w = await cli(['pr', 'wait', String(n), '--timeout', '20s']);
        assert.equal(w.code, 0, w.stderr);
        assert.match(w.stdout, new RegExp(`automatic review ${i} of 2`));
        writeFileSync(join(repo, 'two.js'), `export const n = ${i};\n`);
        git('commit', '-qam', `Change two.js (${i})`);
      }
      const capped = await cli(['pr', 'wait', String(n), '--timeout', '2s']);
      assert.equal(capped.code, 0, capped.stderr);
      assert.match(capped.stdout, /\(codex-review used 2 of 2 automatic reviews\); ask the user to review it/);
      assert.equal((await human('GET', `${api(n)}/reviewers/codex`)).runs.length, 2);
    });

    await t.test('--reviewer codex follows the limit in settings, raised while the author waits', async () => {
      await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 1 });
      branch('feature/settings-limit', 'limit.js');
      const r = await create(['--reviewer', 'codex']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /^When you wait, codex-review reviews the code\.$/m);
      const n = numberOf(r);
      const first = await cli(['pr', 'wait', String(n), '--timeout', '20s']);
      assert.equal(first.code, 0, first.stderr);
      assert.match(first.stdout, /automatic review 1 of 1/);
      writeFileSync(join(repo, 'limit.js'), 'export const n = 1;\n');
      git('commit', '-qam', 'Change limit.js');
      // Codex finds the cap reached, so the reviewer agents are done with the new commit.
      assert.match(await handedOver(n), /codex-review used 1 of 1 automatic reviews/);
      const waiting = cli(['pr', 'wait', String(n), '--timeout', '20s']);
      await authorWaiting(n);
      assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).runs.length, 1);
      await human('PUT', '/api/settings/codex', { maxIterations: 2 });
      const second = await waiting;
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /automatic review 2 of 2/);
      await human('PUT', '/api/settings/codex', { maxIterations: 3 });
    });

    await t.test('--no-review gets no reviews when automatic reviews are on in settings', async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      branch('feature/no-review', 'none.js');
      const r = await create(['--no-review']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /^No reviewer agent reviews it\.$/m);
      const n = numberOf(r);
      assert.match(await handedOver(n), /^No reviewer agent reviews /);
      assert.equal(await considered(n), null, 'nothing queued, although automatic reviews are on in settings');
      const config = await human('GET', `${api(n)}/reviewers/codex`);
      assert.deepEqual(config.runs, []);
      assert.equal(config.enabled, false);
      assert.equal(config.overrides.enabled, false);
      const html = await page(n);
      assert.match(html, /<span class="agent-state" title="Off for this pull request"><span>Off<\/span><\/span>/);
      assert.match(html, /data-field="enabled">Follow Settings<span class="dropdown-item-desc">On in Settings<\/span>/);
      assert.match(html, /js-codex-reset"[^>]* data-field="enabled"/);
      // Back to the setting (the page's reset) while the author waits: Codex starts at once.
      const resumed = cli(['pr', 'wait', String(n), '--timeout', '20s']);
      await authorWaiting(n);
      const reset = await human('PATCH', `${api(n)}/reviewers/codex`, { enabled: null });
      assert.deepEqual(reset, { enabled: true, max_iterations: 3, overrides: { enabled: null, max_iterations: null } });
      const second = await resumed;
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /codex-review reviewed: commented/);
    });

    await t.test('without either flag, the setting decides', async () => {
      await human('PUT', '/api/settings/codex', { enabled: false });
      branch('feature/default-review', 'default.js');
      const r = await create([]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /^No reviewer agent reviews it\.$/m);
      const n = numberOf(r);
      assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).overrides, { enabled: null, max_iterations: null });
      assert.match(await handedOver(n), /^No reviewer agent reviews /);
      assert.deepEqual((await human('GET', `${api(n)}/reviewers/codex`)).runs, []);
      assert.doesNotMatch(await page(n), /for this pull request/);
      // Turned on in Settings while the author waits, Codex reviews this one too.
      const waiting = cli(['pr', 'wait', String(n), '--timeout', '20s']);
      await authorWaiting(n);
      await human('PUT', '/api/settings/codex', { enabled: true });
      const w = await waiting;
      assert.equal(w.code, 0, w.stderr);
      assert.match(w.stdout, /codex-review reviewed: commented/);
      await human('PUT', '/api/settings/codex', { enabled: false });
    });

    await t.test('on with a limit of 0, it reviews nothing on its own, and galley reviewers and pr create say so', async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 0 });
      try {
        const list = await cli(['reviewers', '--json', 'name,automatic,limit']);
        assert.deepEqual(JSON.parse(list.stdout)[0], { name: 'codex-review', automatic: false, limit: 0 });
        branch('feature/limit-zero', 'zero.js');
        const r = await create([]);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stderr, /^No reviewer agent reviews it\.$/m);
      } finally {
        await human('PUT', '/api/settings/codex', { enabled: false, maxIterations: 3 });
      }
    });

    await t.test('flags that cannot work stage nothing', async () => {
      branch('feature/refused', 'refused.js');
      const bad = await create(['-r', 'codex:two']);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /invalid reviewer "codex:two"/);
      const both = await create(['--no-review', '-r', 'codex:2']);
      assert.equal(both.code, 1);
      assert.match(both.stderr, /codex was asked to review, but automatic reviews are turned off/);
      const tooMany = await create(['-r', 'codex:99']);
      assert.equal(tooMany.code, 1);
      assert.match(tooMany.stderr, /from 0 to 20/);
      assert.deepEqual(await human('GET', '/api/repos/acme/widgets/pulls?state=all&head=feature/refused'), []);
    });

    await t.test('the API takes logins as GitHub does, and turns every reviewer agent on or off', async () => {
      const post = async (body: object) => {
        const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
          body: JSON.stringify({ title: 'Through the API', head: 'feature/refused', base: 'main', ...body }),
        });
        assert.equal(res.status, 201);
        const pr = await res.json();
        const config = await human('GET', `${api(pr.number)}/reviewers/codex`);
        await human('DELETE', api(pr.number));
        return { pr, config };
      };
      const byLogin = await post({ reviewers: ['Codex', 'octocat'] });
      assert.deepEqual(byLogin.pr.ignored_reviewers, ['octocat']);
      assert.deepEqual(byLogin.config.overrides, { enabled: true, max_iterations: null });
      assert.deepEqual((await post({ automatic_reviews: true })).config.overrides, { enabled: true, max_iterations: null });
      const plain = await post({});
      assert.equal(plain.pr.ignored_reviewers, undefined);
      assert.deepEqual(plain.config.overrides, { enabled: null, max_iterations: null });
    });
  });
});

test('findings the author answers without a new commit: the reviewer agents are done with it, and the reviewer has it', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/answered');
  writeFileSync(join(repo, 'answered.js'), 'export const value = 1;\n');
  git('add', 'answered.js');
  git('commit', '-qm', 'Add answered.js');
  const created = await cli(['pr', 'create', '--title', 'Add answered.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  const review = { summary: 'One thing.', comments: [{ path: 'answered.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it.' }] };
  await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      assert.match((await cli(['pr', 'wait', String(number), '--timeout', '20s'])).stdout, /codex-review reviewed: commented/);
      await server.service.codex!.settle(id);
      // Unanswered, the finding holds the reviewer agents up: no wait says they are done, and one that times out says why.
      const held = await cli(['pr', 'wait', String(number), '--timeout', '2s']);
      assert.equal(held.code, 124);
      assert.match(held.stderr, new RegExp(`^codex-review commented on ${sha()}: reply to or resolve each of its threads, or push a commit\\. The reviewer agents are not done with it until then\\.$`, 'm'));
      // Its row in the sidebar: what it found, and whether it is answered (as GitHub marks a reviewer, a check is for an approval).
      const agentState = async () => (await (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text()).match(/<li class="agent" id="agent-codex">[^]*?(<a class="agent-state"[^>]*>[^]*?<\/a>)/)![1];
      assert.match(await agentState(), new RegExp(`title="Found 1 problem in ${sha()}; agent has not answered it"><svg class="octicon octicon-comment color-fg-attention"[^>]*>[^]*?</svg><span>1 finding · <code>${sha()}</code></span>`));

      // Answered without a new commit: Codex reviews each commit once, so it has nothing more to say.
      const [thread] = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewThreads'])).stdout).reviewThreads;
      assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(thread.databaseId), '--resolve', '-b', 'The name says what it is.'])).code, 0);
      const answered = `codex-review's findings in ${sha()} are answered`;
      assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(${answered}\\); ask the user to review it: `, 'm'));
      const { turn } = await human('GET', base);
      assert.equal(turn.whose, 'reviewer');
      assert.ok(turn.reasons.some((r: any) => r.kind === 'reviewer_agent' && r.state === 'answered' && r.text === answered), JSON.stringify(turn.reasons));
      assert.match(await agentState(), new RegExp(`title="Found 1 problem in ${sha()}; agent answered it"><svg class="octicon octicon-comment color-fg-muted"[^>]*>[^]*?</svg><span>Answered · <code>${sha()}</code></span>`));
      // The list says it shorter, in full as its tooltip.
      assert.match(await (await fetch(`${server.url}/`)).text(), new RegExp(`<span class="turn-reason" title="${answered.replace("'", '&#39;')}">codex-review&#39;s findings answered</span>`));

      // A new commit still gets a review of its own.
      writeFileSync(join(repo, 'answered.js'), 'export const answer = 1;\n');
      git('commit', '-qam', 'Rename the value');
      const fine = await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine now.', comments: [] }) }, () => cli(['pr', 'wait', String(number), '--timeout', '20s']));
      assert.match(fine.stdout, /Fine now\./);
      assert.equal((await human('GET', `${base}/reviewers/codex`)).runs.length, 2);
      assert.match(await agentState(), new RegExp(`title="Found nothing in ${sha()}"><svg class="octicon octicon-check color-fg-muted"[^>]*>[^]*?</svg><span>No findings · <code>${sha()}</code></span>`));
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
    }
  });
});

test("a comment after the author's reply in a reviewer agent's thread waits for the author: the findings are not answered until it answers again", async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/answered-again');
  writeFileSync(join(repo, 'again.js'), 'export const value = 1;\n');
  git('add', 'again.js');
  git('commit', '-qm', 'Add again.js');
  const created = await cli(['pr', 'create', '--title', 'Add again.js', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  const reply = async (thread: number, body: string) => assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(thread), '-b', body])).code, 0);
  process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'One thing.', comments: [{ path: 'again.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it.' }] });
  await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
  try {
    assert.match((await cli(['pr', 'wait', String(number), '--timeout', '20s'])).stdout, /codex-review reviewed: commented/);
    await server.service.codex!.settle(id);
    const thread = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewThreads'])).stdout).reviewThreads[0].databaseId;
    await reply(thread, 'The name says what it is.');
    await human('POST', `${base}/comments/${thread}/replies`, { body: 'It does not say what it counts.' });
    const told = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
    assert.match(told.stdout, /It does not say what it counts\./);
    assert.match(told.stdout, /^Address the feedback\./m);
    // Seen and not answered: Codex's findings are not answered either, so no wait says the reviewer agents are done.
    const held = await cli(['pr', 'wait', String(number), '--timeout', '1s']);
    assert.equal(held.code, 124, held.stdout);
    assert.match(held.stderr, new RegExp(`^codex-review commented on ${sha()}: reply to or resolve each of its threads, or push a commit\\.`, 'm'));
    await reply(thread, 'It counts nothing; it is the value.');
    assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(codex-review's findings in ${sha()} are answered\\); `, 'm'));

    // The user's approval without comments asks nothing, as it does for the turn: with the thread answered, open or not, nothing is left to address.
    await human('POST', `${base}/reviews`, { event: 'APPROVE' });
    const approved = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
    assert.match(approved.stdout, new RegExp(`^Unresolved threads: ${thread}$`, 'm'));
    assert.match(approved.stdout, new RegExp(`^Nothing to address\\. Run \`galley pr wait s${number}\` again\\.$`, 'm'));
  } finally {
    await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
    await human('PATCH', base, { state: 'closed' });
  }
});

test('a reviewer agent is told what its earlier reviews found, resolved or not, and the commit it left off at', async () => {
  // On a base of its own, which can move on without moving main under the other tests.
  git('checkout', '-q', 'main');
  git('branch', 'history-base');
  git('checkout', '-qb', 'feature/history');
  writeFileSync(join(repo, 'history.js'), 'export const value = 1;\n');
  git('add', 'history.js');
  git('commit', '-qm', 'Add history.js');
  const created = await cli(['pr', 'create', '--title', 'Add history.js', '--body', 'x', '--base', 'history-base', '--reviewer', 'codex:3']);
  assert.equal(created.code, 0, created.stderr);
  const n = created.stdout.trim().split('/').pop()!;
  const calls = () => (existsSync(process.env.FAKE_CODEX_LOG!) ? readFileSync(process.env.FAKE_CODEX_LOG!, 'utf8').trim().split('\n') : []);
  /** The prompt of the review the author's wait brings, which answers `review`. */
  const reviewed = (review: object) =>
    withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async (): Promise<string> => {
      const before = calls().length;
      const r = await cli(['pr', 'wait', n, '--timeout', '20s']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /codex-review reviewed: commented/);
      assert.equal(calls().length, before + 1);
      return JSON.parse(calls().at(-1)!).prompt;
    });
  const first = await reviewed({
    summary: 'Three things.',
    comments: [
      { path: 'history.js', line: 1, start_line: null, side: 'RIGHT', priority: 'medium', body: 'Name it.' },
      { path: 'history.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Add a test.' },
      { path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' },
    ],
  });
  assert.doesNotMatch(first, /Your last review|earlier reviews of this pull request/);
  const firstSha = git('rev-parse', 'HEAD');

  // The author fixes one finding and resolves its thread, and answers the other without resolving it.
  const threads = JSON.parse((await cli(['pr', 'view', n, '--json', 'reviewThreads'])).stdout).reviewThreads;
  writeFileSync(join(repo, 'history.js'), 'export const answer = 1;\n');
  git('commit', '-qam', 'Name the value');
  assert.equal((await cli(['pr', 'comment', n, '--reply-to', String(threads[0].databaseId), '--resolve', '-b', 'Renamed it.'])).code, 0);
  assert.equal((await cli(['pr', 'comment', n, '--reply-to', String(threads[1].databaseId), '-b', 'Out of scope.'])).code, 0);
  const oneMore = { summary: 'Fine now.', comments: [{ path: 'history.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'One more.' }] };
  const second = await reviewed(oneMore);
  assert.match(second, /Check that each resolved comment was really fixed, and comment again only on one that was not/);
  assert.match(
    second,
    new RegExp(
      `Your last review, of ${firstSha.slice(0, 7)}, said: Three things\\.\n- history\\.js:1 \\(outdated\\) \\[resolved by agent\\]\n  codex-review: Name it\\.\n  agent: Renamed it\\.\n- history\\.js:1 \\(outdated\\) \\[open\\]\n  codex-review: Add a test\\.\n  agent: Out of scope\\.\nIts comments outside threads, which nobody resolves:\n- \`math\\.js:1\` \\(low priority\\): Not in this diff\\.\n`,
    ),
  );
  assert.match(second, new RegExp(`\nYou last reviewed ${firstSha}\\. Run \`git diff ${firstSha} HEAD\` to see what changed since\\.\n`));
  // Its own open thread is among its earlier reviews, not among the others' threads.
  assert.doesNotMatch(second, /Open review threads/);

  // Rebased onto a newer base, the commit it last reviewed is no starting point.
  const secondSha = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'history-base');
  writeFileSync(join(repo, 'history-base.js'), 'export {};\n');
  git('add', 'history-base.js');
  git('commit', '-qm', 'Add history-base.js');
  git('checkout', '-q', 'feature/history');
  git('rebase', '-q', 'history-base');
  const third = await reviewed(oneMore);
  assert.match(third, new RegExp(`\nYou last reviewed ${secondSha}, but the branch has been rebased onto a newer base since, so a diff from it would show the base's changes too: review the whole change\\.\n`));
  assert.doesNotMatch(third, new RegExp(`git diff ${secondSha}`));
  assert.match(third, new RegExp(`Your last review, of ${secondSha.slice(0, 7)}, said: Fine now\\.\n- history\\.js:1 \\[open\\]\n  codex-review: One more\\.\n`));
  assert.match(third, new RegExp(`Comments of your reviews before that, a line each:\n- ${firstSha.slice(0, 7)} history\\.js:1 \\(outdated\\) \\[resolved by agent\\]: Name it\\.\n- ${firstSha.slice(0, 7)} history\\.js:1 \\(outdated\\) \\[open\\]: Add a test\\.\n- ${firstSha.slice(0, 7)} \`math\\.js:1\` \\(low priority\\): Not in this diff\\.\n`));
});

test('auto-publish publishes once the agents are done', async (t) => {
  /** Stage a branch with one commit, as the agent. */
  const stage = async (branch: string, file: string, ...args: string[]) => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), `export const value = 1;\n`);
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', ...args]);
    assert.equal(created.code, 0, created.stderr);
    const number = Number(created.stdout.trim().split('/').pop());
    const base = `/api/repos/acme/widgets/pulls/${number}`;
    return {
      number,
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      timeline: (): Promise<any[]> => human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`),
      created: () => new RegExp(`^pr create .* --head ${branch} `, 'm').test(readFileSync(join(dir, 'gh.log'), 'utf8')),
    };
  };
  const untilWaiting = async (base: string) => {
    await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
  };
  const defaults = { enabled: false, model: '', effort: '', maxIterations: 3 };
  const comment = (number: number, body: string) => human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body });
  /** Make signing wait for a gate, as it would for a passphrase or a 1Password prompt. */
  const gateSigning = () => {
    const signing = join(dir, 'signing');
    const gate = join(dir, 'sign-gate');
    const program = join(dir, 'gated-ssh-keygen');
    const reset = () => {
      rmSync(signing, { force: true });
      rmSync(gate, { force: true });
    };
    reset();
    writeFileSync(program, `#!/bin/sh\ntouch "${signing}"\nwhile [ ! -f "${gate}" ]; do sleep 0.02; done\nexec ssh-keygen "$@"\n`);
    chmodSync(program, 0o755);
    git('config', 'gpg.ssh.program', program);
    return {
      started: () => existsSync(signing),
      open: () => writeFileSync(gate, ''),
      reset,
      restore: () => {
        git('config', '--unset', 'gpg.ssh.program');
        reset();
      },
    };
  };

  await t.test('after the last automatic review is answered', async () => {
    const pr = await stage('feature/auto', 'auto.js');
    const review = {
      summary: 'Two things.',
      comments: [
        { path: 'auto.js', line: 1, start_line: null, side: 'RIGHT', priority: 'medium', body: 'Name it after what it is.' },
        { path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' },
      ],
    };
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 1 });
      try {
        assert.match(await pr.page(), /<button type="submit" class="btn" data-api="[^"]*\/auto-publish" data-method="PUT"[^>]*>.*Publish when reviews are done<\/button>/);
        // Only the reviewer can turn it on, as only the reviewer can publish.
        const agent = await cli(['pr', 'publish', String(pr.number), '--auto']);
        assert.equal(agent.code, 1);
        assert.match(agent.stderr, /only the user can turn on auto-publish/);
        const on = await cli(['pr', 'publish', String(pr.number), '--auto'], { actor: 'reviewer' });
        assert.equal(on.code, 0, on.stderr);
        assert.match(on.stderr, new RegExp(`Pull request acme/widgets s#${pr.number} will be published when the reviewer agents are done`));
        assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-publish:\tenabled\treviewer$/m);
        const { autoPublishRequest } = JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoPublishRequest'])).stdout);
        assert.deepEqual(
          { ...autoPublishRequest, enabledAt: undefined },
          { enabledAt: undefined, enabledBy: { login: 'reviewer', is_bot: false }, sign: true, draft: false, force: false, autoMerge: null },
        );

        // Codex's review wakes the agent, and nothing is published until the agent has answered it.
        const first = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(first.code, 0, first.stderr);
        assert.match(first.stdout, /codex-review reviewed: commented/);
        // Findings on lines outside the diff, which only the review's body carries, count too.
        assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs.map((r: any) => r.findings), [2]);
        assert.match(first.stdout, /Auto-publish is on \(reviewer turned it on\): galley publishes this pull request once the reviewer agents are done/);
        assert.equal(pr.created(), false);
        const box = await pr.page();
        assert.match(box, /<strong>Auto-publish is on<\/strong>/);
        assert.match(box, /codex-review has used up its automatic reviews/);
        assert.match(box, /agent is working \(not waiting for review\)/);
        assert.match(box, /js-auto-publish-cancel/);
        assert.doesNotMatch(box, /Publish when reviews are done/);

        // The agent fixes it and waits again. Codex has used its one review, so galley publishes the new commit.
        writeFileSync(join(repo, 'auto.js'), 'export const answer = 1;\n');
        git('commit', '-qam', 'Name the value');
        const second = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(second.code, 0, second.stderr);
        assert.match(second.stdout, /Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7/);
        assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr create --repo acme\/widgets --base main --head feature\/auto --title Add auto\.js --body-file -$/m);
        const published = (await pr.timeline()).findLast((e) => e.event === 'published');
        assert.equal(published.auto, true);
        assert.equal(published.source, git('rev-parse', 'HEAD'));
        assert.equal(published.signed, 2);
        // It approved the first publish only: the commits after it are pushed when the agent waits.
        assert.equal((await human('GET', pr.base)).auto_publish, null);
        const after = await pr.page();
        assert.match(after, /published this pull request to <a [^>]*>acme\/widgets#7<\/a> at <code>[0-9a-f]{7}<\/code> \(signed 2 commits\) with auto-publish/);
        assert.doesNotMatch(after, /Auto-publish is on|Publish when reviews are done/);
        assert.match(second.stdout, /It is published: commit and wait, and galley pushes each commit you wait with to GitHub\. Never push to GitHub yourself\./);
        const refused = await fetch(`${server.url}${pr.base}/auto-publish`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(refused.status, 422);
      } finally {
        await human('PUT', '/api/settings/codex', defaults);
      }
    });
  });

  await t.test('after the agent answers every thread without a new commit, which Codex would wait for', async () => {
    const pr = await stage('feature/auto-answered', 'answered-auto.js');
    const review = {
      summary: 'Two things.',
      comments: [
        { path: 'answered-auto.js', line: 1, start_line: null, side: 'RIGHT', priority: 'medium', body: 'Name it after what it is.' },
        { path: 'answered-auto.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Export a function.' },
      ],
    };
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      try {
        await human('PUT', `${pr.base}/auto-publish`, {});
        assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /codex-review reviewed: commented/);
        const sha = git('rev-parse', '--short=7', 'HEAD');
        const [first, second] = JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'reviewThreads'])).stdout).reviewThreads.map((th: any) => th.databaseId);

        // One thread answered and resolved, the other not: it waits for the other.
        assert.equal((await cli(['pr', 'comment', String(pr.number), '--reply-to', String(first), '--resolve', '-b', 'It is named after what it is.'])).code, 0);
        assert.equal((await cli(['pr', 'wait', String(pr.number), '--timeout', '2s'])).code, 124);
        assert.equal(pr.created(), false);
        assert.match(await pr.page(), new RegExp(`codex-review found problems in <code>${sha}</code>, and reviews the commit that addresses them`));

        // A reply answers a thread left open too.
        assert.equal((await cli(['pr', 'comment', String(pr.number), '--reply-to', String(second), '-b', 'Out of scope: a constant is what callers need.'])).code, 0);
        assert.match(await pr.page(), new RegExp(`<svg [^>]*octicon-check[^>]*>.*?</svg> <span>codex-review's findings in <code>${sha}</code> are answered</span>`));
        const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(done.code, 0, done.stderr);
        assert.match(done.stdout, /Published to GitHub/);
        assert.equal(pr.created(), true);
        assert.equal((await human('GET', `${pr.base}/reviewers/codex`)).runs.length, 1);
      } finally {
        await human('PUT', '/api/settings/codex', defaults);
      }
    });
  });

  await t.test('after the agent has seen findings that are all outside the diff, which have no thread to answer in', async () => {
    const pr = await stage('feature/auto-outside', 'outside.js');
    const review = { summary: 'One thing.', comments: [{ path: 'math.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Not in this diff.' }] };
    await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      try {
        await human('PUT', `${pr.base}/auto-publish`, {});
        const first = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.match(first.stdout, /Not in this diff\./);
        assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs.map((r: any) => r.findings), [1]);
        const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(done.code, 0, done.stderr);
        assert.match(done.stdout, /Published to GitHub/);
        assert.equal(pr.created(), true);
      } finally {
        await human('PUT', '/api/settings/codex', defaults);
      }
    });
  });

  await t.test('not while Codex reviews, and after a review that finds nothing', async () => {
    const pr = await stage('feature/auto-clean', 'clean.js');
    const gate = join(dir, 'auto-gate');
    await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Looks right.', comments: [] }) }, async () => {
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      try {
        await human('PUT', `${pr.base}/auto-publish`, {});
        const codex = server.service.codex!;
        const pull = await human('GET', pr.base);
        const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pull.id);
        const reviewed = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        await until(() => codex.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
        await untilWaiting(pr.base);
        // The agent waits and nothing else is open, but Codex is at work.
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(pr.created(), false);
        assert.match(await pr.page(), new RegExp(`codex-review is reviewing <code>${git('rev-parse', '--short=7', 'HEAD')}</code>`));
        writeFileSync(gate, '');
        assert.match((await reviewed).stdout, /Looks right\./);
        // Codex found nothing in the head; once the agent has seen that and waits, it is published.
        const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
        assert.equal(done.code, 0, done.stderr);
        assert.match(done.stdout, /Published to GitHub/);
        assert.equal(pr.created(), true);
      } finally {
        rmSync(gate, { force: true });
        await human('PUT', '/api/settings/codex', defaults);
      }
    });
  });

  await t.test('without waiting for Codex when the pull request was staged with --no-review', async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      const pr = await stage('feature/auto-no-review', 'no-review.js', '--no-review');
      await human('PUT', `${pr.base}/auto-publish`, {});
      assert.match(await pr.page(), /codex-review does not review this pull request automatically/);
      // Codex reviews automatically in settings, but not this pull request: the author waiting is enough.
      const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Published to GitHub/);
      assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs, []);
      assert.equal((await pr.timeline()).findLast((e) => e.event === 'published').auto, true);
    } finally {
      await human('PUT', '/api/settings/codex', defaults);
    }
  });

  await t.test('held up by a failed review until it is cancelled, and turned off by a close, a change request or a new base', async () => {
    const pr = await stage('feature/auto-failed', 'failed.js');
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
        await human('PUT', `${pr.base}/auto-publish`, {});
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '3s']);
        await until(async () => (await human('GET', `${pr.base}/reviewers/codex`)).runs.some((r: any) => r.status === 'failed'), "Codex's review fails");
        // A failed review is no feedback for the agent, and it stops auto-publish from going ahead.
        assert.equal((await waiting).code, 124);
        assert.equal(pr.created(), false);
        assert.match(await pr.page(), new RegExp(`codex-review's review of <code>${git('rev-parse', '--short=7', 'HEAD')}</code> failed\\. Ask it to review again, or publish by hand\\.`));
        const agent = await cli(['pr', 'publish', String(pr.number), '--disable-auto']);
        assert.equal(agent.code, 1);
        const off = await cli(['pr', 'publish', String(pr.number), '--disable-auto'], { actor: 'reviewer' });
        assert.equal(off.code, 0, off.stderr);
        assert.match(off.stderr, new RegExp(`Auto-publish disabled for pull request acme/widgets s#${pr.number}`));
        assert.equal((await human('GET', pr.base)).auto_publish, null);
        assert.equal((await pr.timeline()).findLast((e) => e.event === 'auto_publish_disabled').reason, 'cancelled');
      });
    } finally {
      await human('PUT', '/api/settings/codex', defaults);
    }

    // The agent editing the title leaves it on; the reviewer's own change request, a new base and a close turn it off.
    await human('PUT', `${pr.base}/auto-publish`, {});
    assert.equal((await cli(['pr', 'edit', String(pr.number), '--title', 'Add failed.js, renamed'])).code, 0);
    assert.ok((await human('GET', pr.base)).auto_publish);
    const turnOffs: [string, () => Promise<unknown>][] = [
      ['changes_requested', () => human('POST', `${pr.base}/reviews`, { event: 'REQUEST_CHANGES', body: 'Not like this.' })],
      ['base_changed', () => human('PATCH', pr.base, { base: 'feature/mul' })],
      ['closed', () => human('PATCH', pr.base, { state: 'closed' })],
    ];
    for (const [reason, change] of turnOffs) {
      await human('PUT', `${pr.base}/auto-publish`, {});
      await change();
      assert.equal((await human('GET', pr.base)).auto_publish, null, reason);
      assert.equal((await pr.timeline()).findLast((e) => e.event === 'auto_publish_disabled').reason, reason);
    }
    assert.match(await pr.page(), /disabled auto-publish by closing the pull request/);
  });

  await t.test('checks again after signing, which can wait for a prompt', async () => {
    const pr = await stage('feature/auto-sign', 'sign.js');
    const signing = gateSigning();
    const signedCopy = () => git('for-each-ref', '--format=%(objectname)', `refs/galley/${server.service.db.instance}/pull/${pr.number}/published`);
    try {
      // Cancelled while signing waits: nothing is pushed.
      await human('PUT', `${pr.base}/auto-publish`, {});
      const cancelled = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(signing.started, 'signing started');
      await human('DELETE', `${pr.base}/auto-publish`);
      signing.open();
      await until(() => signedCopy() !== '', 'signing finished');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(pr.created(), false);
      assert.throws(() => execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/auto-sign'], { stdio: 'ignore' }));
      // Without auto-publish, the reviewer agents being done with the commit makes it the reviewer's to review.
      assert.match((await cancelled).stdout, /^No reviewer agent reviews .*; ask the user to review it: /);
      await comment(pr.number, 'Hold on.');
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Hold on\./);

      // Feedback while signing waits: it reaches the agent first, and the next wait publishes.
      signing.reset();
      writeFileSync(join(repo, 'sign.js'), 'export const value = 2;\n');
      git('commit', '-qam', 'Change the value');
      const before = signedCopy();
      await human('PUT', `${pr.base}/auto-publish`, {});
      const fed = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(signing.started, 'signing started again');
      await comment(pr.number, 'One more thing.');
      signing.open();
      assert.match((await fed).stdout, /One more thing\./);
      await until(() => signedCopy() !== before, 'signing finished again');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(pr.created(), false);
      const done = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(done.stdout, /Published to GitHub/);
    } finally {
      signing.restore();
    }
  });

  await t.test('an attempt stops when its approval is replaced, and the new approval publishes', async () => {
    const pr = await stage('feature/auto-replace', 'replace.js');
    const signing = gateSigning();
    try {
      await human('PUT', `${pr.base}/auto-publish`, { draft: false });
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(signing.started, 'signing started');
      // Turned off and on again, now as a draft, while the first attempt signs. Turned off, it is
      // the reviewer's to review, and the agent hears so; the new approval publishes when it waits again.
      await human('DELETE', `${pr.base}/auto-publish`);
      assert.match((await waiting).stdout, /ask the user to review it/);
      await human('PUT', `${pr.base}/auto-publish`, { draft: true });
      signing.open();
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Published to GitHub/);
      // Published once, with the options of the approval in force: as a draft.
      const creates = readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l.startsWith('pr create ') && l.includes(' --head feature/auto-replace '));
      assert.equal(creates.length, 1);
      assert.match(creates[0], / --draft$/);
    } finally {
      signing.restore();
    }
  });

  await t.test("a stale attempt's failure leaves a newer approval on", async () => {
    const pr = await stage('feature/auto-stale', 'stale.js');
    const { id } = await human('GET', pr.base);
    const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
    await human('PUT', `${pr.base}/auto-publish`, { draft: false });
    const first = row().auto_publish;
    await human('PUT', `${pr.base}/auto-publish`, { draft: true });
    const second = row().auto_publish;
    assert.notEqual(first, second);
    server.service.autoPublishFailed(row(), server.service.viewer(), 'from the first approval', first);
    assert.equal(row().auto_publish, second);
    assert.equal((await pr.timeline()).some((e) => e.event === 'auto_publish_failed'), false);
    server.service.autoPublishFailed(row(), server.service.viewer(), 'from the second approval', second);
    assert.equal(row().auto_publish, null);
    assert.equal((await pr.timeline()).findLast((e) => e.event === 'auto_publish_failed').error, 'from the second approval');
  });

  await t.test('a cancel while the force-push lease is looked up stops the push', async () => {
    const pr = await stage('feature/auto-lease', 'lease.js');
    // On GitHub before its first publish, then rewritten: publishing force-pushes with a lease.
    git('push', '-q', 'origin', 'feature/auto-lease');
    const theirs = git('rev-parse', 'HEAD');
    git('commit', '-q', '--amend', '-m', 'Add lease.js, reworded');
    await until(async () => (await human('GET', pr.base)).head.sha === git('rev-parse', 'HEAD'), 'the rewrite is recorded');
    // Hold publish's look-up of the branch on GitHub, which decides force and the lease (not the page's).
    const resolve = Repo.prototype.resolve;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let holding = false;
    Repo.prototype.resolve = async function (this: Repo, ref: string) {
      if (ref === 'refs/remotes/origin/feature/auto-lease' && /at (async )?Service\.publish \(/.test(new Error().stack ?? '')) {
        holding = true;
        await held;
      }
      return resolve.call(this, ref);
    };
    try {
      await human('PUT', `${pr.base}/auto-publish`, { force: true });
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await until(() => holding, 'the lease is being looked up');
      await human('DELETE', `${pr.base}/auto-publish`);
      release();
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/auto-lease'], { encoding: 'utf8' }).trim(), theirs);
      assert.equal(pr.created(), false);
      assert.match((await waiting).stdout, /ask the user to review it/);
      await comment(pr.number, 'Not yet.');
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Not yet\./);
    } finally {
      Repo.prototype.resolve = resolve;
      release();
    }
  });

  await t.test('only the author waiting counts', async () => {
    // Should a review start, it waits for this gate and never finishes.
    const gate = join(dir, 'observer-gate');
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      await withFakes({ FAKE_CODEX_GATE: gate }, async () => {
        const pr = await stage('feature/auto-observer', 'observer.js');
        await human('PUT', `${pr.base}/auto-publish`, {});
        const observe = async () => {
          const res = await fetch(`${server.url}${pr.base}/wait?timeout=1`, { headers: { 'x-galley-actor': 'observer' } });
          return { status: res.status, message: (await res.json()).message };
        };
        // Another agent waiting is not the author waiting: Codex does not start ...
        const refused = await observe();
        assert.equal(refused.status, 403);
        assert.match(refused.message, /^only the author of this pull request \(agent\) can wait for its feedback, not observer\./);
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs, []);
        // ... and with Codex off for the pull request, auto-publish does not go ahead.
        await human('PATCH', `${pr.base}/reviewers/codex`, { enabled: false });
        assert.equal((await observe()).status, 403);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(pr.created(), false);
        assert.ok((await human('GET', pr.base)).auto_publish);
        assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Published to GitHub/);
      });
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', defaults);
    }
  });

  await t.test('force-pushes over a branch already on GitHub when that was approved', async () => {
    const pr = await stage('feature/auto-force', 'force.js');
    // The branch reached GitHub before its first publish, and the agent then rewrote it.
    git('push', '-q', 'origin', 'feature/auto-force');
    const theirs = git('rev-parse', 'HEAD');
    git('commit', '-q', '--amend', '-m', 'Add force.js, reworded');
    await until(async () => (await human('GET', pr.base)).head.sha === git('rev-parse', 'HEAD'), 'the rewrite is recorded');
    // As for publishing by hand, the box offers to force-push.
    assert.match(await pr.page(), /<label class="js-force-option"><input type="checkbox" name="force" checked> Force-push/);
    const on = await cli(['pr', 'publish', String(pr.number), '--auto', '--force'], { actor: 'reviewer' });
    assert.equal(on.code, 0, on.stderr);
    const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '10s']);
    assert.match(r.stdout, /Published to GitHub/);
    const published = (await pr.timeline()).findLast((e) => e.event === 'published');
    assert.deepEqual([published.auto, published.force], [true, true]);
    const tip = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/auto-force'], { encoding: 'utf8' }).trim();
    assert.notEqual(tip, theirs);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${tip}^{tree}`], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD^{tree}'));
  });

  /** The branch's tip in the bare remote, and whether it carries a signature. */
  const remoteTip = (branch: string) => {
    const sha = execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim();
    const signed = /^gpgsig /m.test(execFileSync('git', ['--git-dir', remote, 'cat-file', 'commit', sha], { encoding: 'utf8' }));
    return { sha, signed, tree: execFileSync('git', ['--git-dir', remote, 'rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).trim() };
  };

  await t.test('force-pushes signed copies over the unsigned commits already on GitHub when that was approved', async () => {
    const pr = await stage('feature/auto-unsigned', 'unsigned.js');
    // The agent's unsigned commit reached GitHub before the first publish; signing replaces it with a copy.
    git('push', '-q', 'origin', 'feature/auto-unsigned');
    const theirs = git('rev-parse', 'HEAD');
    const on = await cli(['pr', 'publish', String(pr.number), '--auto', '--sign', '--force'], { actor: 'reviewer' });
    assert.equal(on.code, 0, on.stderr);
    const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '10s']);
    assert.match(r.stdout, /Published to GitHub/);
    const published = (await pr.timeline()).findLast((e) => e.event === 'published');
    assert.deepEqual([published.auto, published.force, published.signed], [true, true, 1]);
    const tip = remoteTip('feature/auto-unsigned');
    assert.notEqual(tip.sha, theirs);
    assert.deepEqual([tip.signed, tip.tree], [true, git('rev-parse', 'HEAD^{tree}')]);
  });

  await t.test('publishing by hand offers force when signing replaces unsigned commits on GitHub', async () => {
    const pr = await stage('feature/manual-unsigned', 'manual.js');
    git('push', '-q', 'origin', 'feature/manual-unsigned');
    const theirs = git('rev-parse', 'HEAD');
    await until(async () => (await human('GET', pr.base)).head.sha === theirs, 'the pull request is synced');
    // The history did not change, but the signed copy does not contain the commit on GitHub.
    assert.match(await pr.page(), /<label class="js-force-option"><input type="checkbox" name="force" checked> Force-push/);
    // Without force it is refused before anything is pushed.
    const refused = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: false }) });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).message, /force-pushing was not chosen\.$/);
    assert.equal(remoteTip('feature/manual-unsigned').sha, theirs);
    const pull = await human('POST', `${pr.base}/publish`, { force: true });
    assert.equal(pull.staging_state, 'published');
    assert.equal((await pr.timeline()).findLast((e) => e.event === 'published').force, true);
    assert.equal(remoteTip('feature/manual-unsigned').signed, true);
  });

  await t.test('waits for your own threads, and a failure to publish turns it off', async () => {
    const pr = await stage('feature/auto-gh', 'gh.js');
    const thread = await human('POST', `${pr.base}/comments`, { path: 'gh.js', line: 1, side: 'RIGHT', body: 'Is this needed?' });
    await human('PUT', `${pr.base}/auto-publish`, {});
    // Codex is off. The agent answers the thread but leaves it for the reviewer to resolve.
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /Is this needed\?/);
    assert.equal((await cli(['pr', 'comment', String(pr.number), '--reply-to', String(thread.id), '-b', 'Yes.'])).code, 0);
    const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
    await untilWaiting(pr.base);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pr.created(), false);
    assert.match(await pr.page(), /1 conversation you started is unresolved/);

    await withFakes({ FAKE_GH_FAIL: 'HTTP 502: gh is down' }, async () => {
      await human('PUT', `${pr.base}/threads/${thread.id}/resolved`);
      await until(async () => !(await human('GET', pr.base)).auto_publish, 'the failed publish turns auto-publish off');
    });
    assert.equal((await human('GET', pr.base)).auto_publish, null);
    const failed = (await pr.timeline()).findLast((e) => e.event === 'auto_publish_failed');
    assert.equal(failed.error, 'gh pr create failed:\nHTTP 502: gh is down');
    const page = await pr.page();
    assert.match(page, /<strong>Auto-publish failed [^]*?<\/strong>[^]*?<pre class="merge-error">gh pr create failed:\nHTTP 502: gh is down<\/pre>/);
    assert.match(page, /Auto-publish failed and turned itself off/);
    assert.match(page, /Publish when reviews are done/);
    // The agent is told to ask the reviewer, never that it was published.
    const told = await waiting;
    assert.match(told.stdout, /^No reviewer agent reviews .*; ask the user to review it: /);
    assert.doesNotMatch(told.stdout, /Published to GitHub/);
    await human('POST', `/api/repos/acme/widgets/issues/${pr.number}/comments`, { body: 'I will publish this by hand.' });
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '20s'])).stdout, /I will publish this by hand\./);
  });
});

test('publishing can enable auto-merge on GitHub', async (t) => {
  const stage = async (branch: string, file: string) => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export const merged = true;\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const number = Number(created.stdout.trim().split('/').pop());
    const base = `/api/repos/acme/widgets/pulls/${number}`;
    return {
      number,
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      timeline: (): Promise<any[]> => human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`),
      /** The commit GitHub has: the signed copy publishing pushed. */
      pushed: () => execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim(),
    };
  };
  /** gh calls from here on. */
  const ghCalls = () => {
    const log = () => (existsSync(join(dir, 'gh.log')) ? readFileSync(join(dir, 'gh.log'), 'utf8') : '');
    const start = log().length;
    return () => log().slice(start).split('\n').filter(Boolean);
  };
  const url = 'https://github.com/acme/widgets/pull/7';
  /** Read the repository's settings from GitHub (the fake gh, with `env`) into galley's cache. */
  const refresh = (env: Record<string, string>) => withFakes(env, () => server.service.refreshGithubRepo('acme/widgets'));
  // The option shows once galley knows that the repository allows auto-merge.
  await refresh({});

  await t.test('when publishing by hand, with the merge method from settings', async () => {
    const pr = await stage('feature/merge-manual', 'manual-merge.js');
    assert.match(await pr.page(), /<label><input type="checkbox" name="auto_merge"> <span>Enable auto-merge on GitHub \(squash\)<\/span><\/label>/);
    const calls = ghCalls();
    const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), url);
    assert.match(r.stderr, /✓ https:\/\/github\.com\/acme\/widgets\/pull\/7 will be automatically merged via squash when all requirements are met/);
    // After the pull request is created, and only for the commit that was pushed.
    assert.deepEqual(
      calls().filter((c) => c.startsWith('pr ')),
      [
        'pr create --repo acme/widgets --base main --head feature/merge-manual --title Add manual-merge.js --body-file -',
        `pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`,
        `pr view ${url} --json state,mergedAt,mergedBy,mergeCommit`,
      ],
    );
    const enabled = (await pr.timeline()).findLast((e) => e.event === 'auto_merge_enabled');
    assert.deepEqual([enabled.url, enabled.method, enabled.merged, enabled.actor.login], [url, 'squash', false, 'reviewer']);
    assert.deepEqual({ ...(await human('GET', pr.base)).auto_merge, enabled_by: undefined }, { enabled_by: undefined, merge_method: 'squash', commit_title: null, commit_message: null });
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tenabled\treviewer\tsquash$/m);
    const { autoMergeRequest } = JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoMergeRequest'])).stdout);
    assert.deepEqual([autoMergeRequest.enabledBy.login, autoMergeRequest.mergeMethod], ['reviewer', 'SQUASH']);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge is on for <a href="https:\/\/github\.com\/acme\/widgets\/pull\/7"[^>]*>acme\/widgets#7<\/a><\/strong>/);
    assert.match(page, /enabled auto-merge \(squash\) on <a [^>]*>acme\/widgets#7<\/a>/);

    // The merge method is a setting.
    const refused = await fetch(`${server.url}/api/settings/publish`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mergeMethod: 'octopus' }) });
    assert.equal(refused.status, 422);
    writeFileSync(join(repo, 'manual-merge.js'), 'export const merged = 1;\n');
    git('commit', '-qam', 'Change manual-merge.js');
    await until(async () => (await human('GET', pr.base)).head.sha === git('rev-parse', 'HEAD'), 'the push is recorded');
    // The page sends the method it shows; open pages hear when the setting changes.
    // Auto-merge is on for it, so the update asks for it again unless unchecked.
    assert.match(
      await pr.page(),
      /<label title="Unchecked, this publish does not ask for auto-merge\. It does not turn auto-merge off on GitHub\."><input type="checkbox" name="auto_merge" checked> <span>Enable auto-merge on GitHub \(squash\)\. Auto-merge is on for <a href="https:\/\/github\.com\/acme\/widgets\/pull\/7"[^>]*>acme\/widgets#7<\/a>\.<\/span><\/label><input type="hidden" name="merge_method" value="squash">/,
    );
    const events: string[] = [];
    const listen = (e: { type: string }) => events.push(e.type);
    server.service.bus.on('change', listen);
    assert.equal((await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' })).publish.mergeMethod, 'rebase');
    server.service.bus.off('change', listen);
    assert.ok(events.includes('settings'), 'open pages hear that the merge method changed');
    try {
      assert.match(await (await fetch(`${server.url}/settings/publishing`)).text(), /<option value="rebase" selected>Rebase and merge<\/option>/);
      // A page that still shows squash cannot publish with rebase, nor turn on auto-publish.
      const update = ghCalls();
      for (const [method, path] of [['POST', 'publish'], ['PUT', 'auto-publish']]) {
        const stale = await fetch(`${server.url}${pr.base}/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true, merge_method: 'squash' }) });
        assert.equal(stale.status, 412, path);
        assert.equal((await stale.json()).message, 'The merge method in Settings changed to rebase after this page was loaded. Refresh before publishing.');
      }
      assert.deepEqual(update(), []);
      assert.equal((await human('GET', pr.base)).auto_publish, null);
      assert.match(await pr.page(), /<input type="hidden" name="merge_method" value="rebase">/);
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true, merge_method: 'rebase' });
      assert.deepEqual(pull.auto_merge_result, { state: 'enabled', merge_method: 'rebase', error: null });
      assert.ok(update().includes(`pr merge ${url} --auto --rebase --match-head-commit ${pr.pushed()}`));
    } finally {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
  });

  await t.test('when auto-publish publishes, if it was chosen with it', async () => {
    const pr = await stage('feature/merge-auto', 'auto-merge.js');
    const on = await cli(['pr', 'publish', String(pr.number), '--auto', '--auto-merge'], { actor: 'reviewer' });
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stderr, /will be published when the reviewer agents are done and the author has answered them, with auto-merge on GitHub/);
    // The merge method is fixed when auto-publish is turned on, like its other options.
    assert.equal((await human('GET', pr.base)).auto_publish.auto_merge, 'squash');
    assert.equal(JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'autoPublishRequest'])).stdout).autoPublishRequest.autoMerge, 'squash');
    await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' });
    try {
      assert.match(await pr.page(), /and enables auto-merge on GitHub \(squash\)\. After that, each commit agent waits with is pushed\./);
      const calls = ghCalls();
      const waited = await cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      assert.match(waited.stdout, /Published to GitHub/);
      await until(async () => (await pr.timeline()).some((e) => e.event === 'auto_merge_enabled'), 'auto-merge is enabled');
      assert.ok(calls().includes(`pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`));
    } finally {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
  });

  await t.test('the publish form checks it when auto-publish includes it, with the same merge method', async () => {
    const pr = await stage('feature/merge-form', 'form-merge.js');
    await human('PUT', `${pr.base}/auto-publish`, { auto_merge: true, merge_method: 'squash' });
    await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' });
    try {
      assert.match(
        await pr.page(),
        /<label title="Unchecked, this publish does not ask for auto-merge\. It does not turn auto-merge off on GitHub\."><input type="checkbox" name="auto_merge" checked> <span>Enable auto-merge on GitHub \(squash\)<\/span><\/label><input type="hidden" name="merge_method" value="squash">/,
      );
      // Publishing by hand from it does what auto-publish would, though the setting says rebase now.
      const calls = ghCalls();
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true, merge_method: 'squash' });
      assert.deepEqual(pull.auto_merge_result, { state: 'enabled', merge_method: 'squash', error: null });
      assert.ok(calls().includes(`pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`), calls().join('\n'));
      // A method that is neither auto-publish's nor the one in settings is still refused.
      const stale = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true, merge_method: 'merge' }) });
      assert.equal(stale.status, 412);
    } finally {
      await human('DELETE', `${pr.base}/auto-publish`);
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
  });

  await t.test('a failure is recorded, and the pull request stays published', async () => {
    const pr = await stage('feature/merge-fail', 'fail-merge.js');
    writeFileSync(join(dir, 'gh-merge-fail'), 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)');
    const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), url);
    assert.match(r.stderr, /Published, but turning on auto-merge failed:\nGraphQL: Auto merge is not allowed for this repository/);
    const pull = await human('GET', pr.base);
    assert.deepEqual([pull.staging_state, pull.published_url, pull.auto_merge], ['published', url, null]);
    const timeline = await pr.timeline();
    assert.ok(timeline.some((e) => e.event === 'published'));
    assert.equal(timeline.findLast((e) => e.event === 'auto_merge_failed').error, 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)');
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tdisabled$/m);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge failed <relative-time [^]*?<\/strong>[^]*?<pre class="merge-error">GraphQL: Auto merge is not allowed for this repository \(enablePullRequestAutoMerge\)<\/pre>/);
    assert.match(page, /Enabling auto-merge on <a [^>]*>acme\/widgets#7<\/a> failed/);
    // What came of it stays in the merge box when GitHub no longer allows auto-merge, or cannot be asked.
    for (const env of [{ FAKE_GH_AUTO_MERGE: 'false' }, { FAKE_GH_API_FAIL: 'HTTP 502' }] as Record<string, string>[]) {
      await refresh(env);
      assert.match(await pr.page(), /<strong>Auto-merge failed <relative-time /, Object.keys(env)[0]);
    }
    await refresh({});
  });

  await t.test('a merge gh accepted but galley could not check is not reported as auto-merge on', async () => {
    const pr = await stage('feature/merge-unknown', 'unknown-merge.js');
    await withFakes({ FAKE_GH_VIEW: 'not JSON' }, async () => {
      const r = await cli(['pr', 'publish', String(pr.number), '--auto-merge'], { actor: 'reviewer' });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /✓ Requested auto-merge via squash for https:\/\/github\.com\/acme\/widgets\/pull\/7; whether GitHub merged it at once could not be checked/);
    });
    const enabled = (await pr.timeline()).findLast((e) => e.event === 'auto_merge_enabled');
    assert.equal(enabled.merged, null);
    assert.equal((await human('GET', pr.base)).auto_merge, null);
    assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^auto-merge:\tdisabled$/m);
    const page = await pr.page();
    assert.match(page, /<strong>Auto-merge requested for <a [^>]*>acme\/widgets#7<\/a><\/strong>/);
    assert.match(page, /requested auto-merge \(squash\) on <a [^>]*>acme\/widgets#7<\/a> [^]*?; whether GitHub merged it at once could not be checked/);
  });

  await t.test('the merge method checked when the request came in is the one used', async () => {
    const pr = await stage('feature/merge-race', 'race-merge.js');
    const service = server.service;
    const publish = service.publish;
    // The setting changes after the request was checked, while publishing is under way.
    service.publish = async (...args: Parameters<Service['publish']>) => {
      await human('PUT', '/api/settings/publish', { mergeMethod: 'rebase' });
      return publish.apply(service, args);
    };
    const calls = ghCalls();
    try {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true, merge_method: 'squash' });
      assert.equal(pull.auto_merge_result.merge_method, 'squash');
    } finally {
      service.publish = publish;
      await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
    }
    assert.ok(calls().includes(`pr merge ${url} --auto --squash --match-head-commit ${pr.pushed()}`), calls().join('\n'));
  });

  await t.test('a lookup that cannot even start leaves the outcome unknown, not failed', async () => {
    const pr = await stage('feature/merge-lookup', 'lookup-merge.js');
    const service = server.service;
    const gh = service.ghBin;
    const calls = ghCalls();
    // Once gh pr merge has run, gh cannot be started any more, as when its working directory is gone.
    Object.defineProperty(service, 'ghBin', { configurable: true, get: () => (calls().some((c) => c.startsWith('pr merge ')) ? join(dir, 'no-such-gh') : gh) });
    try {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true });
      assert.deepEqual(pull.auto_merge_result, { state: 'requested', merge_method: 'squash', error: null });
    } finally {
      Object.defineProperty(service, 'ghBin', { configurable: true, writable: true, value: gh });
      await refresh({});
    }
    assert.match(await pr.page(), /<strong>Auto-merge requested for <a [^>]*>acme\/widgets#7<\/a><\/strong>/);
  });

  await t.test('asks GitHub before publishing, rather than trusting what it read earlier', async () => {
    // Auto-publish was approved with auto-merge while GitHub allowed squash merges; then the
    // repository stopped allowing them, and galley's cache has not heard yet.
    const pr = await stage('feature/merge-stale', 'stale-merge.js');
    await human('PUT', `${pr.base}/auto-publish`, { auto_merge: true });
    const calls = ghCalls();
    try {
      await withFakes({ FAKE_GH_SQUASH: 'false' }, async () => {
        const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '3s']);
        await until(async () => (await human('GET', pr.base)).auto_publish === null, 'auto-publish gives up');
        await waiting;
      });
      const failed = (await pr.timeline()).findLast((e) => e.event === 'auto_publish_failed');
      assert.match(failed.error, /^acme\/widgets does not allow squash merges/);

      // The same for publishing by hand: galley read that squash merges are allowed, and GitHub no longer allows them.
      await refresh({});
      assert.match(await pr.page(), /<input type="checkbox" name="auto_merge">/);
      const refused = await withFakes({ FAKE_GH_SQUASH: 'false' }, () =>
        fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true }) }),
      );
      assert.equal(refused.status, 422);
      assert.match((await refused.json()).message, /^acme\/widgets does not allow squash merges/);
    } finally {
      await refresh({});
    }
    // Refused before anything was pushed or opened on GitHub.
    assert.equal((await human('GET', pr.base)).staging_state, 'staged');
    assert.ok(!calls().some((c) => c.startsWith('pr ')), calls().join('\n'));
    assert.throws(() => execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', 'feature/merge-stale'], { stdio: 'pipe' }));
  });

  await t.test('GitHub merges at once when there is nothing to wait for', async () => {
    const pr = await stage('feature/merge-clean', 'clean-merge.js');
    // Right after creating the pull request, gh asks for auto-merge before GitHub knows it is
    // clean, and GitHub refuses. Asked again, gh merges it.
    writeFileSync(join(dir, 'gh-merge-fail'), 'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)');
    const mergeCommit = 'f00d' + '0'.repeat(36);
    const calls = ghCalls();
    await withFakes({ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-17T10:00:00Z', mergedBy: { login: 'reviewer' }, mergeCommit: { oid: mergeCommit } }) }, async () => {
      const pull = await human('POST', `${pr.base}/publish`, { auto_merge: true });
      assert.deepEqual(pull.auto_merge_result, { state: 'merged', merge_method: 'squash', error: null });
    });
    assert.equal(calls().filter((c) => c.startsWith('pr merge ')).length, 2);
    assert.equal((await human('GET', pr.base)).auto_merge, null);
    const page = await pr.page();
    assert.match(page, /<strong>Merged on GitHub<\/strong>/);
    assert.match(page, /merged <a [^>]*>acme\/widgets#7<\/a> on GitHub \(squash\) [^]*?: auto-merge had nothing to wait for/);
    // Recorded as merged, as following would: the agent hears of it, and nothing is published over it.
    const recorded = await human('GET', pr.base);
    assert.deepEqual([recorded.github_state, recorded.merged_by?.login, recorded.merge_commit_sha], ['merged', 'reviewer', mergeCommit]);
    assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '5s'])).stdout, /^Merged on GitHub as f00d000 by reviewer/m);
    const pushed = pr.pushed();
    writeFileSync(join(repo, 'clean-merge.js'), 'export const after = 1;\n');
    git('commit', '-qam', 'After the merge');
    const again = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(again.status, 422);
    assert.equal(pr.pushed(), pushed);
  });

  await t.test('only where GitHub allows auto-merge, and with a merge method it allows', async () => {
    const pr = await stage('feature/merge-allowed', 'allowed-merge.js');
    const checkbox = /<input type="checkbox" name="auto_merge">/;
    const calls = ghCalls();
    try {
      // The repository does not allow auto-merge: no option, and the CLI refuses before publishing.
      const events: string[] = [];
      const listen = (e: { type: string }) => events.push(e.type);
      server.service.bus.on('change', listen);
      await refresh({ FAKE_GH_AUTO_MERGE: 'false' });
      server.service.bus.off('change', listen);
      assert.ok(events.includes('github_repo'), 'open pages hear that the option went away');
      assert.doesNotMatch(await pr.page(), /name="auto_merge"/);
      await withFakes({ FAKE_GH_AUTO_MERGE: 'false' }, async () => {
        for (const args of [['--auto-merge'], ['--auto', '--auto-merge']]) {
          const r = await cli(['pr', 'publish', String(pr.number), ...args], { actor: 'reviewer' });
          assert.equal(r.code, 1, args.join(' '));
          assert.match(r.stderr, /acme\/widgets does not allow auto-merge\. Turn on "Allow auto-merge" in the repository's settings on GitHub\./);
        }
      });
      assert.equal((await human('GET', pr.base)).auto_publish, null);

      // It allows auto-merge, but not the merge method in settings: the option says so, and publishing refuses.
      await refresh({});
      await human('PUT', `${pr.base}/auto-publish`, { auto_merge: true });
      await refresh({ FAKE_GH_SQUASH: 'false' });
      const box = await pr.page();
      assert.match(box, /<input type="checkbox" name="auto_merge" disabled> Enable auto-merge on GitHub: acme\/widgets does not allow squash merges\. <a href="\/settings\/publishing">/);
      // Auto-publish, turned on before, would fail.
      assert.match(box, /acme\/widgets does not allow squash merges, so publishing will fail<\/span>/);
      await human('DELETE', `${pr.base}/auto-publish`);
      const refused = await withFakes({ FAKE_GH_SQUASH: 'false' }, () =>
        fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ auto_merge: true }) }),
      );
      assert.equal(refused.status, 422);
      assert.match((await refused.json()).message, /acme\/widgets does not allow squash merges, the merge method in galley's settings \(it allows merge, rebase\)\. Change it under Settings → Publishing\./);

      // Not knowing, because gh failed, hides it too.
      await refresh({ FAKE_GH_API_FAIL: 'HTTP 502' });
      assert.doesNotMatch(await pr.page(), /name="auto_merge"/);
    } finally {
      await refresh({});
    }
    assert.match(await pr.page(), checkbox);
    // Nothing was pushed or published while it refused.
    assert.equal((await human('GET', pr.base)).staging_state, 'staged');
    assert.ok(!calls().some((c) => c.startsWith('pr ')), calls().join('\n'));
  });
});

test('a review the server stops under is interrupted, runs again when it starts, and does not count', async (t) => {
  const checkedOut = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/restart-review');
  writeFileSync(join(repo, 'restart.js'), 'export {};\n');
  git('add', 'restart.js');
  git('commit', '-qm', 'Add restart.js');
  const data = mkdtempSync(join(tmpdir(), 'galley-stop-'));
  const start = ({ port = 0, gh = 'false' } = {}) => startServer({ port, dataDir: data, ghBin: gh, codexBin: join(dir, 'codex'), reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000 });
  let s = await start();
  t.after(async () => {
    await s.close();
    rmSync(data, { recursive: true, force: true });
  });
  const port = s.port;
  // Later restarts take a new port: fetch would send its first request to one on the same port over a connection the old server closed.
  const json = { 'content-type': 'application/json' };
  const registered = await (await fetch(`${s.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const pulls = `/api/repos/${registered.full_name}/pulls`;
  // Codex gets one automatic review.
  const pr = await (
    await fetch(`${s.url}${pulls}`, {
      method: 'POST',
      headers: { ...json, 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: 'Slow review', head: 'feature/restart-review', base: 'main', reviewers: [{ login: 'codex', max_iterations: 1 }] }),
    })
  ).json();
  const base = `${pulls}/${pr.number}`;
  const runs = async () => (await (await fetch(`${s.url}${base}/reviewers/codex`)).json()).runs.map((r: any) => [r.trigger, r.status, r.error]);
  const page = async () => (await fetch(`${s.url}/${registered.full_name}/pull/${pr.number}`)).text();
  const ask = async () => assert.equal((await fetch(`${s.url}${base}/reviewers/codex`, { method: 'POST' })).status, 202);
  // The fake Codex answers once the gate exists; until then its review runs.
  const gate = join(dir, 'stop-gate');
  const review = { summary: 'One thing.', comments: [{ path: 'restart.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Export something.' }] };
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    try {
      // The author waits, which starts the automatic review, and the server stops under it.
      const env = { ...process.env, GALLEY_URL: s.url, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1', NO_COLOR: '1' };
      const waiting = exec(process.execPath, [BIN, 'pr', 'wait', String(pr.number), '--timeout', '30s'], { cwd: repo, env });
      await until(() => s.service.codex!.isRunning(pr.id), 'Codex reviews');
      // Until Codex is at work, with steps in its transcript.
      const pull = () => s.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id);
      await until(() => (s.service.codex!.live(pull())?.progress.total ?? 0) >= 2, 'Codex has two steps in its transcript');
      const started = Date.now();
      await s.close();
      assert.ok(Date.now() - started < 5000, `close took ${Date.now() - started} ms`);
      assert.doesNotMatch(git('worktree', 'list'), /galley-review-/);

      // Interrupted, not failed: it runs again once the author's wait is back (on the same port), and the wait gets its review.
      writeFileSync(gate, '');
      s = await start({ port });
      assert.deepEqual(await runs(), [['auto', 'interrupted', null]]);
      // Its transcript keeps what it did until the stop, and says why it ended.
      const [{ id: interrupted }] = (await (await fetch(`${s.url}${base}/reviewers/codex`)).json()).runs;
      const runPath = `/${registered.full_name}/pull/${pr.number}/runs/${interrupted}`;
      assert.match(await page(), new RegExp(`<a class="agent-state" href="${runPath}" title="Review of [0-9a-f]{7} interrupted by a restart">[^]*?<span class="agent-chunk">Runs again</span>`));
      const transcript = await (await fetch(s.url + runPath)).text();
      assert.match(transcript, /Interrupted by a restart <relative-time/);
      assert.match(transcript, /I will read math\.js and the diff\./);
      const r = await waiting;
      assert.match(r.stdout, /codex-review reviewed: commented/);
      await s.service.codex!.settle(pr.id);
      assert.deepEqual(await runs(), [['auto', 'interrupted', null], ['auto', 'done', null]]);
      const reviews = await (await fetch(`${s.url}${base}/reviews`)).json();
      assert.match(reviews.at(-1).body, /automatic review 1 of 1\./);

      // Asked for by hand, it runs again as soon as the server starts.
      rmSync(gate);
      await ask();
      await s.close();
      writeFileSync(gate, '');
      s = await start();
      const row = () => s.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id);
      assert.ok(s.service.codex!.atWork(row()), 'about to review from the start');
      await s.service.codex!.settle(pr.id);
      assert.deepEqual((await runs()).slice(2), [['manual', 'interrupted', null], ['manual', 'done', null]]);

      // Until it has run again, it holds things up: auto-publish does not publish while the server
      // stops, with the author waiting and nothing unseen, nor is the author told the agents are done.
      const asAgent = { 'x-galley-actor': 'agent' };
      const shown = await (await fetch(`${s.url}${base}/wait?timeout=5`, { headers: asAgent })).json();
      assert.equal((await fetch(`${s.url}${base}/seen`, { method: 'PUT', headers: { ...asAgent, ...json }, body: JSON.stringify({ at: shown.seen_at }) })).status, 204);
      assert.equal((await fetch(`${s.url}${base}/auto-publish`, { method: 'PUT', headers: json, body: JSON.stringify({ sign: false }) })).status, 200);
      rmSync(gate);
      await ask();
      const authorWaits = fetch(`${s.url}${base}/wait?timeout=30`, { headers: asAgent })
        .then((res) => res.json())
        .catch(() => null);
      await until(async () => (await (await fetch(`${s.url}${base}`)).json()).author_waiting, 'the author waits');
      await s.close();
      assert.notEqual((await authorWaits)?.status, 'agents_done');
      {
        const db = new Db(join(data, 'galley.db'));
        const pull = db.get<any>('SELECT * FROM pulls WHERE id = ?', pr.id);
        const service = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
        service.codex = new CodexReviewer(service, join(dir, 'codex'));
        const status = service.codex.headStatus(pull);
        assert.equal(status.state, 'interrupted');
        // It runs again without the author: the reviewer agents' turn, though the author does not wait.
        const { whose, reasons } = service.turn(pull);
        assert.deepEqual([whose, reasons[0].text], ['reviewer_agents', `codex-review's review of ${pull.head_sha.slice(0, 7)} was interrupted by a restart; it will run again`]);
        await service.conflictChecks;
        assert.deepEqual(db.all('SELECT type FROM events WHERE pull_id = ? AND type IN (?, ?)', pr.id, 'published', 'auto_publish_failed'), []);
        db.sql.close();
      }
      writeFileSync(gate, '');
      s = await start();
      await s.service.codex!.settle(pr.id);
      assert.deepEqual((await runs()).slice(4), [['manual', 'interrupted', null], ['manual', 'done', null]]);
      assert.ok(row().auto_publish, 'auto-publish is still on, never having tried');
      assert.equal((await fetch(`${s.url}${base}/auto-publish`, { method: 'DELETE' })).status, 204);

      // Not when the branch moved on while the server was down.
      rmSync(gate);
      await ask();
      await s.close();
      writeFileSync(join(repo, 'restart.js'), 'export const moved = true;\n');
      git('commit', '-qam', 'Change restart.js');
      writeFileSync(gate, '');
      s = await start();
      await s.service.codex!.settle(pr.id);
      assert.equal(row().head_sha, git('rev-parse', 'HEAD'));
      assert.deepEqual((await runs()).slice(6), [['manual', 'interrupted', null]]);

      // Nor when following GitHub, which starts with the server, finds it merged meanwhile.
      rmSync(gate);
      await ask();
      await s.close();
      writeFileSync(gate, '');
      const ctx = Service.prototype.ctx;
      Service.prototype.ctx = async function (this: Service, ...args: Parameters<Service['ctx']>) {
        if (this !== server.service) {
          Service.prototype.ctx = ctx;
          this.db.run("UPDATE pulls SET github_state = 'merged' WHERE id = ?", pr.id);
        }
        return ctx.apply(this, args);
      };
      try {
        s = await start();
        await s.service.codex!.settle(pr.id);
      } finally {
        Service.prototype.ctx = ctx;
      }
      assert.deepEqual((await runs()).slice(7), [['manual', 'interrupted', null]]);
      s.service.db.run('UPDATE pulls SET github_state = NULL WHERE id = ?', pr.id);

      // When it can not run again, it failed: it does not keep the pull request with the reviewer agents.
      rmSync(gate);
      await ask();
      await s.close();
      writeFileSync(gate, '');
      Service.prototype.ctx = async function (this: Service, ...args: Parameters<Service['ctx']>) {
        if (this !== server.service) {
          Service.prototype.ctx = ctx;
          throw new Error('the repository moved');
        }
        return ctx.apply(this, args);
      };
      try {
        s = await start();
        await s.service.codex!.settle(pr.id);
      } finally {
        Service.prototype.ctx = ctx;
      }
      assert.deepEqual((await runs()).slice(8), [['manual', 'failed', 'the repository moved']]);
      const failed = s.service.turn(row());
      assert.deepEqual([failed.whose, failed.reasons.find((x) => x.kind === 'reviewer_agent')?.text], ['reviewer', `codex-review's review of ${row().head_sha.slice(0, 7)} failed`]);

      // Given time, stopping waits for a running review to post, and pages say so meanwhile in the
      // header, which live updates refresh along with #main.
      rmSync(gate);
      await ask();
      const finishing = s.close({ graceMs: 60_000 });
      const stopping = await page();
      assert.match(stopping, /<header[^]*<span id="server-stopping" class="stopping-indicator" role="status" title="Waiting for 1 running review to finish before the server stops\."[^>]*>.*?Stopping · 1 review running.*?<\/span><\/span>[^]*<\/header>/);
      assert.doesNotMatch(stopping.slice(stopping.indexOf('<div id="main"')), /Waiting for/);
      assert.equal((await fetch(`${s.url}${base}/reviewers/codex`, { method: 'POST' })).status, 503);
      // Pages of other pull requests hear when the count changes.
      const heard: ChangeEvent[] = [];
      s.service.bus.on('change', (e: ChangeEvent) => e.type === 'stopping' && heard.push(e));
      writeFileSync(gate, '');
      await finishing;
      assert.deepEqual(heard, [{ pullId: null, type: 'stopping', actor: 'galley' }]);
      s = await start();
      assert.deepEqual((await runs()).slice(9), [['manual', 'done', null]]);

      // Stopping again while it waits interrupts at once.
      rmSync(gate);
      await ask();
      const waitingToStop = s.close({ graceMs: 60_000 });
      await new Promise((r) => setTimeout(r, 200));
      const again = Date.now();
      await s.close();
      await waitingToStop;
      assert.ok(Date.now() - again < 5000, `the second close took ${Date.now() - again} ms`);
      writeFileSync(gate, '');
      s = await start();
      await s.service.codex!.settle(pr.id);
      assert.deepEqual((await runs()).slice(10), [['manual', 'interrupted', null], ['manual', 'done', null]]);

      // Published, it is not run again when GitHub says it was merged meanwhile, even when GitHub answers late.
      rmSync(gate);
      await ask();
      await s.close();
      {
        const db = new Db(join(data, 'galley.db'));
        db.run("UPDATE pulls SET state = 'published', published_url = ?, published_head_sha = head_sha, published_source_sha = head_sha WHERE id = ?", 'https://github.com/acme/widgets/pull/7', pr.id);
        db.sql.close();
      }
      // A gh that tells what GitHub says about pull requests a second late, and fails at anything else.
      const lateGh = join(dir, 'gh-late');
      const merged = { state: 'MERGED', mergedAt: '2026-10-17T09:00:00Z', closedAt: '2026-10-17T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: null, timelineItems: { nodes: [] } };
      writeFileSync(join(dir, 'gh-late.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: merged } } }));
      writeFileSync(lateGh, `#!/bin/sh\ncase "$*" in\n  *"pullRequest("*) sleep 1; cat "${join(dir, 'gh-late.json')}" ;;\n  *) exit 1 ;;\nesac\n`);
      chmodSync(lateGh, 0o755);
      writeFileSync(gate, '');
      s = await start({ gh: lateGh });
      await s.service.codex!.settle(pr.id);
      await until(() => row().github_state === 'merged', 'the server hears of the merge');
      assert.deepEqual((await runs()).slice(12), [['manual', 'interrupted', null]]);
    } finally {
      rmSync(gate, { force: true });
      await s.close();
      git('checkout', '-q', checkedOut);
    }
  });
});

test('closing the server waits for a running poll before it closes the database', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'galley-poll-'));
  const second = await startServer({ port: 0, dataDir: data, ghBin: 'false', reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 10 });
  t.after(async () => {
    await second.close();
    rmSync(data, { recursive: true, force: true });
  });
  const errors = mock.method(console, 'error', () => {});
  // A slow poll: it reads the database once the server is closing.
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  let polled = false;
  const pollAll = second.service.pollAll.bind(second.service);
  second.service.pollAll = async () => {
    started();
    await new Promise((r) => setTimeout(r, 200));
    await pollAll();
    polled = true;
  };
  try {
    await running;
    await second.close();
    assert.ok(polled, 'the poll finished before the server closed');
    assert.deepEqual(errors.mock.calls.map((c) => c.arguments.join(' ')), []);
  } finally {
    errors.mock.restore();
  }
});

test('an author an older CLI called "codex" moves to "codex-agent" when the reviewer starts', async () => {
  // As the reviewer took the name "codex", it moved such an author; on its new default it does so when it starts.
  for (const current of [false, true]) {
    const data = mkdtempSync(join(tmpdir(), 'galley-upgrade-'));
    const db = new Db(join(data, 'galley.db'));
    try {
      const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
      const registered = await s.registerRepo(repo);
      const old = db.actor('codex', 'Bot');
      // When "codex-agent" exists too, both are the same kind of author and become one.
      const agent = current ? db.actor('codex-agent', 'Bot') : old;
      const pull = await s.createPull(registered, { title: 'From an older Codex agent', head: 'feature/mul', base: 'main' }, old);
      const reviewer = new CodexReviewer(s, join(dir, 'codex'));
      reviewer.start();
      await reviewer.stop();
      assert.equal(reviewer.actor().login, 'codex-review');
      const author = db.get<{ author_id: number }>('SELECT author_id FROM pulls WHERE id = ?', pull.id)!.author_id;
      assert.equal(author, agent.id);
      assert.equal(db.actorById(author).login, 'codex-agent', 'the agent the CLI now calls codex-agent keeps its pull request');
      assert.equal(db.get('SELECT 1 FROM actors WHERE login = ?', 'codex'), undefined);
      // So it can wait for feedback on it.
      const waited = await s.wait(await s.ctx(registered.owner, registered.name, pull.number), db.actorById(author), 0);
      assert.equal(waited.status === 'timeout' || waited.status === 'agents_done', true, waited.status);
    } finally {
      db.sql.close();
      rmSync(data, { recursive: true, force: true });
    }
  }
});

test('a Codex reviewer on the former default name "codex" becomes "codex-review", one with a name of its own stays', async () => {
  /** An install from before, its reviewer named `login` (by default "codex"), with a review; `stored` is the setting. */
  const upgrade = async (login: string, stored?: string) => {
    const db = new Db(':memory:');
    if (stored) saveSettings(db, { ...readSettings(db), codex: { ...readSettings(db).codex, name: stored } });
    const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
    const registered = await s.registerRepo(repo);
    const pull = await s.createPull(registered, { title: 'Reviewed before', head: 'feature/mul', base: 'main' }, db.actor('agent', 'Bot'));
    const bot = db.actor(login, 'Bot');
    db.setMeta('codex_actor_id', String(bot.id));
    const review = await s.createReview(await s.ctx(registered.owner, registered.name, pull.number), { event: 'COMMENT', body: 'Fine.' }, bot);
    db.insert('review_runs', { pull_id: pull.id, reviewer: 'codex', head_sha: pull.head_sha, trigger: 'auto', status: 'done', review_id: review.id, findings: 0, started_at: now(), finished_at: now() });
    const reviewer = new CodexReviewer(s, join(dir, 'codex'));
    reviewer.start();
    await reviewer.stop();
    const result = { login: reviewer.actor().login, reviewedBy: db.actorById(review.author_id).login, setting: readSettings(db).codex.name };
    db.sql.close();
    return result;
  };
  // On the default, set or not: the one actor is renamed, so its earlier reviews show the new name.
  assert.deepEqual(await upgrade('codex'), { login: 'codex-review', reviewedBy: 'codex-review', setting: 'codex-review' });
  assert.deepEqual(await upgrade('codex', 'codex'), { login: 'codex-review', reviewedBy: 'codex-review', setting: 'codex-review' });
  // A name of its own stays.
  assert.deepEqual(await upgrade('robo', 'robo'), { login: 'robo', reviewedBy: 'robo', setting: 'robo' });
});

test('Codex reviews from before findings were counted are counted from their review', async () => {
  const data = mkdtempSync(join(tmpdir(), 'galley-findings-'));
  const db = new Db(join(data, 'galley.db'));
  const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'reviewer' });
  const reviewer = new CodexReviewer(s, join(dir, 'codex'));
  s.codex = reviewer;
  try {
    for (const branch of ['feature/legacy-counted', 'feature/legacy-uncounted']) {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', branch);
      writeFileSync(join(repo, 'legacy.js'), 'export {};\n');
      git('add', 'legacy.js');
      git('commit', '-qm', 'Add legacy.js');
    }
    const registered = await s.registerRepo(repo);
    const author = db.actor('agent', 'Bot');
    const counted = await s.createPull(registered, { title: 'Counted', head: 'feature/legacy-counted', base: 'main' }, author);
    const uncounted = await s.createPull(registered, { title: 'Uncounted', head: 'feature/legacy-uncounted', base: 'main' }, author);
    // Codex is on for both, so a clean head is not mistaken for Codex being off.
    db.run('UPDATE pulls SET codex_enabled = 1');
    const row = (id: number) => db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
    // Runs as an older version left them: done, linked to their review, and no count.
    const run = (pullId: number, head: string, reviewId: number | null) =>
      db.insert('review_runs', { pull_id: pullId, reviewer: 'codex', head_sha: head, trigger: 'auto', status: 'done', review_id: reviewId, started_at: now(), finished_at: now() });
    const ctx = await s.ctx(registered.owner, registered.name, counted.number);
    const nothing = await s.createReview(ctx, { event: 'COMMENT', body: 'Codex found nothing to comment on.\n\n<sub>Codex reviewed it.</sub>' }, reviewer.actor());
    const nothingRun = run(counted.id, counted.head_sha, nothing.id);
    const found = await s.createReview(
      ctx,
      {
        event: 'COMMENT',
        body: 'Three things.\n\n**Comments on lines outside the diff**\n\n- `math.js:1`: First.\n- `math.js:2-3` (low priority): Second,\n  over two lines.\n\n<sub>Codex reviewed it.</sub>',
        comments: [{ path: 'legacy.js', line: 1, body: 'Third.' }],
      },
      reviewer.actor(),
    );
    const foundRun = run(counted.id, '0'.repeat(40), found.id);
    const lostRun = run(uncounted.id, uncounted.head_sha, null);
    reviewer.start();
    const findings = (id: number) => db.get<{ findings: number | null }>('SELECT findings FROM review_runs WHERE id = ?', id)!.findings;
    assert.deepEqual([findings(nothingRun), findings(foundRun), findings(lostRun)], [0, 3, null]);
    // A review that found nothing lets the head through; one that cannot be counted is reviewed again.
    assert.equal(reviewer.headStatus(row(counted.id)).state, 'clean');
    assert.equal(reviewer.headStatus(row(uncounted.id)).state, 'unreviewed');
    reviewer.consider(uncounted.id);
    assert.equal(reviewer.atWork(row(uncounted.id))?.status, 'QUEUED');
  } finally {
    await reviewer.stop();
    db.sql.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test('a reviewer never takes the human reviewer\'s own name', async () => {
  // Known at startup: the human is set up first, and the reviewer takes another name.
  const data = mkdtempSync(join(tmpdir(), 'galley-viewer-'));
  const named = await startServer({ port: 0, dataDir: data, ghBin: 'false', codexBin: join(dir, 'codex'), reviewersDir: join(data, 'reviewers'), viewerLogin: 'codex-review', pollMs: 60_000 });
  try {
    assert.equal(named.service.viewer().type, 'User');
    assert.notEqual(named.service.codex!.actor().id, named.service.viewer().id);
    const res = await fetch(`${named.url}/api/settings/codex`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxIterations: 2 }) });
    assert.equal(res.status, 200, 'settings stay the human\'s');
  } finally {
    await named.close();
    rmSync(data, { recursive: true, force: true });
  }

  // Learned later (from gh): the reviewer gives the name up.
  const data2 = mkdtempSync(join(tmpdir(), 'galley-viewer-'));
  const db = new Db(join(data2, 'galley.db'));
  try {
    const s = new Service({ db, baseUrl: 'http://localhost:0', viewerLogin: 'someone' });
    s.codex = new CodexReviewer(s, join(dir, 'codex'));
    assert.equal(s.codex.actor().login, 'codex-review');
    s.setViewerLogin('codex-review');
    assert.equal(s.viewer().type, 'User');
    assert.equal(s.codex.actor().login, 'codex-review-reviewer');
  } finally {
    db.sql.close();
    rmSync(data2, { recursive: true, force: true });
  }
});

test('pr wait keeps waiting when the server restarts under it', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'galley-restart-'));
  const first = await startServer({ port: 0, dataDir: data, ghBin: 'false', reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000 });
  t.after(async () => {
    await first.close();
    rmSync(data, { recursive: true, force: true });
  });
  const port = first.port;
  const json = { 'content-type': 'application/json' };
  const registered = await (await fetch(`${first.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const pr = await (
    await fetch(`${first.url}/api/repos/${registered.full_name}/pulls`, {
      method: 'POST',
      headers: { ...json, 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: 'Survives restarts', head: 'feature/mul', base: 'main' }),
    })
  ).json();
  const env = { ...process.env, GALLEY_URL: first.url, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1' };
  // No reviewer agent reviews it, which the first wait says; the next one waits for the reviewer.
  assert.match((await exec(process.execPath, [BIN, 'pr', 'wait', String(pr.number), '--timeout', '30s'], { cwd: repo, env })).stdout, /ask the user to review it/);
  const waiting = exec(process.execPath, [BIN, 'pr', 'wait', String(pr.number), '--timeout', '30s'], { cwd: repo, env });
  // Close the server while the wait's request is open, then bring it back on the same port.
  await until(async () => (await (await fetch(`${first.url}/api/repos/${registered.full_name}/pulls/${pr.number}`)).json()).author_waiting, 'the author waits');
  await first.close();
  const second = await startServer({ port, dataDir: data, ghBin: 'false', reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000 });
  try {
    await new Promise((r) => setTimeout(r, 4000)); // the wait retries every 3 seconds
    await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ body: 'Still there?' }) });
    const r = await waiting;
    assert.match(r.stdout, /Still there\?/);

    // Delivered but never confirmed (the CLI died, say): the next wait brings it again.
    const api = `${second.url}/api/repos/${registered.full_name}/pulls/${pr.number}`;
    const asAgent = { 'x-galley-actor': 'agent' };
    await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/comments`, { method: 'POST', headers: json, body: JSON.stringify({ body: 'Second?' }) });
    const once = await (await fetch(`${api}/wait?timeout=5`, { headers: asAgent })).json();
    const twice = await (await fetch(`${api}/wait?timeout=5`, { headers: asAgent })).json();
    assert.equal(once.status, 'feedback');
    assert.deepEqual(twice.comments, once.comments);
    assert.ok(once.pr.comments.some((cm: any) => cm.body === 'Second?'), 'the wait carries what is needed to show the feedback');
    const confirm = await fetch(`${api}/seen`, { method: 'PUT', headers: { ...asAgent, ...json }, body: JSON.stringify({ at: once.seen_at }) });
    assert.equal(confirm.status, 204);
    assert.equal((await (await fetch(`${api}/wait?timeout=1`, { headers: asAgent })).json()).status, 'timeout');
  } finally {
    await second.close();
    rmSync(data, { recursive: true, force: true });
  }
});

/**
 * What `pr wait` in `cwd` has printed by the time its confirmation (`PUT …/seen`) reached the
 * server, whose answer is lost on the way back.
 */
async function waitLosingSeen(cwd: string, n: number): Promise<string> {
  // Between the CLI and the server: the server takes the confirmation, and its answer is lost.
  let confirmed = false;
  const proxy = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers } as Record<string, string>;
    for (const h of ['host', 'connection', 'content-length']) delete headers[h];
    const answer = await fetch(server.url + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const body = Buffer.from(await answer.arrayBuffer());
    if (req.method === 'PUT' && req.url!.endsWith('/seen')) {
      confirmed = true;
      return;
    }
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const child = execFile(process.execPath, [BIN, 'pr', 'wait', String(n), '--timeout', '20s'], {
    cwd,
    env: { ...process.env, GALLEY_URL: `http://localhost:${(proxy.address() as AddressInfo).port}`, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '1', NO_COLOR: '1' },
  });
  let stdout = '';
  child.stdout!.on('data', (d) => (stdout += d));
  try {
    await until(() => confirmed, 'the confirmation reaches the server');
    await until(() => stdout, 'the wait prints what it got');
    return stdout;
  } finally {
    child.kill();
    proxy.closeAllConnections();
    proxy.close();
  }
}

test('pr wait says the reviewer agents are done before it confirms that it said so', async () => {
  const { stage } = await scratchRepo('handover');
  const pr = await stage('handover');
  const head = execFileSync('git', ['-C', join(dir, 'handover'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Stopped while it waits for the answer, the agent was told all the same.
  assert.match(await waitLosingSeen(join(dir, 'handover'), pr.number), new RegExp(`^No reviewer agent reviews ${head.slice(0, 7)}; ask the user to review it: `));
  // The server will not say it again.
  const res = await fetch(`${server.url}/api/repos/acme/handover/pulls/${pr.number}/wait?timeout=1`, { headers: { 'x-galley-actor': 'agent' } });
  assert.equal((await res.json()).status, 'timeout');
});

test('pr wait says the pull request was published before it confirms that it said so', async () => {
  const { api, stage } = await scratchRepo('published-notice');
  const pr = await stage('published-notice');
  await human('POST', `${api}/${pr.number}/publish`, {});
  assert.match(await waitLosingSeen(join(dir, 'published-notice'), pr.number), /^Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
  const res = await fetch(`${server.url}${api}/${pr.number}/wait?timeout=1`, { headers: { 'x-galley-actor': 'agent' } });
  assert.equal((await res.json()).status, 'timeout');
});

test('auto-publish stays on when the server restarts', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/auto-restart');
  writeFileSync(join(repo, 'restart.js'), 'export {};\n');
  git('add', 'restart.js');
  git('commit', '-qm', 'Add restart');
  const data = mkdtempSync(join(tmpdir(), 'galley-auto-restart-'));
  const options = { port: 0, dataDir: data, ghBin: join(dir, 'gh'), codexBin: join(dir, 'codex'), reviewersDir: join(data, 'reviewers'), viewerLogin: 'reviewer', pollMs: 60_000 };
  const json = { 'content-type': 'application/json' };
  const first = await startServer(options);
  t.after(async () => {
    await first.close();
    rmSync(data, { recursive: true, force: true });
  });
  const registered = await (await fetch(`${first.url}/api/repos`, { method: 'POST', headers: json, body: JSON.stringify({ path: repo }) })).json();
  const pr = await (
    await fetch(`${first.url}/api/repos/${registered.full_name}/pulls`, {
      method: 'POST',
      headers: { ...json, 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: 'Published after a restart', head: 'feature/auto-restart', base: 'main' }),
    })
  ).json();
  assert.equal((await fetch(`${first.url}/api/repos/${registered.full_name}/pulls/${pr.number}/auto-publish`, { method: 'PUT', headers: json, body: '{}' })).status, 200);
  await first.close();
  const second = await startServer(options);
  try {
    const api = `${second.url}/api/repos/${registered.full_name}/pulls/${pr.number}`;
    assert.equal((await (await fetch(api)).json()).auto_publish.enabled_by.login, 'reviewer');
    // The agent waits on the new server, which publishes.
    const r = await (await fetch(`${api}/wait?timeout=10`, { headers: { 'x-galley-actor': 'agent' } })).json();
    assert.equal(r.status, 'published');
    const timeline = await (await fetch(`${second.url}/api/repos/${registered.full_name}/issues/${pr.number}/timeline`)).json();
    assert.equal(timeline.findLast((e: any) => e.event === 'published').auto, true);
  } finally {
    await second.close();
    rmSync(data, { recursive: true, force: true });
  }
});

test('the CLI starts a server when none is running', async () => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const url = `http://localhost:${port}`;
  const home = mkdtempSync(join(tmpdir(), 'galley-autostart-'));
  try {
    const r = await exec(process.execPath, [BIN, 'pr', 'list'], { cwd: repo, env: { ...process.env, GALLEY_URL: url, GALLEY_HOME: home, GALLEY_ACTOR: 'agent', GALLEY_NO_AUTOSTART: '' } });
    assert.match(r.stderr, new RegExp(`Started the galley server at ${url}`));
    // It keeps running after the command that started it.
    const health = await (await fetch(`${url}/api/health`)).json();
    assert.equal(health.ok, true);
  } finally {
    // Stopped also when an assert failed, as long as it answers.
    const health = await fetch(`${url}/api/health`).then((res) => res.json(), () => null);
    if (health?.pid) process.kill(health.pid);
    rmSync(home, { recursive: true, force: true });
  }
  const off = await exec(process.execPath, [BIN, 'pr', 'list'], { cwd: repo, env: { ...process.env, GALLEY_URL: url, GALLEY_NO_AUTOSTART: '1' } }).catch((e) => e);
  assert.equal(off.code, 1);
  assert.match(off.stderr, /not running/);
});

test('the server says it is galley, and serve says who has its port', async () => {
  assert.deepEqual(await (await fetch(`${server.url}/api/meta`)).json(), { name: 'galley', version: '0.1.0' });
  const home = mkdtempSync(join(tmpdir(), 'galley-taken-'));
  const other = createHttpServer((req, res) => res.end('hello'));
  try {
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    // Its data in a directory of its own, should it start after all.
    const env = { ...process.env, GALLEY_HOME: home, GALLEY_CONFIG_DIR: home, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home };
    const serve = (port: string) => exec(process.execPath, [BIN, 'serve', '--port', port], { env, timeout: 20_000 }).catch((e) => e);
    const port = new URL(server.url).port;
    const running = await serve(port);
    assert.equal(running.code, 1);
    assert.match(running.stderr, new RegExp(`galley is already running at http://localhost:${port}`));
    const taken = await serve(String((other.address() as AddressInfo).port));
    assert.equal(taken.code, 1);
    assert.match(taken.stderr, /port \d+ is taken by another program\. Run galley on another port with GALLEY_PORT=<port> or --port, and set GALLEY_PORT for your agents too\./);
  } finally {
    other.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('images pasted into comments are stored, shown to agents, and warned about before publishing', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/images');
  writeFileSync(join(repo, 'images.js'), 'export {};\n');
  git('add', 'images.js');
  git('commit', '-qm', 'Add images.js');
  const created = await cli(['pr', 'create', '--title', 'Show images', '--body', 'Nothing to see.']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  // A 1x1 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const hash = createHash('sha256').update(png).digest('hex');
  const path = `/uploads/${hash}.png`;
  const upload = (body: Buffer<ArrayBuffer> | string, headers: Record<string, string> = { 'content-type': 'image/png' }) => fetch(`${server.url}/api/uploads`, { method: 'POST', headers, body });

  await t.test('an uploaded PNG is stored under its hash and served back as a PNG', async () => {
    const res = await upload(png);
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { path, url: server.url + path, content_type: 'image/png', size: png.length });
    assert.deepEqual(readFileSync(join(dir, 'data', 'uploads', `${hash}.png`)), png);
    const served = await fetch(server.url + path);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    // The bytes decide the type, whatever the request said; the same bytes are the same file.
    assert.equal((await (await upload(png, { 'content-type': 'image/jpeg' })).json()).path, path);
    assert.equal((await fetch(`${server.url}/uploads/${'0'.repeat(64)}.png`)).status, 404);
  });

  await t.test('only PNG, JPEG, GIF and WebP images of at most 10 MB are accepted', async () => {
    const kinds: [Buffer<ArrayBuffer>, string, string][] = [
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'jpg', 'image/jpeg'],
      [Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'gif', 'image/gif'],
      [Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), 'webp', 'image/webp'],
    ];
    for (const [bytes, ext, type] of kinds) {
      // Without a declared type, as from a file the browser does not know.
      const res = await upload(bytes, {});
      assert.equal(res.status, 201, ext);
      const { path: stored, content_type } = await res.json();
      assert.match(stored, new RegExp(`^/uploads/[0-9a-f]{64}\\.${ext}$`));
      assert.equal(content_type, type);
      assert.equal((await fetch(server.url + stored)).headers.get('content-type'), type);
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const asSvg = await upload(svg, { 'content-type': 'image/svg+xml' });
    assert.equal(asSvg.status, 415);
    assert.match((await asSvg.json()).message, /SVG images are not accepted/);
    // Declared as a PNG, but the bytes are not one.
    const disguised = await upload(svg);
    assert.equal(disguised.status, 415);
    assert.match((await disguised.json()).message, /this file is none of them/);
    assert.equal((await upload(Buffer.from('GIF8 and then some'))).status, 415);
    assert.equal((await upload(png, { 'content-type': 'text/html' })).status, 415);
    assert.equal((await upload(Buffer.alloc(0))).status, 422);
    const big = Buffer.alloc(png.length + 10 * 1024 * 1024);
    png.copy(big);
    const tooBig = await upload(big);
    assert.equal(tooBig.status, 413);
    assert.match((await tooBig.json()).message, /at most 10 MB/);
    // Also when the size is not declared up front.
    const chunks = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(png);
        for (let i = 0; i < 11; i++) ctl.enqueue(new Uint8Array(1024 * 1024));
        ctl.close();
      },
    });
    const streamed = await fetch(`${server.url}/api/uploads`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: chunks, duplex: 'half' } as RequestInit);
    assert.equal(streamed.status, 413);
  });

  await t.test('uploads from other sites are refused', async () => {
    const res = await fetch(`${server.url}/api/uploads`, { method: 'POST', headers: { 'content-type': 'image/png', origin: 'https://evil.example' }, body: png });
    assert.equal(res.status, 403);
  });

  await t.test('rendered Markdown keeps uploaded images, and no other local ones', async () => {
    const render = async (text: string) => (await fetch(`${server.url}/api/markdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).text();
    assert.match(await render(`![screenshot](${path})`), new RegExp(`<img src="${path}" alt="screenshot" />`));
    assert.match(await render(`<img src="${path}" width="200">`), new RegExp(`<img src="${path}" width="200" />`));
    assert.match(await render('![remote](https://example.com/a.png)'), /<img src="https:\/\/example\.com\/a\.png" alt="remote" \/>/);
    for (const src of [
      '/api/repos/acme/widgets/pulls/1',
      `/uploads/${hash}.svg`,
      `/uploads/${hash}.png/../../galley.db`,
      '//evil.example/a.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    ]) {
      for (const text of [`![x](${src})`, `<img src="${src}" alt="x">`]) assert.match(await render(text), /^(<p>)?<img alt="x" \/>(<\/p>)?$/m, text);
    }
  });

  await t.test('pr wait and pr view --comments list the images, and --download-images saves them', async () => {
    await handedOver(number);
    const waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
    await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
    await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: `It is cut off:\n\n![screenshot](${path})` });
    const woken = await waiting;
    assert.equal(woken.code, 0, woken.stderr);
    assert.match(woken.stdout, new RegExp(`^    !\\[screenshot\\]\\(${path}\\)\n    Image: ${server.url}${path}$`, 'm'));
    assert.match(woken.stdout, new RegExp(`galley pr view s${number} --comments --download-images <dir>`));

    await human('POST', `${base}/reviews`, { event: 'COMMENT', comments: [{ path: 'images.js', line: 1, side: 'RIGHT', body: `Like this:\n![after](${path})` }] });
    const view = await cli(['pr', 'view', String(number), '--comments']);
    assert.equal(view.code, 0, view.stderr);
    assert.equal(view.stdout.match(new RegExp(`Image: ${server.url}${path}$`, 'gm'))?.length, 2, 'under the comment and under the thread comment');
    assert.match(view.stdout, /Run again with --download-images <dir>/);

    const saveTo = join(dir, 'images');
    const saved = await cli(['pr', 'view', String(number), '--comments', '--download-images', saveTo]);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.stdout.match(new RegExp(`Image: ${join(saveTo, `${hash}.png`)}$`, 'gm'))?.length, 2);
    assert.doesNotMatch(saved.stdout, /download-images|Image: http/);
    assert.deepEqual(readFileSync(join(saveTo, `${hash}.png`)), png);
  });

  await t.test('the publish box warns about images in the description, not in comments', async () => {
    const page = async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text();
    const before = await page();
    assert.match(before, /js-attach-image/);
    assert.doesNotMatch(before, /stored in galley/);
    await human('PATCH', base, { body: `Before and after:\n\n![before](${path})\n![after](${path.replace('.png', '.gif')})` });
    assert.match(await page(), /The description has 2 images stored in galley, which GitHub cannot show\. Remove them, or replace them with images uploaded to GitHub\./);
  });
});

test('browsing the repository at a commit of a pull request', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/browse');
  const numbered = (n: number, change: (i: number) => string | null = () => null) =>
    Array.from({ length: n }, (_, k) => change(k + 1) ?? `export const v${k + 1} = ${k + 1};`).join('\n') + '\n';
  mkdirSync(join(repo, 'dir with space'));
  writeFileSync(
    join(repo, 'dir with space', 'notes.md'),
    '# Notes\n\nSee [math](../math.js) and ![logo](../logo.png).\n\nFrom the root: [long](/long.js) ![root logo](/logo.png), [elsewhere](//example.com/x).\n\n![icon](../icon.svg) ![big](../big.svg) ![web](https://example.com/w.png) ![other](//example.com/o.png)\n\n[up](../) and [root](/)\n',
  );
  writeFileSync(join(repo, 'big.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(300_000)} --></svg>\n`);
  writeFileSync(join(repo, 'long.js'), numbered(60));
  writeFileSync(join(repo, 'page.html'), '<!doctype html><script>alert(document.cookie)</script>\n');
  writeFileSync(join(repo, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n');
  writeFileSync(join(repo, 'logo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  writeFileSync(join(repo, 'data.bin'), Buffer.from([0, 1, 2, 0, 3]));
  writeFileSync(join(repo, 'doomed.txt'), 'gone soon\n');
  mkdirSync(join(repo, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(repo, 'nested', 'deeper', 'leaf.txt'), 'leaf\n');
  writeFileSync(join(repo, 'nested', 'top.txt'), 'top\n');
  git('add', '-A');
  git('commit', '-qm', 'Add files to browse');
  const base = git('rev-parse', 'HEAD');
  git('branch', 'browse-base');
  // The pull request changes lines 10 and 50 of long.js; lines 14 to 46 stay unchanged, outside the diff.
  writeFileSync(join(repo, 'long.js'), numbered(60, (i) => (i === 10 || i === 50 ? `export const v${i} = -${i};` : null)));
  git('rm', '-q', 'doomed.txt');
  git('commit', '-qam', 'Negate two values');
  const head = git('rev-parse', 'HEAD');
  const created = await cli(['pr', 'create', '--title', 'Negate', '--body', 'x', '--base', 'browse-base']);
  assert.equal(created.code, 0, created.stderr);
  const n = Number(created.stdout.trim().split('/').pop());
  const page = async (path: string) => {
    const res = await fetch(server.url + path, { redirect: 'manual' });
    return { status: res.status, type: res.headers.get('content-type'), location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  };

  await t.test('tree and blob views, with a path that has a space', async () => {
    const root = await page(`/acme/widgets/tree/${head.slice(0, 7)}`);
    assert.equal(root.status, 200);
    assert.match(root.text, new RegExp(`<a href="/acme/widgets/tree/${head}/dir%20with%20space">dir with space</a>`));
    assert.match(root.text, new RegExp(`<a href="/acme/widgets/blob/${head}/long.js">long.js</a>`));
    assert.doesNotMatch(root.text, /doomed\.txt/);
    const dir = await page(`/acme/widgets/tree/${head}/dir%20with%20space`);
    assert.equal(dir.status, 200);
    assert.match(dir.text, /<a href="[^"]*\/dir%20with%20space\/notes\.md">notes\.md<\/a>/);
    // The README-like rendering and Markdown links point into the same commit.
    const md = await page(`/acme/widgets/blob/${head}/dir%20with%20space/notes.md`);
    assert.equal(md.status, 200);
    assert.match(md.text, new RegExp(`<a href="/acme/widgets/blob/${head}/math\\.js">math</a>`));
    assert.match(md.text, new RegExp(`<img src="/acme/widgets/raw/${head}/logo\\.png"`));
    // "/x" is from the repository's root; "//host/x" is another site.
    assert.match(md.text, new RegExp(`<a href="/acme/widgets/blob/${head}/long\\.js">long</a>`));
    assert.match(md.text, new RegExp(`<img src="/acme/widgets/raw/${head}/logo\\.png" alt="root logo"`));
    assert.match(md.text, /<a href="\/\/example\.com\/x">elsewhere<\/a>/);
    // /raw serves SVG as text, so SVG images go inline; one too big to inline becomes a link.
    assert.match(md.text, /<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+\/=]+" alt="icon"/);
    assert.match(md.text, new RegExp(`<a href="/acme/widgets/blob/${head}/big\\.svg">big</a>`));
    // Other images stay only when they come from the web, as in comments.
    assert.match(md.text, /<img src="https:\/\/example\.com\/w\.png" alt="web"/);
    assert.match(md.text, /<img alt="other"/);
    // The root is a directory, at /tree; /blob without a path goes there too.
    assert.match(md.text, new RegExp(`<a href="/acme/widgets/tree/${head}">up</a> and <a href="/acme/widgets/tree/${head}">root</a>`));
    assert.equal((await page(`/acme/widgets/blob/${head}`)).location, `/acme/widgets/tree/${head}`);
    // Rendered files carry their source's URL, where app.js sends #L12 links.
    assert.match(md.text, new RegExp(`<div class="blob-body" data-plain="/acme/widgets/blob/${head}/dir%20with%20space/notes\\.md\\?plain=1">`));
    assert.match((await page(`/acme/widgets/blob/${head}/icon.svg`)).text, /data-plain="[^"]*\/icon\.svg\?plain=1"/);
    const plain = await page(`/acme/widgets/blob/${head}/dir%20with%20space/notes.md?plain=1`);
    assert.match(plain.text, /<td id="L3" class="blob-num js-line-number" data-num="3"><\/td>/);
    assert.doesNotMatch(plain.text, /data-plain=/);
    const code = await page(`/acme/widgets/blob/${head}/long.js`);
    assert.match(code.text, /<td id="L60" class="blob-num js-line-number" data-num="60"><\/td><td class="blob-code"><span class="hljs-keyword">export<\/span>/);
    assert.match(code.text, /60 lines/);
    // The base commit still has the deleted file.
    assert.equal((await page(`/acme/widgets/blob/${base}/doomed.txt`)).status, 200);
    // A directory at a /blob URL and a file at a /tree URL go where they belong.
    assert.equal((await page(`/acme/widgets/blob/${head}/dir%20with%20space`)).location, `/acme/widgets/tree/${head}/dir%20with%20space`);
    assert.equal((await page(`/acme/widgets/tree/${head}/long.js`)).location, `/acme/widgets/blob/${head}/long.js`);
  });

  await t.test('raw files never run as HTML on this origin', async () => {
    const html = await page(`/acme/widgets/raw/${head}/page.html`);
    assert.equal(html.status, 200);
    assert.equal(html.type, 'text/plain; charset=utf-8');
    assert.equal(html.text, '<!doctype html><script>alert(document.cookie)</script>\n');
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    assert.match(html.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(html.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal((await page(`/acme/widgets/raw/${head}/icon.svg`)).type, 'text/plain; charset=utf-8');
    assert.equal((await page(`/acme/widgets/raw/${head}/logo.png`)).type, 'image/png');
    const bin = await page(`/acme/widgets/raw/${head}/data.bin`);
    assert.equal(bin.type, 'application/octet-stream');
    assert.equal(bin.headers.get('content-disposition'), "attachment; filename*=UTF-8''data.bin");
    const spaced = await page(`/acme/widgets/raw/${head}/dir%20with%20space/notes.md`);
    assert.match(spaced.text, /^# Notes/);
  });

  await t.test('unknown commits and paths are not found', async () => {
    for (const path of [
      `/acme/widgets/tree/${'0'.repeat(40)}`,
      `/acme/widgets/tree/not-a-sha`,
      `/acme/widgets/blob/${head}/nope.js`,
      `/acme/widgets/raw/${head}/nope.js`,
      `/acme/widgets/raw/${head}/dir%20with%20space`,
      `/acme/widgets/tree/${head}/dir%20with%20space/..%2F..%2Fetc`,
      `/acme/widgets/blob_excerpt/${head}?path=nope.js&from=1&to=2&delta=0`,
      `/acme/nothing/tree/${head}`,
    ]) {
      assert.equal((await page(path)).status, 404, path);
    }
    assert.equal((await page(`/acme/widgets/blob_excerpt/${head}?path=long.js&from=a&to=2&delta=0`)).status, 400);
  });

  await t.test('a file tree beside the pages, open down to the page, its directories loading when opened', async () => {
    const at = (path: string) => `/acme/widgets/${path}`.replace('@', head);
    // A file: its directories open, the file highlighted, other directories closed and empty.
    const leaf = await page(at('blob/@/nested/deeper/leaf.txt'));
    assert.match(leaf.text, new RegExp(`<nav class="file-tree browse-tree js-browse-tree" aria-label="Files" data-sha="${head}" data-items="/acme/widgets/file-tree/${head}" data-paths="/acme/widgets/tree-list/${head}"`));
    assert.match(leaf.text, /<details data-path="nested" open><summary>/);
    assert.match(leaf.text, /<details data-path="nested\/deeper" open><summary>/);
    assert.match(leaf.text, new RegExp(`<a href="/acme/widgets/blob/${head}/nested/deeper/leaf\\.txt" aria-current="page">`));
    assert.match(leaf.text, new RegExp(`<a href="/acme/widgets/blob/${head}/nested/top\\.txt">`));
    assert.match(leaf.text, /<details data-path="dir with space"><summary>/);
    assert.doesNotMatch(leaf.text, /notes\.md/);
    assert.equal(leaf.text.match(/aria-current="page"/g)?.length, 1);
    // A directory: open and highlighted itself.
    const dirPage = await page(at('tree/@/nested/deeper'));
    assert.match(dirPage.text, new RegExp(`<a class="tree-name" href="/acme/widgets/tree/${head}/nested/deeper" aria-current="page">deeper</a>`));
    assert.match(dirPage.text, /<details data-path="nested\/deeper" open><summary>/);
    // The root: nothing open, directories before files.
    const root = await page(at('tree/@'));
    assert.doesNotMatch(root.text, /<details data-path="[^"]*" open>/);
    assert.doesNotMatch(root.text, /aria-current/);
    assert.match(root.text, /data-path="nested"[^]*long\.js/);

    // A directory's items, as the tree loads them.
    const items = await page(at('file-tree/@/nested'));
    assert.equal(items.status, 200);
    assert.match(items.text, /^<ul><li class="tree-dir"><details data-path="nested\/deeper"><summary>/);
    assert.match(items.text, new RegExp(`<a href="/acme/widgets/blob/${head}/nested/top\\.txt">.*<span class="tree-name">top\\.txt</span></a></li></ul>$`));
    assert.match((await page(at('file-tree/@/dir%20with%20space'))).text, new RegExp(`<a href="/acme/widgets/blob/${head}/dir%20with%20space/notes\\.md">`));
    assert.match((await page(at('file-tree/@'))).text, /data-path="nested"/);
    for (const path of ['file-tree/@/long.js', 'file-tree/@/nope', 'file-tree/@/nested/..%2F..%2Fetc', `file-tree/${'0'.repeat(40)}`, 'file-tree/not-a-sha/nested', 'tree-list/not-a-sha']) {
      assert.equal((await page(at(path))).status, 404, path);
    }

    // Every file's path, for "Go to file"; the browser keeps it when asked by full SHA.
    const list = await page(at('tree-list/@'));
    const paths: string[] = JSON.parse(list.text).paths;
    assert.ok(paths.includes('nested/deeper/leaf.txt') && paths.includes('dir with space/notes.md') && paths.includes('long.js'), paths.join());
    assert.ok(!paths.includes('doomed.txt') && !paths.includes('nested'), paths.join());
    assert.match(list.headers.get('cache-control')!, /immutable/);
    assert.equal((await page(`/acme/widgets/tree-list/${head.slice(0, 7)}`)).headers.get('cache-control'), null);
  });

  await t.test('the unfold arrows load lines of the file as diff rows', async () => {
    const files = await page(`/acme/widgets/pull/${n}/files`);
    assert.match(files.text, new RegExp(`data-excerpt="/acme/widgets/blob_excerpt/${head}\\?path=long\\.js"`));
    // Lines 14 to 46 are folded between the hunks, and lines 54 to 60 after the last.
    assert.match(files.text, /<tr class="hunk-row" data-gap-from="14" data-gap-to="46" data-delta="0"/);
    assert.match(files.text, /<tr class="hunk-row hunk-row-end" data-gap-from="54" data-gap-to="60" data-delta="0"/);
    assert.match(files.text, new RegExp(`href="/acme/widgets/blob/${head}/long\\.js">View file`));
    assert.match(files.text, new RegExp(`href="/acme/widgets/blob/${base}/doomed\\.txt">View old version`));
    const rows = await page(`/acme/widgets/blob_excerpt/${head}?path=long.js&from=20&to=22&delta=2`);
    assert.equal(rows.status, 200);
    assert.deepEqual([...rows.text.matchAll(/<tr class="line context"><td class="blob-num blob-num-context" data-num="(\d+)"><\/td><td class="blob-num blob-num-context" data-num="(\d+)"><\/td><td class="blob-code blob-code-context " data-side="RIGHT" data-line="(\d+)"/g)].map((m) => m.slice(1).map(Number)), [[18, 20, 20], [19, 21, 21], [20, 22, 22]]);
    assert.match(rows.text, /export<\/span> <span class="hljs-keyword">const<\/span> v20/);
    const split = await page(`/acme/widgets/blob_excerpt/${head}?path=long.js&from=20&to=20&delta=0&diff=split`);
    assert.match(split.text, /data-side="LEFT" data-line="20"[^]*data-side="RIGHT" data-line="20"/);
    // Past the end of the file there is nothing to load.
    assert.equal((await page(`/acme/widgets/blob_excerpt/${head}?path=long.js&from=61&to=80&delta=0`)).text, '');
  });

  await t.test('lines loaded by the arrows can carry comments, which follow them across pushes', async () => {
    const comment = await human('POST', `/api/repos/acme/widgets/pulls/${n}/comments`, { path: 'long.js', line: 30, side: 'RIGHT', body: 'Negate this one too.' });
    assert.equal(comment.line, 30);
    assert.equal(comment.diff_hunk, '@@ -27,4 +27,4 @@\n export const v27 = 27;\n export const v28 = 28;\n export const v29 = 29;\n export const v30 = 30;');
    const range = await human('POST', `/api/repos/acme/widgets/pulls/${n}/comments`, { path: 'long.js', start_line: 8, line: 20, side: 'RIGHT', body: 'From a changed line into folded ones.' });
    assert.match(range.diff_hunk, /v8 = 8;[^]*v10 = -10;[^]*v20 = 20;$/);
    for (const bad of [{ line: 61 }, { line: -1 }, { start_line: 70, line: 30 }]) {
      const res = await fetch(`${server.url}/api/repos/acme/widgets/pulls/${n}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'long.js', side: 'RIGHT', body: 'x', ...bad }) });
      assert.equal(res.status, 422, JSON.stringify(bad));
    }
    // The Files changed tab shows the thread with the lines around it, as if expanded.
    const files = await page(`/acme/widgets/pull/${n}/files`);
    assert.match(files.text, /data-side="RIGHT" data-line="33"/);
    assert.match(files.text, /Negate this one too\./);
    let threads = JSON.parse((await cli(['pr', 'view', String(n), '--json', 'reviewThreads'])).stdout).reviewThreads;
    assert.deepEqual(threads.map((th: any) => [th.line, th.isOutdated]), [[30, false], [20, false]]);
    // Two lines added at the top: the threads move down with their lines and are not outdated.
    writeFileSync(join(repo, 'long.js'), '// one\n// two\n' + numbered(60, (i) => (i === 10 || i === 50 ? `export const v${i} = -${i};` : null)));
    git('commit', '-qam', 'Add a header');
    threads = JSON.parse((await cli(['pr', 'view', String(n), '--json', 'reviewThreads'])).stdout).reviewThreads;
    assert.deepEqual(threads.map((th: any) => [th.line, th.isOutdated]), [[32, false], [22, false]]);
    // Changing the line itself makes it outdated, as for any comment.
    writeFileSync(join(repo, 'long.js'), '// one\n// two\n' + numbered(60, (i) => (i === 10 || i === 50 || i === 30 ? `export const v${i} = -${i};` : null)));
    git('commit', '-qam', 'Negate v30');
    threads = JSON.parse((await cli(['pr', 'view', String(n), '--json', 'reviewThreads'])).stdout).reviewThreads;
    assert.deepEqual(threads.map((th: any) => th.isOutdated), [true, false]);
  });

  await t.test('commits and revisions link to their tree', async () => {
    const commits = await page(`/acme/widgets/pull/${n}/commits`);
    assert.match(commits.text, new RegExp(`href="/acme/widgets/tree/${head}" title="Browse the repository at this commit"`));
    const conversation = await page(`/acme/widgets/pull/${n}`);
    assert.match(conversation.text, new RegExp(`href="/acme/widgets/tree/${head}" title="Browse the repository at this revision"`));
  });

  await t.test('galley browse prints the URL of a pull request, file or directory', async () => {
    const browse = async (...args: string[]) => {
      const r = await cli(['browse', ...args]);
      assert.equal(r.code, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(await browse('long.js:12', '--commit', head), `${server.url}/acme/widgets/blob/${head}/long.js#L12`);
    assert.equal(await browse(`--commit=${head.slice(0, 7)}`, 'long.js:12-14'), `${server.url}/acme/widgets/blob/${head}/long.js#L12-L14`);
    const now = git('rev-parse', 'HEAD');
    assert.equal(await browse('dir with space/notes.md:2'), `${server.url}/acme/widgets/blob/${now}/dir%20with%20space/notes.md?plain=1#L2`);
    assert.equal(await browse('icon.svg:1'), `${server.url}/acme/widgets/blob/${now}/icon.svg?plain=1#L1`);
    assert.equal(await browse('icon.svg'), `${server.url}/acme/widgets/blob/${now}/icon.svg`);
    assert.equal(await browse('dir with space/', '-c'), `${server.url}/acme/widgets/tree/${now}/dir%20with%20space`);
    assert.equal(await browse(String(n)), `${server.url}/acme/widgets/pull/${n}`);
    assert.equal(await browse(), `${server.url}/acme/widgets`);
    assert.equal(await browse(head.slice(0, 7)), `${server.url}/acme/widgets/tree/${head}`);
    // A number is a pull request when there is one; otherwise all digits can be a commit SHA.
    const digits = digitCommit(head);
    assert.equal(await browse(digits.slice(0, 7)), `${server.url}/acme/widgets/tree/${digits}`);
    const none = await cli(['browse', '99999']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no pull request s#99999 in acme\/widgets/);
    const neither = await cli(['browse', '1234567']);
    assert.equal(neither.code, 1);
    assert.match(neither.stderr, /no pull request or commit "1234567" in acme\/widgets/);
    const missing = await cli(['browse', 'doomed.txt']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /doomed\.txt does not exist at [0-9a-f]{7}/);
    // The URLs work.
    assert.equal((await page(new URL(await browse('long.js:12', '--commit', head)).pathname)).status, 200);
  });

  await t.test('galley browse --repo looks up commits and paths in that repository, through the server', async () => {
    const other = join(dir, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', other]);
    execFileSync('git', ['-C', other, '-c', 'commit.gpgsign=false', '-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-q', '--allow-empty', '-m', 'Other']);
    const browseFrom = (cwd: string, ...args: string[]) =>
      exec(process.execPath, [BIN, 'browse', ...args], { cwd, env: { ...process.env, GALLEY_URL: server.url, GALLEY_ACTOR: 'agent', NO_COLOR: '1' } }).then(
        (r) => r.stdout.trim(),
        (e) => `exit ${e.code}: ${e.stderr.trim()}`,
      );
    // Without --commit, HEAD of that repository's checkout.
    const now = git('rev-parse', 'HEAD');
    for (const cwd of [other, dir]) {
      assert.equal(await browseFrom(cwd, '-R', 'acme/widgets', 'dir with space/notes.md:2'), `${server.url}/acme/widgets/blob/${now}/dir%20with%20space/notes.md?plain=1#L2`, cwd);
    }
    assert.equal(await browseFrom(other, '-R', 'acme/widgets', 'long.js:3', '--commit', head.slice(0, 7)), `${server.url}/acme/widgets/blob/${head}/long.js#L3`);
    assert.equal(await browseFrom(other, '--repo=acme/widgets', '-b', 'browse-base', 'doomed.txt'), `${server.url}/acme/widgets/blob/${base}/doomed.txt`);
    assert.equal(await browseFrom(other, '-R', 'acme/widgets', '/dir with space/'), `${server.url}/acme/widgets/tree/${now}/dir%20with%20space`);
    assert.match(await browseFrom(other, '-R', 'acme/widgets', 'nope.js'), /^exit 1: nope\.js does not exist at [0-9a-f]{7}$/);
    assert.match(await browseFrom(other, '-R', 'acme/widgets', '-c', 'nope', 'long.js'), /^exit 1: no commit "nope" in acme\/widgets$/);

    // The GitHub endpoints it uses.
    const api = async (endpoint: string) => {
      const r = await cli(['api', endpoint]);
      return r.code === 0 ? JSON.parse(r.stdout) : r.stderr;
    };
    assert.deepEqual((await api(`repos/{owner}/{repo}/contents/dir%20with%20space?ref=${head}`)).map((e: any) => [e.type, e.path]), [['file', 'dir with space/notes.md']]);
    const file = await api(`repos/{owner}/{repo}/contents/long.js?ref=${base}`);
    assert.equal(Buffer.from(file.content, 'base64').toString(), numbered(60));
    assert.equal(file.html_url, `${server.url}/acme/widgets/blob/${base}/long.js`);
    assert.equal((await api('repos/{owner}/{repo}/commits/browse-base')).sha, base);
    assert.match(await api(`repos/{owner}/{repo}/contents/nope.js?ref=${head}`), /HTTP 404/);
    assert.match(await api('repos/{owner}/{repo}/commits/nope'), /No commit found for SHA: nope \(HTTP 422\)/);
  });
});

test('the file tree counts the unresolved conversations on each file in the diff shown', async () => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/tree');
  const five = (name: string, change: (i: number) => string | null = () => null) =>
    Array.from({ length: 5 }, (_, k) => change(k + 1) ?? `export const ${name}${k + 1} = ${k + 1};`).join('\n') + '\n';
  writeFileSync(join(repo, 'one.js'), five('one'));
  writeFileSync(join(repo, 'two.js'), five('two'));
  git('add', '-A');
  git('commit', '-qm', 'Add one and two');
  const first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'two.js'), five('two', (i) => (i === 1 ? 'export const two1 = -1;' : null)));
  git('commit', '-qam', 'Negate two1');
  const created = await cli(['pr', 'create', '--title', 'Tree', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const n = Number(created.stdout.trim().split('/').pop());
  const api = `/api/repos/acme/widgets/pulls/${n}`;
  const comment = (body: object) => human('POST', `${api}/comments`, body);

  /** Each file in the tree with the conversations its bubble goes to, after checking the count it shows. */
  const tree = async (query = '') => {
    const text = await (await fetch(`${server.url}/acme/widgets/pull/${n}/files${query}`)).text();
    const out: Record<string, number[]> = {};
    for (const [, path, row] of text.matchAll(/<li class="tree-file[^"]*"><a [^>]*data-path="([^"]+)">([^]*?)<\/li>/g)) {
      const bubble = row.match(/<button type="button" class="tree-threads js-tree-threads" data-threads="([\d ]+)" aria-label="(\d+) unresolved conversations?"[^>]*><svg[^]*?<\/svg>(\d+)<\/button>/);
      const ids = bubble ? bubble[1].split(' ').map(Number) : [];
      if (bubble) assert.deepEqual([Number(bubble[2]), Number(bubble[3])], [ids.length, ids.length], path);
      else assert.doesNotMatch(row, /tree-threads/, path);
      out[path] = ids;
    }
    return out;
  };

  const lower = await comment({ path: 'one.js', line: 4, side: 'RIGHT', body: 'Open, lower.' });
  const higher = await comment({ path: 'one.js', line: 2, side: 'RIGHT', body: 'Open, higher.' });
  const about = await comment({ path: 'one.js', subject_type: 'file', body: 'About the file.' });
  const resolved = await comment({ path: 'one.js', line: 3, side: 'RIGHT', body: 'Resolved.' });
  await human('PUT', `${api}/threads/${resolved.id}/resolved`);
  // The reviewer's own pending comments are not conversations yet.
  await human('POST', `${api}/pending-comments`, { path: 'one.js', line: 5, body: 'Pending.' });
  const soonOutdated = await comment({ path: 'two.js', line: 5, side: 'RIGHT', body: 'Soon outdated.' });
  // On the first commit's diff; the second commit changed the line, so it is outdated in the pull request's.
  const onFirst = await comment({ path: 'two.js', line: 1, side: 'RIGHT', commit_id: first, body: 'On the first commit.' });

  // In page order: the lines from the top, then the conversations about the whole file.
  assert.deepEqual(await tree(), { 'one.js': [higher.id, lower.id, about.id], 'two.js': [soonOutdated.id] });
  assert.deepEqual(await tree(`?commit=${first}`), { 'one.js': [], 'two.js': [onFirst.id] });
  assert.deepEqual(await tree(`?range=${first}..${git('rev-parse', 'HEAD')}`), { 'two.js': [] });

  // Resolving, reopening and pushing change the counts.
  await human('PUT', `${api}/threads/${higher.id}/resolved`);
  await human('DELETE', `${api}/threads/${resolved.id}/resolved`);
  writeFileSync(join(repo, 'two.js'), five('two', (i) => (i === 1 ? 'export const two1 = -1;' : i === 5 ? 'export const two5 = -5;' : null)));
  git('commit', '-qam', 'Negate two5');
  assert.deepEqual(await tree(), { 'one.js': [resolved.id, lower.id, about.id], 'two.js': [] });
  assert.deepEqual(await tree('?diff=split'), { 'one.js': [resolved.id, lower.id, about.id], 'two.js': [] });
});

test('whose turn it is: the author agent, the reviewer agents, or the reviewer', async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/turns');
  writeFileSync(join(repo, 'turns.js'), 'export const turns = 1;\n');
  git('add', 'turns.js');
  git('commit', '-qm', 'Add turns');
  const created = await cli(['pr', 'create', '--title', 'Take turns', '--body', 'x']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  const page = async (path: string) => (await fetch(server.url + path)).text();
  /** Whose turn it is, and the reasons' text, as the API has them. */
  const turn = async (): Promise<{ whose: string; reasons: string[] }> => {
    const { turn } = await human('GET', base);
    return { whose: turn.whose, reasons: turn.reasons.map((r: any) => r.text) };
  };
  /** The tab and the group the front page shows this pull request in. */
  const group = async () => {
    for (const tab of ['staged', 'published']) {
      const groups = (await page(`/?state=${tab}`)).split('<div class="Box-row turn-group">').slice(1);
      const title = groups.find((g) => g.includes(`href="/acme/widgets/pull/${number}"`))?.match(/<h2 class="turn-group-title">([^<]+)<\/h2>/)?.[1];
      if (title) return `${tab}: ${title}`;
    }
  };
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  /** What a list page notifies about: your turn in every repository (data-your-turn). */
  const yourTurn = (html: string): { id: number; title: string; url: string; reasons: string }[] =>
    JSON.parse(html.match(/data-your-turn="([^"]*)"/)![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  /** This pull request's row on a list page. */
  const rowOf = (html: string) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/widgets/pull/${number}"`));
  /** A wait counts for a few seconds after it ends, as pages show it (Service.setWaiting); until then the author still waits. */
  const waitEnded = () => until(() => !server.service.waiters.has(id) && !server.service['waitingStopped'].has(id), 'the wait is over');
  const threadId = async () => JSON.parse((await cli(['pr', 'view', String(number), '--json', 'reviewThreads'])).stdout).reviewThreads[0].databaseId;
  // Codex's first review waits for this gate, which stays open once opened.
  const gate = join(dir, 'turn-gate');
  const review = { summary: 'One thing.', comments: [{ path: 'turns.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name it.' }] };
  await withFakes({ FAKE_CODEX_GATE: gate, FAKE_CODEX_REVIEW: JSON.stringify(review) }, async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 2 });
    try {
      await t.test("staged and not waiting: the author's, to start Codex", async () => {
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', `codex-review reviews ${sha()} when agent waits for review`] });
        assert.equal(await group(), 'staged: With agents');
        assert.ok(!yourTurn(await page('/')).some((x) => x.id === id), 'not your turn');
        assert.match((await cli(['pr', 'status'])).stdout, /^ {4}- the author's turn: agent has not asked for review yet \(pr wait\), 1 min; codex-review reviews [0-9a-f]{7} when agent waits for review$/m);
      });

      let waiting: ReturnType<typeof cli>;
      await t.test("waiting while Codex reviews: the reviewer agents'", async () => {
        waiting = cli(['pr', 'wait', String(number), '--timeout', '20s']);
        await until(() => server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
        const { turn } = await human('GET', base);
        assert.equal(turn.whose, 'reviewer_agents');
        const { since, ...reviewing } = turn.reasons[0];
        assert.deepEqual(reviewing, { kind: 'reviewer_agent', state: 'reviewing', to_review: true, text: `codex-review is reviewing ${sha()}`, engine: 'codex', reviewer: 'codex' });
        assert.ok(Date.now() - Date.parse(since) < 20_000);
        assert.equal(turn.reasons[1].text, 'agent is waiting for review');
        // gh JSON says it in words, with how long it has been so.
        const view = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
        assert.deepEqual(view, { turn: { whose: 'REVIEWER_AGENTS', reasons: [`codex-review is reviewing ${sha()}, 1 min`, 'agent is waiting for review, 1 min'] } });
        assert.equal(await group(), 'staged: With agents');
        // The list says it shorter, with the reason in full as its tooltip, and the reviewer agent's avatar at the row's end.
        const front = await page('/');
        assert.match(front, new RegExp(`<span class="turn-reason" title="codex-review is reviewing ${sha()}"><svg class="octicon octicon-dot-fill turn-mark turn-pulse"[^>]*>.*?</svg>codex-review reviewing<span class="turn-since"><relative-time [^>]*data-format="duration"`));
        assert.match(rowOf(front)!, /<span class="turn-avatar" title="codex-review is reviewing [0-9a-f]{7}"><img class="avatar avatar-bot"/);
      });

      await t.test("handed Codex's findings: the author's, until it acts", async () => {
        writeFileSync(gate, '');
        const r = await waiting;
        assert.match(r.stdout, /codex-review reviewed: commented/);
        await server.service.codex!.settle(id);
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent is working on the feedback', `codex-review commented on ${sha()}`, '1 unresolved thread'] });
        assert.equal(await group(), 'staged: With agents');
      });

      await t.test("answered and not waiting: the reviewer's", async () => {
        await waitEnded();
        const reply = await cli(['pr', 'comment', String(number), '--reply-to', String(await threadId()), '-b', 'It is named after what it counts.']);
        assert.equal(reply.code, 0, reply.stderr);
        assert.deepEqual(await turn(), {
          whose: 'reviewer',
          reasons: ['agent is not waiting', 'no review from reviewer yet', 'agent answered 1 thread', `codex-review's findings in ${sha()} are answered`, '1 unresolved thread'],
        });
        const front = await page('/');
        assert.equal(await group(), 'staged: Your turn');
        assert.deepEqual(yourTurn(front).find((x) => x.id === id), {
          id,
          title: 'Take turns',
          url: `/acme/widgets/pull/${number}`,
          reasons: `agent is not waiting, 1 min · no review from reviewer yet · agent answered 1 thread · codex-review's findings in ${sha()} are answered · 1 unresolved thread`,
        });
        // The tab's title counts the pull requests waiting for the reviewer.
        assert.match(front, new RegExp(`<title>\\(${yourTurn(front).length}\\) Staged pull requests · galley</title>`));
        assert.match((await cli(['pr', 'status'])).stdout, /^ {4}- the user's turn: agent is not waiting, 1 min; no review from reviewer yet; agent answered 1 thread;/m);
      });

      await t.test("feedback the author does not wait for: still the reviewer's, saying so", async () => {
        await human('POST', `${base}/reviews`, { event: 'REQUEST_CHANGES', body: 'Count something else.' });
        assert.deepEqual(await turn(), {
          whose: 'reviewer',
          reasons: ['agent has not seen the latest feedback', 'agent is not waiting', `codex-review's findings in ${sha()} are answered`, 'changes requested', '1 unresolved thread'],
        });
        // While a wait hands it over, it is the author's.
        server.service.waiters.set(id, 1);
        try {
          assert.equal(server.service.turn(row()).whose, 'author');
        } finally {
          server.service.waiters.delete(id);
        }
        // Reading it is being handed it.
        await cli(['pr', 'view', String(number), '--comments']);
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent is working on the feedback', `codex-review's findings in ${sha()} are answered`, 'changes requested', '1 unresolved thread'] });
      });

      await t.test("a push, and a review from Codex that finds nothing: the reviewer's", async () => {
        assert.equal((await cli(['pr', 'comment', String(number), '--reply-to', String(await threadId()), '--resolve', '-b', 'Renamed.'])).code, 0);
        writeFileSync(join(repo, 'turns.js'), 'export const rounds = 1;\n');
        git('commit', '-qam', 'Count rounds');
        // Codex reviews the new commit once the author waits: until then, the author's turn.
        await until(async () => (await turn()).whose === 'author', "the author's turn after its push");
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', `codex-review reviews ${sha()} when agent waits for review`, 'changes requested'] });
        const r = await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine now.', comments: [] }) }, () => cli(['pr', 'wait', String(number), '--timeout', '20s']));
        assert.match(r.stdout, /Fine now\./);
        await server.service.codex!.settle(id);
        // Nothing more is coming from Codex for this commit, so the next wait says to ask the reviewer.
        assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} \\(codex-review found nothing in ${sha()}\\); ask the user to review it: ${server.url}/acme/widgets/pull/${number}\n`));
        await waitEnded();
        // The clean review asks nothing of the author, so its turn does not come back.
        assert.deepEqual(await turn(), {
          whose: 'reviewer',
          reasons: ['agent is not waiting', "1 push since reviewer's review", 'agent answered 1 thread', `codex-review found nothing in ${sha()}`, 'changes requested'],
        });
      });

      await t.test("a failed review of the head: the reviewer's, with Retry", async () => {
        await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
          await human('POST', `${base}/reviewers/codex`);
          await server.service.codex!.settle(id);
        });
        const failed = (await human('GET', base)).turn.reasons.find((x: any) => x.kind === 'reviewer_agent');
        assert.deepEqual(failed, { kind: 'reviewer_agent', state: 'failed', to_review: false, text: `codex-review's review of ${sha()} failed`, engine: 'codex', reviewer: 'codex' });
        assert.match(await page('/'), new RegExp(`codex-review&#39;s review failed <button type="button" class="btn-link js-run-codex" data-api="${base}/reviewers/codex">Retry</button>`));
        // Also while the author waits: nothing more is coming from Codex for this commit. The author
        // was told so when Codex found nothing in it, and is not told again.
        const waited = cli(['pr', 'wait', String(number), '--timeout', '2s']);
        await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
        const { whose, reasons } = await turn();
        assert.equal(whose, 'reviewer');
        assert.equal(reasons[0], 'agent is waiting for review');
        assert.equal((await waited).code, 124);
      });

      await t.test("an approval asks nothing of the author: the reviewer's", async () => {
        await human('POST', `${base}/reviews`, { event: 'APPROVE' });
        await cli(['pr', 'view', String(number), '--comments']);
        const { whose, reasons } = await turn();
        assert.equal(whose, 'reviewer');
        assert.ok(reasons.includes('approved'));
        assert.match(rowOf(await page('/'))!, /<span class="Label Label--success">.*?Approved<\/span>/);
      });

      await t.test("published: nobody's, until a commit is not pushed: the author's, whose wait pushes it", async () => {
        // Codex's review of this commit failed before it was published: that holds nothing up now.
        await human('POST', `${base}/publish`, {});
        assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
        assert.equal(await group(), 'published: Waiting on GitHub');
        // A review asked for after publishing that fails is the reviewer's to retry, and a retry that finds nothing ends it.
        await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
          await human('POST', `${base}/reviewers/codex`);
          await server.service.codex!.settle(id);
        });
        const failed = await turn();
        assert.equal(failed.whose, 'reviewer');
        assert.ok(failed.reasons.includes(`codex-review's review of ${sha()} failed`));
        assert.equal(await group(), 'published: Your turn');
        assert.match(await page('/?state=published'), new RegExp(`data-api="${base}/reviewers/codex">Retry</button>`));
        await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine now.', comments: [] }) }, async () => {
          await human('POST', `${base}/reviewers/codex`);
          await server.service.codex!.settle(id);
        });
        assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
        // Feedback after publishing that the author, not waiting, has not been handed is the reviewer's to pass on.
        await waitEnded();
        await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'One more thing.' });
        const told = await turn();
        assert.equal(told.whose, 'reviewer');
        assert.deepEqual(told.reasons.slice(0, 2), ['agent has not seen the latest feedback', 'agent is not waiting']);
        assert.equal(await group(), 'published: Your turn');
        // Handed over, it is the author's; answered, nobody's again.
        await cli(['pr', 'view', String(number), '--comments']);
        assert.equal((await turn()).whose, 'author');
        assert.equal((await cli(['pr', 'comment', String(number), '-b', 'Noted.'])).code, 0);
        assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
        writeFileSync(join(repo, 'turns.js'), 'export const rounds = 2;\n');
        git('commit', '-qam', 'Count two rounds');
        assert.equal((await cli(['pr', 'edit', String(number), '--title', 'Take turns, in rounds'])).code, 0);
        await waitEnded();
        // A commit GitHub does not have is the author's: its wait pushes it.
        assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not waited since its last commit', 'approved', 'update not published: commits, title'] });
        // gh's state stays as gh would show it; the update is an extension field.
        const view = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'state,unpublishedChanges'])).stdout);
        assert.deepEqual(view, { state: 'PUBLISHED', unpublishedChanges: ['COMMITS', 'TITLE'] });
        const plain = (await cli(['pr', 'view', String(number)])).stdout;
        assert.match(plain, /^unpublished:\tcommits, title$/m);
        assert.match(plain, /^turn:\tauthor\tagent has not waited since its last commit, 1 min; approved; update not published: commits, title$/m);
        // Staged, in the badge and the merge box, until GitHub has the update.
        const pullPage = await page(`/acme/widgets/pull/${number}`);
        assert.match(pullPage, /<span class="State State--staged">.*?Update not published<\/span>/);
        assert.match(pullPage, /<div class="merge-box">/);
        assert.match(pullPage, /Staged changes not on GitHub yet: commits, title\.[^]*? The commits are also pushed when agent waits\./);
        assert.match(rowOf(await page('/acme/widgets?state=published'))!, /<span class="turn-reason" title="agent has not waited since its last commit">agent not waiting<span class="turn-since">[^]*?<span class="turn-reason">update not published: commits, title<\/span>/);
        assert.equal(await group(), 'published: With agents');
        assert.ok(!yourTurn(await page('/')).some((x) => x.id === id), 'not your turn');
      });

      await t.test("an update: the author's wait pushes its commit, which Codex does not review; the title is the reviewer's to publish", async () => {
        // An automatic review to spare, which a published pull request does not get.
        await human('PATCH', `${base}/reviewers/codex`, { max_iterations: 3 });
        const runs = (await human('GET', `${base}/reviewers/codex`)).runs.length;
        const r = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`^Pushed ${sha()} to GitHub: https://github\\.com/acme/widgets/pull/7$`, 'm'));
        assert.equal((await human('GET', `${base}/reviewers/codex`)).runs.length, runs);
        await waitEnded();
        assert.deepEqual(await turn(), { whose: 'reviewer', reasons: ['agent is not waiting', "1 push since reviewer's review", 'approved', 'update not published: title'] });
        assert.equal(await group(), 'published: Your turn');
      });

      await t.test("an edit to its own comment is the author's next action", async () => {
        assert.equal((await cli(['pr', 'comment', String(number), '-b', 'Working on it.'])).code, 0);
        await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Say what changed in the description.' });
        await cli(['pr', 'view', String(number), '--comments']);
        assert.equal((await turn()).whose, 'author');
        assert.equal((await cli(['pr', 'comment', String(number), '--edit-last', '-b', 'Done: the description says what changed.'])).code, 0);
        assert.equal((await turn()).whose, 'reviewer');
      });

      await t.test("waiting again at once ends the author's turn, and pages hear of it once", async () => {
        const ctx = await server.service.ctx('acme', 'widgets', number);
        const author = server.service.db.actorById(ctx.pull.author_id);
        await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'And the README.' });
        // Handed the comment and confirming it, as `pr wait` does: the author's turn.
        const handed = await server.service.wait(ctx, author, 5_000);
        server.service.markSeen(ctx.pull, handed.seenAt!);
        assert.equal((await turn()).whose, 'author');
        const events: string[] = [];
        const listen = (e: { pullId: number | null; type: string }) => e.pullId === id && events.push(e.type);
        server.service.bus.on('change', listen);
        const first = new AbortController();
        const renewal = new AbortController();
        try {
          // A wait started within seconds of the last one announces nothing itself (setWaiting) ...
          const again = server.service.wait(ctx, author, 20_000, first.signal);
          await until(async () => (await turn()).whose === 'reviewer', "the reviewer's turn");
          // ... so the wait says that it ended the author's turn.
          assert.deepEqual(events, ['waiting']);
          // A renewal that changes nothing says nothing.
          first.abort();
          await again;
          const renewed = server.service.wait(ctx, author, 20_000, renewal.signal);
          await new Promise((r) => setTimeout(r, 200));
          renewal.abort();
          await renewed;
          assert.deepEqual(events, ['waiting']);
        } finally {
          first.abort();
          renewal.abort();
          server.service.bus.off('change', listen);
        }
      });

      await t.test('notifications follow your turn whatever the list shows, and Retry finds its pull request', async () => {
        // A second repository, named so that a pull request's path in it has "pull" twice.
        const other = join(dir, 'pull');
        execFileSync('git', ['init', '-q', '-b', 'main', other]);
        const g = (...args: string[]) => execFileSync('git', ['-C', other, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args]);
        g('remote', 'add', 'origin', 'https://github.com/acme/pull.git');
        writeFileSync(join(other, 'a.js'), 'export const a = 1;\n');
        g('add', '.');
        g('commit', '-qm', 'Initial commit');
        g('update-ref', 'refs/remotes/origin/main', 'main');
        g('checkout', '-qb', 'feature');
        writeFileSync(join(other, 'a.js'), 'export const a = 2;\n');
        g('commit', '-qam', 'Change a');
        await human('POST', '/api/repos', { path: other });
        const res = await fetch(`${server.url}/api/repos/acme/pull/pulls`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
          body: JSON.stringify({ title: 'Change a', head: 'feature', base: 'main' }),
        });
        assert.equal(res.status, 201);
        const { id: otherId, number: otherNumber } = await res.json();
        await withFakes({ FAKE_CODEX_FAIL: '1' }, async () => {
          await human('POST', `/api/repos/acme/pull/pulls/${otherNumber}/reviewers/codex`);
          await server.service.codex!.settle(otherId);
        });
        assert.match(await page('/acme/pull'), new RegExp(`data-api="/api/repos/acme/pull/pulls/${otherNumber}/reviewers/codex">Retry</button>`));
        // Every list page carries your turn in every repository, whatever its tab or repository shows.
        for (const path of ['/', '/?state=done', '/?state=published', '/acme/pull', '/acme/pull?state=done']) {
          const ids = yourTurn(await page(path)).map((x) => x.id);
          assert.ok(ids.includes(id) && ids.includes(otherId), path);
        }
        await human('PATCH', `/api/repos/acme/pull/pulls/${otherNumber}`, { state: 'closed' });
      });

      await t.test("feedback handed over after a push the author made meanwhile: the author's", async () => {
        await waitEnded();
        await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Mention it in the changelog.' });
        assert.equal((await turn()).whose, 'reviewer');
        // The author pushes what it was working on, then its wait hands it the comment.
        writeFileSync(join(repo, 'turns.js'), 'export const rounds = 3;\n');
        git('commit', '-qam', 'Count three rounds');
        const r = await cli(['pr', 'wait', String(number), '--timeout', '5s']);
        assert.match(r.stdout, /Mention it in the changelog\./);
        const { whose, reasons } = await turn();
        assert.equal(whose, 'author');
        assert.equal(reasons[0], 'agent is working on the feedback');
      });

      await t.test("an approval the next wait returns, while the author works on feedback: the reviewer's", async () => {
        // The author works on the comment it was handed above, and an approval arrives meanwhile.
        await human('POST', `${base}/reviews`, { event: 'APPROVE', body: 'Fine as it is.' });
        assert.equal((await turn()).whose, 'author');
        // Its next wait returns only the approval, which asks nothing: waiting is its latest action.
        const r = await cli(['pr', 'wait', String(number), '--timeout', '5s']);
        assert.match(r.stdout, /Fine as it is\./);
        const { whose, reasons } = await turn();
        assert.equal(whose, 'reviewer');
        assert.ok(!reasons.includes('agent is working on the feedback'), reasons.join('; '));
        assert.ok(reasons.includes('approved'), reasons.join('; '));
      });

      await t.test("closed: nobody's", async () => {
        await human('PATCH', base, { state: 'closed' });
        assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
      });
    } finally {
      rmSync(gate, { force: true });
      await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
    }
  });
});

test("while the reviewer agents still have the head to review, it is theirs or the author's, until the author stalls", async (t) => {
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'feature/agents-first');
  writeFileSync(join(repo, 'agents-first.js'), 'export const first = 1;\n');
  git('add', 'agents-first.js');
  git('commit', '-qm', 'Add agents-first.js');
  // Both reviewer agents, for this pull request only.
  const created = await cli(['pr', 'create', '--title', 'Agents first', '--body', 'x', '--reviewer', 'codex:3', '--reviewer', 'claude:3']);
  assert.equal(created.code, 0, created.stderr);
  const number = Number(created.stdout.trim().split('/').pop());
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const { id } = await human('GET', base);
  const sha = () => git('rev-parse', '--short=7', 'HEAD');
  const page = async (path: string) => (await fetch(server.url + path)).text();
  const turn = async (): Promise<{ whose: string; reasons: string[] }> => {
    const { turn } = await human('GET', base);
    return { whose: turn.whose, reasons: turn.reasons.map((r: any) => r.text) };
  };
  /** The tab and the group the front page shows this pull request in. */
  const group = async () => {
    for (const tab of ['staged', 'published']) {
      const groups = (await page(`/?state=${tab}`)).split('<div class="Box-row turn-group">').slice(1);
      const title = groups.find((g) => g.includes(`href="/acme/widgets/pull/${number}"`))?.match(/<h2 class="turn-group-title">([^<]+)<\/h2>/)?.[1];
      if (title) return `${tab}: ${title}`;
    }
  };
  /** Whether the front page notifies about this pull request as your turn (data-your-turn). */
  const yours = async () => (await page('/')).match(/data-your-turn="([^"]*)"/)![1].includes(`/acme/widgets/pull/${number}&quot;`);
  const row = () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id);
  const waitEnded = () => until(() => !server.service.waiters.has(id) && !server.service['waitingStopped'].has(id), 'the wait is over');
  const toStart = (login: string) => `${login} reviews ${sha()} when agent waits for review`;
  const codexGate = join(dir, 'agents-first-codex');
  const claudeGate = join(dir, 'agents-first-claude');
  try {
    await t.test("staged, not waiting: the author's, to start the reviewer agents", async () => {
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', toStart('codex-review'), toStart('claude-review')] });
      assert.equal(await group(), 'staged: With agents');
      assert.equal(await yours(), false);
      const { turn: view } = JSON.parse((await cli(['pr', 'view', String(number), '--json', 'turn'])).stdout);
      assert.deepEqual(view, { whose: 'AUTHOR', reasons: ['agent has not asked for review yet (pr wait), 1 min', toStart('codex-review'), toStart('claude-review')] });
    });

    await t.test("feedback it is not waiting for: the reviewer's to pass on, then the author's", async () => {
      await human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body: 'Say what comes first.' });
      assert.deepEqual(await turn(), {
        whose: 'reviewer',
        reasons: ['agent has not seen the latest feedback', 'agent has not asked for review yet (pr wait)', 'no review from reviewer yet', toStart('codex-review'), toStart('claude-review')],
      });
      await cli(['pr', 'view', String(number), '--comments']);
      assert.equal((await turn()).whose, 'author');
      // Its answer ends its turn on the feedback, and the reviewer agents still wait for it.
      assert.equal((await cli(['pr', 'comment', String(number), '-b', 'The reviewer agents do.'])).code, 0);
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', toStart('codex-review'), toStart('claude-review')] });
    });

    await t.test("stalled: the reviewer's, and pages hear of it when the time is up", async () => {
      const events: string[] = [];
      const listen = (e: { pullId: number | null; type: string }) => e.pullId === id && events.push(e.type);
      server.service.bus.on('change', listen);
      try {
        // As if the author's last action were longer ago than that: the server's poll notices, once.
        server.service.stallMs = 0;
        await until(() => events.includes('stalled'), 'pages hear that the author stalled');
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(events.filter((e) => e === 'stalled'), ['stalled']);
        assert.deepEqual(await turn(), {
          whose: 'reviewer',
          reasons: ['agent stopped without asking for review', 'no review from reviewer yet', toStart('codex-review'), toStart('claude-review')],
        });
        assert.equal(await group(), 'staged: Your turn');
        assert.equal(await yours(), true);
        assert.match(await page('/'), /<span class="turn-reason" title="agent stopped without asking for review">agent stalled<span class="turn-since">/);
        // Waiting starts the reviewer agents: theirs.
        await withFakes({
          FAKE_CODEX_GATE: codexGate,
          FAKE_CLAUDE_GATE: claudeGate,
          FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }),
          FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine too.', comments: [] }),
        }, async () => {
          const waited = cli(['pr', 'wait', String(number), '--timeout', '20s']);
          await until(() => server.service.claude!.atWork(row())?.status === 'IN_PROGRESS' && server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'both review');
          assert.deepEqual((await turn()).whose, 'reviewer_agents');
          // Done with the head: the reviewer's, as the next wait says, and no longer stalled though the author does not wait.
          writeFileSync(codexGate, '');
          writeFileSync(claudeGate, '');
          assert.equal((await waited).code, 0);
          await server.service.codex!.settle(id);
          await server.service.claude!.settle(id);
          await waitEnded();
          assert.deepEqual(await turn(), {
            whose: 'reviewer',
            reasons: ['agent is not waiting', 'no review from reviewer yet', `codex-review found nothing in ${sha()}`, `claude-review found nothing in ${sha()}`],
          });
          assert.match(await handedOver(number), new RegExp(`^The reviewer agents are done with ${sha()} `));
        });
      } finally {
        server.service.stallMs = AUTHOR_STALL_MS;
        server.service.bus.off('change', listen);
        rmSync(codexGate, { force: true });
        rmSync(claudeGate, { force: true });
      }
    });

    await t.test("one reviewer agent done with a new commit and the other still to start: the author's", async () => {
      await waitEnded();
      writeFileSync(join(repo, 'agents-first.js'), 'export const first = 2;\n');
      git('commit', '-qam', 'Count from two');
      await until(() => row().head_sha === git('rev-parse', 'HEAD'), 'the push is seen');
      server.service.db.insert('review_runs', { pull_id: id, reviewer: 'codex', head_sha: row().head_sha, trigger: 'auto', status: 'done', findings: 0, started_at: now(), finished_at: now() });
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not asked for review yet (pr wait)', `codex-review found nothing in ${sha()}`, toStart('claude-review')] });
    });

    await t.test("stopped iterations count as done: the reviewer's, until Resume", async () => {
      await human('PUT', `${base}/stop-iterating`);
      const stopped = await turn();
      assert.equal(stopped.whose, 'reviewer');
      assert.deepEqual(stopped.reasons.slice(0, 1), ['agent is not waiting']);
      assert.ok(stopped.reasons.some((x) => /^reviewer stopped automatic reviews after round \d+$/.test(x)), stopped.reasons.join('; '));
      await human('DELETE', `${base}/stop-iterating`);
      assert.equal((await turn()).whose, 'author');
    });

    await t.test("a review asked for by hand: the reviewer agents'; cancelled by publishing: nobody's; an update: the author's to wait with", async () => {
      await withFakes({ FAKE_CODEX_GATE: codexGate }, async () => {
        await human('POST', `${base}/reviewers/codex`);
        await until(() => server.service.codex!.atWork(row())?.status === 'IN_PROGRESS', 'Codex reviews');
        const asked = await turn();
        assert.equal(asked.whose, 'reviewer_agents');
        assert.deepEqual(asked.reasons.slice(0, 2), [`codex-review is reviewing ${sha()}`, toStart('claude-review')]);
        await human('POST', `${base}/publish`, { sign: false, during_review: true });
        await server.service.codex!.settle(id);
      });
      // Claude never reviewed the head, but GitHub has it now: the next move is there.
      assert.equal((await human('GET', `${base}/reviewers/codex`)).runs.at(-1).status, 'cancelled');
      assert.deepEqual(await turn(), { whose: 'none', reasons: [] });
      assert.equal(await group(), 'published: Waiting on GitHub');
      writeFileSync(join(repo, 'agents-first.js'), 'export const first = 3;\n');
      git('commit', '-qam', 'Count from three');
      await until(() => row().head_sha === git('rev-parse', 'HEAD'), 'the push is seen');
      // No reviewer agent reviews it on its own once it is published: the author's wait pushes it.
      assert.deepEqual(await turn(), { whose: 'author', reasons: ['agent has not waited since its last commit', 'update not published: commits'] });
      assert.equal(await group(), 'published: With agents');
    });

    await t.test("no reviewer agent reviews it: staging hands it to the reviewer", async () => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', 'feature/no-agents');
      writeFileSync(join(repo, 'no-agents.js'), 'export const none = 1;\n');
      git('add', 'no-agents.js');
      git('commit', '-qm', 'Add no-agents.js');
      await human('PUT', '/api/settings/codex', { enabled: true });
      const r = await cli(['pr', 'create', '--title', 'No agents', '--body', 'x', '--no-review']);
      assert.equal(r.code, 0, r.stderr);
      const { turn } = await human('GET', `/api/repos/acme/widgets/pulls/${r.stdout.trim().split('/').pop()}`);
      assert.deepEqual({ whose: turn.whose, reasons: turn.reasons.map((x: any) => x.text) }, { whose: 'reviewer', reasons: ['agent is not waiting', 'no review from reviewer yet'] });
    });
  } finally {
    rmSync(codexGate, { force: true });
    rmSync(claudeGate, { force: true });
    await human('PUT', '/api/settings/codex', { enabled: false });
  }
});

test('published pull requests are followed until they are merged or closed on GitHub', async (t) => {
  /** Stage a branch with one commit as the agent, publish it as the reviewer, and let the agent hear of the publish. */
  const published = async (branch: string, file: string) => {
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export {};\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x', '--no-review']);
    assert.equal(created.code, 0, created.stderr);
    const number = Number(created.stdout.trim().split('/').pop());
    const base = `/api/repos/acme/widgets/pulls/${number}`;
    const { id } = await human('POST', `${base}/publish`, { sign: false });
    // The first wait after a publish reports it; the next one waits for GitHub.
    const heard = await cli(['pr', 'wait', String(number), '--timeout', '20s']);
    assert.match(heard.stdout, /^Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
    assert.match(heard.stdout, new RegExp(`Run \`galley pr wait s${number}\` again to hear when it is merged or closed on GitHub`));
    return {
      number,
      id,
      base,
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${number}`)).text(),
      timeline: (): Promise<any[]> => human('GET', `/api/repos/acme/widgets/issues/${number}/timeline`),
      /** How many times galley has asked GitHub about it. */
      asked: () => readFileSync(join(dir, 'gh.log'), 'utf8').split(`p${id}:pullRequest(number:7)`).length - 1,
    };
  };
  /** What GitHub says about these pull requests (by staged pull id), and galley asking it, as it does every minute. */
  const githubSays = async (nodes: Record<number, object>) => {
    const repository = Object.fromEntries(Object.entries(nodes).map(([id, node]) => [`p${id}`, node]));
    writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository } }));
    await server.service.followGithub();
  };
  const untilWaiting = async (...bases: string[]) => {
    for (const base of bases) await until(async () => (await human('GET', base)).author_waiting, 'the author waits');
  };
  const comment = (number: number, body: string) => human('POST', `/api/repos/acme/widgets/issues/${number}/comments`, { body });
  const mergeCommit = 'e468a4e' + '1'.repeat(33);
  const open = { state: 'OPEN', mergedAt: null, closedAt: null, mergedBy: null, mergeCommit: null, timelineItems: { nodes: [] } };
  const merged = { state: 'MERGED', mergedAt: '2026-10-16T09:00:00Z', closedAt: '2026-10-16T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: { oid: mergeCommit }, timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'laat' } }] } };
  const closed = { state: 'CLOSED', mergedAt: null, closedAt: '2026-10-16T10:00:00Z', mergedBy: null, mergeCommit: null, timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'octocat' } }] } };

  try {
    await t.test('pr wait after a publish waits for the merge, and says who merged it as what', async () => {
      const pr = await published('feature/follow-merge', 'merge.js');
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await untilWaiting(pr.base);
      // Still open on GitHub: nothing to tell.
      await githubSays({ [pr.id]: open });
      assert.equal((await human('GET', pr.base)).github_state, 'open');
      const returned = await Promise.race([waiting.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);
      assert.equal(returned, false, 'a pull request still open on GitHub does not end the wait');
      await githubSays({ [pr.id]: merged });
      const r = await waiting;
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^Merged on GitHub as e468a4e by laat: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
      assert.match(r.stdout, /Next: fast-forward your main to the merge, remove the worktree and the branch feature\/follow-merge/);
      // Every later wait says so at once.
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '5s'])).stdout, /^Merged on GitHub as e468a4e by laat/m);

      const rest = await human('GET', pr.base);
      assert.deepEqual(
        [rest.github_state, rest.merged, rest.merged_at, rest.merged_by.login, rest.merge_commit_sha, rest.github_closed_by],
        ['merged', true, '2026-10-16T09:00:00Z', 'laat', mergeCommit, 'laat'],
      );
      const view = await cli(['pr', 'view', String(pr.number), '--json', 'state,closed,mergedAt,mergedBy,mergeCommit,turn']);
      assert.deepEqual(JSON.parse(view.stdout), {
        state: 'MERGED',
        closed: true,
        mergedAt: '2026-10-16T09:00:00Z',
        mergedBy: { login: 'laat', is_bot: false },
        mergeCommit: { oid: mergeCommit },
        // A merged pull request is nobody's turn.
        turn: { whose: 'NONE', reasons: [] },
      });
      assert.match((await cli(['pr', 'view', String(pr.number)])).stdout, /^state:\tMERGED$[^]*^merged:\tas e468a4e by laat at 2026-10-16T09:00:00Z$/m);
      assert.match((await cli(['pr', 'list', '--state', 'merged'])).stdout, new RegExp(`^s#${pr.number}\\tAdd merge\\.js\\tfeature/follow-merge\\tMERGED\\t`, 'm'));
      const event = (await pr.timeline()).find((e) => e.event === 'merged');
      assert.deepEqual([event.by, event.commit, event.at, event.url], ['laat', mergeCommit, '2026-10-16T09:00:00Z', 'https://github.com/acme/widgets/pull/7']);

      const page = await pr.page();
      assert.match(page, /<span class="State State--merged" title="Merged on GitHub"><svg class="octicon octicon-git-merge"[^>]*>.*?<\/svg> Merged<\/span>/);
      assert.match(
        page,
        new RegExp(
          `<a class="author" href="https://github\\.com/laat" target="_blank" rel="noopener">laat</a> merged commit <a class="commit-link" href="https://github\\.com/acme/widgets/commit/${mergeCommit}" target="_blank" rel="noopener"><code>e468a4e</code></a> into <span class="branch-name branch-name-sm">main</span> on GitHub`,
        ),
      );
      assert.match(page, /<strong>Merged on GitHub<\/strong>/);
      assert.doesNotMatch(page, /js-publish-form/);
      const list = await (await fetch(`${server.url}/acme/widgets?state=all`)).text();
      assert.match(list, new RegExp(`octicon-git-merge color-fg-done[^]*?href="/acme/widgets/pull/${pr.number}">Add merge\\.js</a>\\s*<span class="Label Label--merged">Merged</span>`));
      // Nothing is published over a merge.
      const res = await fetch(`${server.url}${pr.base}/publish`, { method: 'POST' });
      assert.equal(res.status, 422);
      assert.match((await res.json()).message, /merged on GitHub/);

      // Merged is final: galley stops asking GitHub about it.
      const asked = pr.asked();
      await githubSays({ [pr.id]: merged });
      assert.equal(pr.asked(), asked);
      assert.ok(!server.service.followed().some((p) => p.id === pr.id));

      // Its branch can be staged again, and the merged pull request keeps the commits it was merged with.
      const mergedHead = (await human('GET', pr.base)).head.sha;
      git('checkout', '-q', 'feature/follow-merge');
      writeFileSync(join(repo, 'merge.js'), 'export const more = 1;\n');
      git('commit', '-qam', 'More work on the branch');
      const again = await cli(['pr', 'create', '--title', 'More on the merged branch', '--body', 'x', '--no-review']);
      assert.equal(again.code, 0, again.stderr);
      await new Promise((r) => setTimeout(r, 300)); // the server polls branches every 50 ms here
      assert.equal((await human('GET', pr.base)).head.sha, mergedHead);
      assert.equal((await human('GET', `${pr.base}/commits`)).length, 1);
      assert.equal(JSON.parse((await cli(['pr', 'view', '--json', 'number'])).stdout).number, Number(again.stdout.trim().split('/').pop()));
    });

    await t.test('commits GitHub did not merge: pr wait lists them and says to keep the branch', async () => {
      const pr = await published('feature/follow-left-out', 'left-out.js');
      const branch = 'feature/follow-left-out';
      // The base moves, and the author rebases onto it: the base's commit is not left out, the copy of the published one is.
      git('checkout', '-q', 'main');
      writeFileSync(join(repo, 'base-moved.js'), 'export {};\n');
      git('add', 'base-moved.js');
      git('commit', '-qm', 'Move the base');
      git('push', '-q', 'origin', 'main');
      git('checkout', '-q', branch);
      git('rebase', '-q', 'main');
      const copy = git('rev-parse', 'HEAD');
      const moved = git('rev-parse', 'main');
      // Synced before galley hears of the merge, and never pushed: the author did not wait with it.
      writeFileSync(join(repo, 'left-out.js'), 'export const synced = 1;\n');
      git('commit', '-qam', 'Synced before the merge');
      const synced = git('rev-parse', 'HEAD');
      await until(async () => (await human('GET', pr.base)).head.sha === synced, 'the server has the synced commit');
      assert.deepEqual((await human('GET', pr.base)).unpublished_changes, ['commits']);
      await githubSays({ [pr.id]: merged });
      // Made after it, when galley no longer follows the branch.
      writeFileSync(join(repo, 'left-out.js'), 'export const after = 1;\n');
      git('commit', '-qam', 'Made after the merge');
      const after = git('rev-parse', 'HEAD');
      const wait = async () => {
        const r = await cli(['pr', 'wait', String(pr.number), '--timeout', '5s']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /^Merged on GitHub as e468a4e by laat: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
        assert.doesNotMatch(r.stdout, /remove the worktree/);
        return r.stdout;
      };
      const short = (sha: string) => sha.slice(0, 7);
      assert.match(
        await wait(),
        new RegExp(
          `^GitHub merged it without these 3 commits of ${branch}, which it never got:\n  ${short(copy)} Add left-out\\.js\n  ${short(synced)} Synced before the merge\n  ${short(after)} Made after the merge\n` +
            `Next: keep the branch ${branch} and tell the user\\. Fast-forward your main to the merge, move them onto it with \`git rebase --onto main ${short(moved)} ${branch}\`, `,
          'm',
        ),
      );

      // With a merge among them, no rebase carries them over as they are.
      git('checkout', '-qb', 'feature/follow-left-out-side', copy);
      writeFileSync(join(repo, 'side.js'), 'export {};\n');
      git('add', 'side.js');
      git('commit', '-qm', 'Side work');
      git('checkout', '-q', branch);
      git('merge', '-q', '--no-ff', '-m', 'Merge the side work', 'feature/follow-left-out-side');
      const withMerge = await wait();
      assert.match(withMerge, /^GitHub merged it without these 5 commits of feature\/follow-left-out, which it never got:$/m);
      assert.match(withMerge, new RegExp(`^Next: keep the branch ${branch}, tell the user, and ask how to stage them as a new pull request: a rebase would not carry them over as they are \\(a merge, say\\)\\.`, 'm'));
      assert.doesNotMatch(withMerge, /git rebase/);

      // Deleted here: what galley last saw, and how to bring the branch back.
      git('checkout', '-q', 'main');
      git('branch', '-qD', branch, 'feature/follow-left-out-side');
      const gone = await wait();
      assert.match(gone, new RegExp(`^GitHub merged it without these 2 commits of ${branch}, which it never got:\n  ${short(copy)} Add left-out\\.js\n  ${short(synced)} Synced before the merge\n`, 'm'));
      assert.match(gone, new RegExp(`^The branch ${branch} is gone here; bring it back with \`git branch ${branch} ${synced}\`\\. Next: keep the branch`, 'm'));
    });

    await t.test('a merge found while a publish signs stops the push', async () => {
      const pr = await published('feature/follow-race', 'race.js');
      writeFileSync(join(repo, 'race.js'), 'export const raced = 1;\n');
      git('commit', '-qam', 'Race the merge');
      const remoteHead = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/follow-race'], { encoding: 'utf8' }).trim();
      const before = remoteHead();
      // Signing waits, as for a passphrase, while following finds the merge.
      const signing = join(dir, 'race-signing');
      const gate = join(dir, 'race-gate');
      const program = join(dir, 'race-ssh-keygen');
      writeFileSync(program, `#!/bin/sh\ntouch "${signing}"\nwhile [ ! -f "${gate}" ]; do sleep 0.02; done\nexec ssh-keygen "$@"\n`);
      chmodSync(program, 0o755);
      git('config', 'gpg.ssh.program', program);
      try {
        const publishing = fetch(`${server.url}${pr.base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sign: true, force: true }) });
        await until(() => existsSync(signing), 'signing starts');
        await githubSays({ [pr.id]: merged });
        writeFileSync(gate, '');
        const res = await publishing;
        assert.equal(res.status, 422);
        assert.match((await res.json()).message, /merged on GitHub/);
        assert.equal(remoteHead(), before);
      } finally {
        git('config', '--unset', 'gpg.ssh.program');
        for (const f of [signing, gate, program]) rmSync(f, { force: true });
      }
    });

    await t.test('closed on GitHub without merging, and followed again when published again', async () => {
      const pr = await published('feature/follow-close', 'close.js');
      const waiting = cli(['pr', 'wait', String(pr.number), '--timeout', '20s']);
      await untilWaiting(pr.base);
      await githubSays({ [pr.id]: closed });
      const r = await waiting;
      assert.match(r.stdout, /^Closed on GitHub without merging by octocat: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m);
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '5s'])).stdout, /^Closed on GitHub without merging/m);
      const view = await cli(['pr', 'view', String(pr.number), '--json', 'state,closed,closedAt,mergedAt,turn']);
      assert.deepEqual(JSON.parse(view.stdout), { state: 'CLOSED', closed: true, closedAt: '2026-10-16T10:00:00Z', mergedAt: null, turn: { whose: 'NONE', reasons: [] } });
      const page = await pr.page();
      assert.match(page, /<span class="State State--closed" title="Closed on GitHub">/);
      assert.match(page, /<a class="author" href="https:\/\/github\.com\/octocat" target="_blank" rel="noopener">octocat<\/a> closed this pull request on GitHub/);
      assert.match(page, /<strong>Closed on GitHub<\/strong>/);

      // Published again (it was reopened on GitHub, say): followed again, and a close GitHub still reports is no news.
      writeFileSync(join(repo, 'close.js'), 'export const again = 1;\n');
      git('commit', '-qam', 'Again');
      await human('POST', `${pr.base}/publish`, { sign: false });
      assert.equal((await human('GET', pr.base)).github_state, null);
      assert.match((await cli(['pr', 'wait', String(pr.number), '--timeout', '5s'])).stdout, /^Published to GitHub/m);
      const asked = pr.asked();
      await githubSays({ [pr.id]: closed });
      assert.equal(pr.asked(), asked + 1);
      assert.equal((await human('GET', pr.base)).github_state, 'closed');
      assert.equal((await pr.timeline()).filter((e) => e.event === 'closed_on_github').length, 1);

      // Reopened on GitHub and published again: open, with no close time, though galley keeps the close to know it if GitHub reports it again.
      writeFileSync(join(repo, 'close.js'), 'export const reopened = 1;\n');
      git('commit', '-qam', 'Reopened');
      await human('POST', `${pr.base}/publish`, { sign: false });
      await githubSays({ [pr.id]: open });
      const reopened = await human('GET', pr.base);
      assert.deepEqual([reopened.state, reopened.staging_state, reopened.github_state, reopened.closed_at], ['open', 'published', 'open', null]);
      assert.deepEqual(JSON.parse((await cli(['pr', 'view', String(pr.number), '--json', 'state,closed,closedAt'])).stdout), { state: 'PUBLISHED', closed: false, closedAt: null });
    });

    await t.test('how it stands on GitHub is shown to the reviewer, and makes it their turn; the agent waits on', async () => {
      const pr = await published('feature/follow-checks', 'checks.js');
      const n = String(pr.number);
      const head = 'c0ffee' + '0'.repeat(34);
      const run = (name: string, job: number, status: string, conclusion: string | null = null) => ({
        __typename: 'CheckRun',
        databaseId: job,
        name,
        status,
        conclusion,
        detailsUrl: `https://github.com/acme/widgets/actions/runs/1/job/${job}`,
        checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
      });
      const github = (checks: object[], more: object = {}) => ({
        ...open,
        headRefOid: head,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } }, checkSuites: { nodes: [] } } }] },
        ...more,
      });
      const turn = async () => JSON.parse((await cli(['pr', 'view', n, '--json', 'turn'])).stdout).turn;

      // The agent waits for the reviewer; nothing from GitHub below wakes it.
      const waiting = cli(['pr', 'wait', n, '--timeout', '20s']);
      await untilWaiting(pr.base);

      // Checks run, then pass: shown, and nobody's turn.
      await githubSays({ [pr.id]: github([run('test', 11, 'IN_PROGRESS'), run('lint', 12, 'COMPLETED', 'SUCCESS')]) });
      assert.match((await cli(['pr', 'view', n])).stdout, /^github:\tchecks: 1 pending, 1 passed$/m);
      await githubSays({ [pr.id]: github([run('test', 11, 'COMPLETED', 'SUCCESS'), run('lint', 12, 'COMPLETED', 'SUCCESS')]) });
      const view = JSON.parse((await cli(['pr', 'view', n, '--json', 'statusCheckRollup,mergeable,mergeStateStatus'])).stdout);
      assert.deepEqual(view.statusCheckRollup[0], { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/11' });
      assert.deepEqual([view.mergeable, view.mergeStateStatus], ['MERGEABLE', 'CLEAN']);
      assert.match(await pr.page(), /<strong>All checks have passed<\/strong>/);
      assert.match(await (await fetch(`${server.url}/acme/widgets?state=published`)).text(), /Add checks\.js<\/a> <span class="checks-indicator" title="All 2 checks passed on GitHub">/);
      assert.equal((await turn()).whose, 'NONE');

      /** The group the repository's Published tab shows it in, and its row there. */
      const listed = async () => {
        const groups = (await (await fetch(`${server.url}/acme/widgets?state=published`)).text()).split('<div class="Box-row turn-group">').slice(1);
        const group = groups.find((g) => g.includes(`href="/acme/widgets/pull/${n}"`))!;
        const row = group.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/widgets/pull/${n}"`))!;
        return { group: group.match(/<h2 class="turn-group-title">([^<]+)<\/h2>/)![1], row };
      };
      // GitHub would merge it now, and auto-merge is off: the reviewer's turn, to merge it there.
      const passed = [run('test', 11, 'COMPLETED', 'SUCCESS'), run('lint', 12, 'COMPLETED', 'SUCCESS')];
      await githubSays({ [pr.id]: github(passed, { autoMergeRequest: null }) });
      const ready = await turn();
      assert.equal(ready.whose, 'REVIEWER');
      assert.deepEqual(ready.reasons.filter((r: string) => /GitHub/.test(r)), ['ready to merge on GitHub']);
      const mine = await listed();
      assert.equal(mine.group, 'Your turn');
      assert.match(mine.row, /<span class="turn-reason"><svg [^>]*octicon-mark-github[^]*?<\/svg>ready to merge on GitHub<\/span>/);
      // Its title opens it on GitHub, where the reviewer merges it; its number opens it here.
      assert.match(mine.row, /<a class="pr-row-title" href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">Add checks\.js<\/a>/);
      assert.match(mine.row, new RegExp(`<a href="/acme/widgets/pull/${n}">s#${n}</a> staged`));
      // With auto-merge on, GitHub merges it by itself.
      await githubSays({ [pr.id]: github(passed, { autoMergeRequest: { enabledAt: '2026-10-17T12:00:00Z' } }) });
      assert.deepEqual(await turn(), { whose: 'NONE', reasons: [] });
      assert.equal((await listed()).group, 'Waiting on GitHub');
      // Blocked by a required review: it waits on GitHub, for those asked to review.
      const requested = { totalCount: 3, nodes: [{ requestedReviewer: { login: 'eskilgh' } }, { requestedReviewer: { login: 'cbjerkan' } }, { requestedReviewer: { combinedSlug: 'acme/platform' } }] };
      await githubSays({ [pr.id]: github(passed, { autoMergeRequest: null, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: requested }) });
      assert.deepEqual(await turn(), { whose: 'NONE', reasons: ['waiting for review from eskilgh, cbjerkan, acme/platform'] });
      const blocked = await listed();
      assert.equal(blocked.group, 'Waiting on GitHub');
      assert.match(blocked.row, /<\/svg> acme\/widgets#7<\/a><\/span><span class="turn-reason">waiting for review from eskilgh, cbjerkan, acme\/platform<\/span>/);
      assert.match(blocked.row, /<a class="pr-row-title" href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">Add checks\.js<\/a>/);
      assert.match(blocked.row, new RegExp(`<a class="pr-row-number" href="/acme/widgets/pull/${n}">s#${n}</a>`));
      // A token without the read:org scope: GitHub refuses the teams' names, so galley asks again without them, from then on.
      const follows = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l.includes('reviewRequests('));
      const before = follows().length;
      try {
        await withFakes({ FAKE_GH_NO_READ_ORG: '1' }, async () => {
          const unnamed = { totalCount: 2, nodes: [{ requestedReviewer: { login: 'eskilgh' } }, { requestedReviewer: {} }] };
          await githubSays({ [pr.id]: github(passed, { autoMergeRequest: null, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: unnamed }) });
          assert.deepEqual(await turn(), { whose: 'NONE', reasons: ['waiting for review from eskilgh and 1 more'] });
          await server.service.followGithub();
          const since = follows().slice(before);
          assert.equal(since.filter((q) => q.includes('combinedSlug')).length, 1, 'refused once');
          assert.match(since.at(-1)!, new RegExp(`p${pr.id}:pullRequest`));
          assert.doesNotMatch(since.at(-1)!, /combinedSlug/);
        });
      } finally {
        server.service.githubTeamNames = true;
      }

      // More checks than one page reads, and one past it failed: GitHub's sum says so.
      const many = github([]);
      many.commits.nodes[0].commit.statusCheckRollup = { state: 'FAILURE', contexts: { totalCount: 130, nodes: [run('test', 11, 'COMPLETED', 'SUCCESS'), run('lint', 12, 'COMPLETED', 'SUCCESS')] } } as any;
      await githubSays({ [pr.id]: many });
      assert.match(await pr.page(), /<strong>Some checks were not successful<\/strong><div class="color-fg-muted">2 successful of the first 2 of 130 checks\./);
      assert.match(await (await fetch(`${server.url}/acme/widgets?state=published`)).text(), /<span class="checks-indicator" title="Checks failed on GitHub">/);
      assert.deepEqual((await turn()).reasons.filter((r: string) => /GitHub/.test(r)), ['checks failed on GitHub']);
      assert.match((await cli(['pr', 'view', n])).stdout, /^github:\tchecks: failed \(first 2 of 130: 2 passed\)$/m);

      // A failed check, changes requested with a thread (on an earlier page than the first query
      // reads), and a conflict: shown, and the reviewer's turn, saying why.
      const thread = {
        id: 'PRRT_1',
        isResolved: false,
        isOutdated: false,
        path: 'checks.js',
        line: 1,
        originalLine: 1,
        startLine: null,
        diffSide: 'RIGHT',
        comments: { nodes: [{ databaseId: 501, author: { login: 'octocat' }, body: 'Export a function.', createdAt: '2026-10-16T12:00:00Z', url: 'https://github.com/acme/widgets/pull/7#discussion_r501', diffHunk: '@@ -0,0 +1 @@\n+export {};' }] },
      };
      writeFileSync(join(dir, 'gh-pulls-earlier.json'), JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [thread] } } } } }));
      try {
        await githubSays({
          [pr.id]: github([run('test', 21, 'COMPLETED', 'FAILURE'), run('lint', 12, 'COMPLETED', 'SUCCESS')], {
            reviewDecision: 'CHANGES_REQUESTED',
            reviewThreads: { pageInfo: { hasPreviousPage: true, startCursor: 'T50' }, nodes: [] },
            mergeable: 'CONFLICTING',
            mergeStateStatus: 'DIRTY',
          }),
        });
      } finally {
        rmSync(join(dir, 'gh-pulls-earlier.json'), { force: true });
      }
      assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /reviewThreads\(last:100,before:\$cursor\).* -f cursor=T50$/m);
      const page = await pr.page();
      assert.match(page, /<strong>Some checks were not successful<\/strong>/);
      assert.match(page, /<strong>Changes requested on GitHub<\/strong>/);
      assert.match(page, /<strong>1 unresolved conversation on GitHub<\/strong>/);
      assert.match(page, /This branch has conflicts with <span class="branch-name branch-name-sm">main<\/span> on GitHub/);
      const yours = await turn();
      assert.equal(yours.whose, 'REVIEWER');
      assert.match(yours.reasons.join(' · '), /1 check failed on GitHub · changes requested on GitHub · 1 unresolved thread on GitHub · conflicts with main on GitHub/);
      assert.match(await (await fetch(`${server.url}/acme/widgets?state=published`)).text(), /<span class="turn-reason"><svg [^>]*octicon-mark-github[^]*?<\/svg>1 check failed on GitHub<\/span>/);
      assert.doesNotMatch((await cli(['pr', 'view', n, '--comments'])).stdout, /Export a function/);
      // The earlier page cannot be read this time (gh-pulls-earlier.json is gone): its thread stays.
      await githubSays({
        [pr.id]: github([run('test', 21, 'COMPLETED', 'FAILURE'), run('lint', 12, 'COMPLETED', 'SUCCESS')], {
          reviewDecision: 'CHANGES_REQUESTED',
          reviewThreads: { pageInfo: { hasPreviousPage: true, startCursor: 'T50' }, nodes: [] },
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY',
        }),
      });
      assert.match(await pr.page(), /<strong>1 unresolved conversation on GitHub<\/strong>/);
      assert.match((await turn()).reasons.join(' · '), /1 unresolved thread on GitHub/);

      // The agent hears only from the reviewer, who decides what to hand over.
      await comment(pr.number, 'The test fails on GitHub; please fix it.');
      const heard = (await waiting).stdout;
      assert.match(heard, /The test fails on GitHub; please fix it\./);
      assert.doesNotMatch(heard, /Export a function|Checks failed|Conflicts/);
    });

    await t.test("after auto-publish's first publish, the agent's wait pushes the fix for a failed check, unreviewed, and asks for auto-merge again; nothing after a merge", async () => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', 'feature/follow-auto');
      writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = true;\n');
      git('add', 'auto-fix.js');
      git('commit', '-qm', 'Add auto-fix.js');
      const created = await cli(['pr', 'create', '--title', 'Add auto-fix.js', '--body', 'x']);
      assert.equal(created.code, 0, created.stderr);
      const n = created.stdout.trim().split('/').pop()!;
      const base = `/api/repos/acme/widgets/pulls/${n}`;
      const remoteHead = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/follow-auto'], { encoding: 'utf8' }).trim();
      const updates = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l.startsWith('pr edit https://github.com/acme/widgets/pull/7 ')).length;
      const wait = async (expect: RegExp) => {
        const r = await cli(['pr', 'wait', n, '--timeout', '20s']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, expect);
        return r.stdout;
      };
      await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
      try {
        // With auto-merge, which is asked for again after each push.
        await human('PUT', `${base}/auto-publish`, { sign: false, auto_merge: true, merge_method: 'squash' });
        const merges = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l.startsWith('pr merge https://github.com/acme/widgets/pull/7 --auto --squash --match-head-commit ')).length;
        const mergesBefore = merges();
        // Codex finds nothing; once the agent has seen that and waits, the first publish, which uses auto-publish up.
        await withFakes({ FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'Looks right.', comments: [] }) }, () => wait(/Looks right\./));
        assert.match(await wait(/^Published to GitHub: https:\/\/github\.com\/acme\/widgets\/pull\/7$/m), /It is published: commit and wait/);
        const { id, auto_publish } = await human('GET', base);
        assert.equal(auto_publish, null);
        assert.equal(remoteHead(), git('rev-parse', 'HEAD'));
        const reviews = (await human('GET', `${base}/reviewers/codex`)).runs.length;

        // A check fails on GitHub: the reviewer's turn. The reviewer hands it to the agent, which commits a fix and waits.
        const check = { __typename: 'CheckRun', databaseId: 21, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/widgets/actions/runs/2/job/21', checkSuite: { workflowRun: { workflow: { name: 'CI' } } } };
        await githubSays({ [id]: { ...open, headRefOid: remoteHead(), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [check] } }, checkSuites: { nodes: [] } } }] } } });
        assert.equal(JSON.parse((await cli(['pr', 'view', n, '--json', 'turn'])).stdout).turn.whose, 'REVIEWER');
        await comment(Number(n), 'The test fails on GitHub; please fix it.');
        await wait(/The test fails on GitHub; please fix it\.[^]*It is published: commit and wait/);
        const before = updates();
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = false;\n');
        git('commit', '-qam', 'Fix auto-fix.js');

        // Its wait pushes the fix, unsigned as the publish was, with no review from Codex; the title and description are left alone.
        await wait(new RegExp(`^Pushed ${git('rev-parse', '--short=7', 'HEAD')} to GitHub: https://github\\.com/acme/widgets/pull/7$`, 'm'));
        assert.equal(remoteHead(), git('rev-parse', 'HEAD'));
        assert.equal((await human('GET', `${base}/reviewers/codex`)).runs.length, reviews);
        assert.equal(updates(), before);
        await until(() => merges() === mergesBefore + 2, 'auto-merge asked for after the first publish and after the push');
        // Asking for it again failed once: the push after that asks again all the same.
        writeFileSync(join(dir, 'gh-merge-fail'), 'GraphQL: Something went wrong while executing your query.');
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = false; // 1\n');
        git('commit', '-qam', 'Fix auto-fix.js again');
        await wait(/^Pushed [0-9a-f]{7} to GitHub/m);
        await until(async () => (await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)).some((e: any) => e.event === 'auto_merge_failed'), 'asking for auto-merge failed');
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = false; // 2\n');
        git('commit', '-qam', 'Fix auto-fix.js once more');
        await wait(/^Pushed [0-9a-f]{7} to GitHub/m);
        await until(() => merges() === mergesBefore + 4, 'auto-merge asked for again after the failure');
        // Turned off on GitHub since: the next push leaves it off.
        await githubSays({ [id]: { ...open, headRefOid: remoteHead(), autoMergeRequest: null } });
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = false; // 3\n');
        git('commit', '-qam', 'Fix auto-fix.js with auto-merge off');
        await wait(/^Pushed [0-9a-f]{7} to GitHub/m);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(merges(), mergesBefore + 4);
        const pushed = (await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)).findLast((e: any) => e.event === 'github_push');
        assert.deepEqual([pushed.result, pushed.source, pushed.head, pushed.force, pushed.sign], ['pushed', git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD'), false, false]);
        assert.match(await (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text(), new RegExp(`Pushed an update to <a [^>]*>acme/widgets#7</a> at <code>${git('rev-parse', '--short=7', 'HEAD')}</code> when agent waited`));
        assert.equal(updates(), before);

        // Merged on GitHub: the agent's next commit goes nowhere.
        await githubSays({ [id]: merged });
        writeFileSync(join(repo, 'auto-fix.js'), 'export const broken = 0;\n');
        git('commit', '-qam', 'After the merge');
        await wait(/^Merged on GitHub as e468a4e by laat/m);
        await new Promise((r) => setTimeout(r, 500));
        assert.notEqual(remoteHead(), git('rev-parse', 'HEAD'));
      } finally {
        await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
      }
    });

    await t.test('auto-merge that merges at once: the next commit is not pushed', async () => {
      git('checkout', '-q', 'main');
      git('checkout', '-qb', 'feature/follow-merged-at-once');
      writeFileSync(join(repo, 'at-once.js'), 'export const once = 1;\n');
      git('add', 'at-once.js');
      git('commit', '-qm', 'Add at-once.js');
      const created = await cli(['pr', 'create', '--title', 'Add at-once.js', '--body', 'x', '--no-review']);
      assert.equal(created.code, 0, created.stderr);
      const n = created.stdout.trim().split('/').pop()!;
      const base = `/api/repos/acme/widgets/pulls/${n}`;
      const remoteHead = () => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'feature/follow-merged-at-once'], { encoding: 'utf8' }).trim();
      // GitHub has nothing to wait for: gh merges as soon as auto-merge is asked for.
      await withFakes({ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-17T11:00:00Z', mergedBy: { login: 'reviewer' }, mergeCommit: { oid: mergeCommit } }) }, async () => {
        await human('PUT', `${base}/auto-publish`, { sign: false, auto_merge: true, merge_method: 'squash' });
        // The agent waits, auto-publish publishes, and gh merges: the agent hears of the merge (the
        // publish may reach it first, a moment before galley has asked GitHub about the merge).
        let heard = (await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout;
        if (/^Published to GitHub/m.test(heard)) heard = (await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout;
        assert.match(heard, /^Merged on GitHub as e468a4e by reviewer/m);
        const pull = await human('GET', base);
        assert.deepEqual([pull.github_state, pull.auto_publish], ['merged', null]);
        // Another commit, and the agent waits again: nothing is pushed over the merge.
        const pushed = remoteHead();
        writeFileSync(join(repo, 'at-once.js'), 'export const once = 2;\n');
        git('commit', '-qam', 'After the merge');
        assert.match((await cli(['pr', 'wait', n, '--timeout', '5s'])).stdout, /^Merged on GitHub/m);
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(remoteHead(), pushed);
      });
    });

    await t.test('pr wait on several pull requests returns the first with news, and says which', async () => {
      const a = await published('feature/multi-a', 'a.js');
      const b = await published('feature/multi-b', 'b.js');
      const both = [String(a.number), String(b.number)];
      const waiting = cli(['pr', 'wait', ...both, '--timeout', '20s']);
      await untilWaiting(a.base, b.base);
      await comment(b.number, 'One more thing on b.');
      const r = await waiting;
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^acme/widgets s#${b.number} \\(feature/multi-b\\): ${server.url}/acme/widgets/pull/${b.number}$`, 'm'));
      assert.match(r.stdout, /One more thing on b\./);
      // Given as numbers, as gh takes them, it says to wait again with the s-numbers.
      assert.match(r.stdout, new RegExp(`then run \`galley pr wait s${a.number} s${b.number}\` again`));

      // News on both: a wait brings one, and the next the other. The poll it dropped lost nothing.
      await comment(a.number, 'Note on a.');
      await comment(b.number, 'Note on b.');
      const first = (await cli(['pr', 'wait', ...both, '--timeout', '5s'])).stdout;
      const second = (await cli(['pr', 'wait', ...both, '--timeout', '5s'])).stdout;
      assert.notEqual(/Note on a\./.test(first), /Note on b\./.test(first), first);
      assert.match(first + second, /Note on a\.[^]*Note on b\.|Note on b\.[^]*Note on a\./);

      // One query asks GitHub about both. Given as people write them, s#N, the hints use s-numbers.
      const waitingAgain = cli(['pr', 'wait', `s#${a.number}`, `s#${b.number}`, '--timeout', '20s']);
      await untilWaiting(a.base, b.base);
      await githubSays({ [a.id]: merged, [b.id]: open });
      const query = readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').findLast((l) => l.includes(`p${a.id}:pullRequest`));
      assert.match(query!, new RegExp(`p${b.id}:pullRequest\\(number:7\\)`));
      const merge = await waitingAgain;
      assert.match(merge.stdout, new RegExp(`^acme/widgets s#${a.number} \\(feature/multi-a\\)`, 'm'));
      assert.match(merge.stdout, /^Merged on GitHub as e468a4e by laat/m);
      assert.match(merge.stdout, new RegExp(`Wait on the others with \`galley pr wait s${b.number}\`\\.`));
    });
  } finally {
    rmSync(join(dir, 'gh-pulls.json'), { force: true });
  }
});

test('after publishing, the author waiting pushes each commit to GitHub, safely', async (t) => {
  /** The branch's tip on GitHub (the bare remote): its commit, whether it is signed, and its parent. */
  const tip = (branch: string) => {
    const sha = execFileSync('git', ['--git-dir', remote, 'rev-parse', branch], { encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['--git-dir', remote, 'cat-file', 'commit', sha], { encoding: 'utf8' });
    return { sha, signed: /^gpgsig /m.test(commit), parent: commit.match(/^parent ([0-9a-f]+)$/m)?.[1] ?? null };
  };
  /** Stage a branch with one commit as the agent, publish it as the reviewer, and let the agent hear of the publish. */
  const published = async (branch: string, opts: { sign?: boolean } = {}) => {
    const file = `${branch.split('/').pop()}.js`;
    git('checkout', '-q', 'main');
    git('checkout', '-qb', branch);
    writeFileSync(join(repo, file), 'export {};\n');
    git('add', file);
    git('commit', '-qm', `Add ${file}`);
    const created = await cli(['pr', 'create', '--title', `Add ${file}`, '--body', 'x']);
    assert.equal(created.code, 0, created.stderr);
    const n = created.stdout.trim().split('/').pop()!;
    const base = `/api/repos/acme/widgets/pulls/${n}`;
    const { id } = await human('POST', `${base}/publish`, { sign: opts.sign ?? false });
    assert.match((await cli(['pr', 'wait', n, '--timeout', '20s'])).stdout, /^Published to GitHub: /m);
    return {
      n,
      id,
      base,
      /** A new commit, as the agent; its short SHA. */
      commit: (text: string) => {
        writeFileSync(join(repo, file), text);
        git('commit', '-qam', `Change ${file}`);
        return git('rev-parse', '--short=7', 'HEAD');
      },
      wait: (timeout = '20s') => cli(['pr', 'wait', n, '--timeout', timeout]),
      tip: () => tip(branch),
      pushes: async (): Promise<any[]> => (await human('GET', `/api/repos/acme/widgets/issues/${n}/timeline`)).filter((e: any) => e.event === 'github_push'),
      page: async () => (await fetch(`${server.url}/acme/widgets/pull/${n}`)).text(),
    };
  };
  const ghCalls = () => readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter(Boolean);

  await t.test('a commit is pushed when the author waits, and no reviewer agent reviews it', async () => {
    await human('PUT', '/api/settings/codex', { enabled: true, maxIterations: 3 });
    try {
      const pr = await published('feature/push-update');
      const before = pr.tip();
      const calls = ghCalls().length;
      const sha = pr.commit('export const updated = 1;\n');
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^Pushed ${sha} to GitHub: https://github\\.com/acme/widgets/pull/7$`, 'm'));
      // A fast-forward of the agent's commit, as the publish was unsigned.
      assert.deepEqual(pr.tip(), { sha: git('rev-parse', 'HEAD'), signed: false, parent: before.sha });
      assert.deepEqual((await human('GET', `${pr.base}/reviewers/codex`)).runs, []);
      // GitHub was asked whether it is still open first; the title and description were left alone.
      const asked = ghCalls().slice(calls);
      assert.ok(asked.includes('pr view https://github.com/acme/widgets/pull/7 --json state,mergedAt,mergedBy,mergeCommit,closedAt'), asked.join('\n'));
      assert.ok(!asked.some((c) => c.startsWith('pr edit ')), asked.join('\n'));
      const [push] = await pr.pushes();
      assert.deepEqual([push.result, push.source, push.head, push.before, push.force], ['pushed', git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD'), before.sha, false]);
      assert.deepEqual((await human('GET', pr.base)).turn, { whose: 'none', reasons: [] });
      // No Stop iterating once published: there are no automatic reviews to stop.
      const page = await pr.page();
      assert.doesNotMatch(page, /Stop iterating/);
      assert.match(page, /<span class="agent-chunk">Automatic: 0 before publishing<\/span>/);
      // Nor controls for them in the reviewer agents' menus: asking for a review and the settings stay.
      const menus = [...page.matchAll(/<details class="dropdown details-reset agent-menu[^]*?<\/details>/g)].map((m) => m[0]);
      assert.ok(menus.length);
      for (const menu of menus) {
        assert.match(menu, /class="dropdown-item js-run-codex"[^>]*>Ask .+ to review</);
        assert.match(menu, />Settings</);
        assert.doesNotMatch(menu, /Automatic reviews of this pull request|codex-limit|js-reviewer-switch|Follow Settings/);
      }
    } finally {
      await human('PUT', '/api/settings/codex', { enabled: false, model: '', effort: '', maxIterations: 3 });
    }
  });

  await t.test('signed as the publish was: signed copies after a signed publish, the commits as they are after an unsigned one', async () => {
    const signed = await published('feature/push-signed', { sign: true });
    const first = signed.tip();
    assert.equal(first.signed, true);
    signed.commit('export const signed = 1;\n');
    assert.match((await signed.wait()).stdout, /^Pushed [0-9a-f]{7} to GitHub/m);
    const copy = signed.tip();
    assert.deepEqual([copy.signed, copy.parent], [true, first.sha]);
    assert.notEqual(copy.sha, git('rev-parse', 'HEAD'));
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', `${copy.sha}^{tree}`], { encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD^{tree}'));
    assert.deepEqual((await signed.pushes()).map((p) => [p.sign, p.signed, p.force]), [[true, 1, false]]);

    // git signs by default here, but this one was published unsigned: its update is not signed either, nor forced.
    const unsigned = await published('feature/push-unsigned', { sign: false });
    const before = unsigned.tip();
    unsigned.commit('export const unsigned = 1;\n');
    assert.match((await unsigned.wait()).stdout, /^Pushed [0-9a-f]{7} to GitHub/m);
    assert.deepEqual(unsigned.tip(), { sha: git('rev-parse', 'HEAD'), signed: false, parent: before.sha });

    // Published unsigned before galley recorded whether a publish signed: GitHub's commit says so.
    const older = await published('feature/push-older', { sign: false });
    server.service.db.run("UPDATE events SET data = json_remove(data, '$.sign') WHERE pull_id = ? AND type = 'published'", older.id);
    const tip = older.tip();
    older.commit('export const older = 1;\n');
    assert.match((await older.wait()).stdout, /^Pushed [0-9a-f]{7} to GitHub/m);
    assert.deepEqual(older.tip(), { sha: git('rev-parse', 'HEAD'), signed: false, parent: tip.sha });
  });

  await t.test('a branch that moved on GitHub is not overwritten: the author and the reviewer hear why, and it is not tried again', async () => {
    const pr = await published('feature/push-moved');
    // Someone pushes to the branch on GitHub ...
    const at = pr.tip().sha;
    const tree = execFileSync('git', ['--git-dir', remote, 'rev-parse', `${at}^{tree}`], { encoding: 'utf8' }).trim();
    const theirs = execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-p', at, '-m', 'Commit suggestion'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'gh@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'gh@example.com' },
    }).trim();
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-moved', theirs]);
    // ... while the agent rewrites its commit, which needs a force-push.
    git('commit', '-q', '--amend', '-m', 'Add push-moved.js, reworded');
    const sha = git('rev-parse', '--short=7', 'HEAD');
    const r = await pr.wait();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^Could not push ${sha} to GitHub: git push failed \\(the branch on GitHub changed since it was last published`, 'm'));
    assert.match(r.stdout, /stale info/);
    assert.match(r.stdout, /Nothing on GitHub was overwritten, and this commit is not tried again\. Do not push or force-push to GitHub yourself/);
    assert.equal(pr.tip().sha, theirs);
    const [push] = await pr.pushes();
    assert.deepEqual([push.result, push.source, push.head, push.before, push.force, push.retry], ['failed', git('rev-parse', 'HEAD'), null, at, true, false]);

    // The reviewer sees why, and it is the reviewer's to sort out.
    const page = await pr.page();
    assert.match(page, new RegExp(`<strong>Could not force-push <code>${sha}</code> to GitHub <relative-time [^]*?<pre class="merge-error">git push failed \\(the branch on GitHub changed since it was last published`));
    assert.match(page, new RegExp(`Could not force-push <code>${sha}</code> to <a [^>]*>acme/widgets#7</a> [^]*?; nothing on GitHub was overwritten`));
    const { turn } = await human('GET', pr.base);
    assert.equal(turn.whose, 'reviewer');
    assert.ok(turn.reasons.some((x: any) => x.text === `update not published: commits; pushing ${sha} failed`), JSON.stringify(turn.reasons));

    // Not tried again for this commit: the next wait waits, and GitHub keeps its commit.
    assert.equal((await pr.wait('1s')).code, 124);
    assert.equal(pr.tip().sha, theirs);
    assert.equal((await pr.pushes()).length, 1);

    // The agent brings in the commit added on GitHub: its next commit is pushed on top of it.
    git('fetch', '-q', remote, '+refs/heads/feature/push-moved:refs/remotes/origin/feature/push-moved');
    git('reset', '-q', '--hard', 'origin/feature/push-moved');
    const next = pr.commit('export const moved = 1;\n');
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${next} to GitHub`, 'm'));
    assert.deepEqual([pr.tip().sha, pr.tip().parent], [git('rev-parse', 'HEAD'), theirs]);
  });

  await t.test('signed, the commit added on GitHub that the author brought in is kept as it is, and its commit goes on top', async () => {
    const pr = await published('feature/push-kept', { sign: true });
    // Someone pushes an unsigned commit to the branch on GitHub.
    const at = pr.tip().sha;
    const tree = execFileSync('git', ['--git-dir', remote, 'rev-parse', `${at}^{tree}`], { encoding: 'utf8' }).trim();
    const theirs = execFileSync('git', ['--git-dir', remote, 'commit-tree', tree, '-p', at, '-m', 'Commit suggestion'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com', GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com' },
    }).trim();
    execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/feature/push-kept', theirs]);
    // The agent brings it in and commits on top: signing copies the agent's commit, not theirs.
    git('fetch', '-q', remote, '+refs/heads/feature/push-kept:refs/remotes/origin/feature/push-kept');
    git('reset', '-q', '--hard', 'origin/feature/push-kept');
    const sha = pr.commit('export const kept = 1;\n');
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
    const tip = pr.tip();
    assert.deepEqual([tip.signed, tip.parent], [true, theirs]);
    assert.deepEqual((await pr.pushes()).map((p) => [p.result, p.force, p.before]), [['pushed', false, theirs]]);
  });

  await t.test('a publish by hand under way goes first: the push for the waiting author waits for it, and sees no refusal in it', async () => {
    const pr = await published('feature/push-race');
    pr.commit('export const raced = 1;\n');
    const gate = join(dir, 'push-race-gate');
    try {
      await withFakes({ FAKE_GH_EDIT_GATE: gate }, async () => {
        // The reviewer publishes the update by hand, signed this time, which force-pushes signed copies; gh pr edit holds it up.
        const publishing = human('POST', `${pr.base}/publish`, { sign: true, force: true });
        await until(() => pr.tip().signed, 'the publish pushed');
        // Meanwhile the agent waits with the same head.
        const waiting = pr.wait();
        await until(async () => (await human('GET', pr.base)).author_waiting, 'the agent waits');
        await new Promise((r) => setTimeout(r, 500));
        writeFileSync(gate, '');
        await publishing;
        assert.match((await waiting).stdout, /^Published to GitHub/m);
      });
    } finally {
      rmSync(gate, { force: true });
    }
    assert.deepEqual(await pr.pushes(), []);
  });

  await t.test('while a commit is pushed, and until galley asks GitHub again, the merge GitHub offered for the commit before is nobody\'s turn', async () => {
    const pr = await published('feature/push-stale');
    /** GitHub would merge `head` now, and auto-merge is off; galley asks, as it does every minute. */
    const mergeable = async (head: string) => {
      const node = { state: 'OPEN', mergedAt: null, closedAt: null, mergedBy: null, mergeCommit: null, timelineItems: { nodes: [] }, headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', autoMergeRequest: null };
      writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${pr.id}`]: node } } }));
      await server.service.followGithub();
    };
    const turn = async () => {
      const { whose, reasons } = (await human('GET', pr.base)).turn;
      return { whose, github: reasons.filter((r: any) => r.kind === 'github').map((r: any) => r.text) };
    };
    // GitHub takes the next push once the gate opens.
    const hook = join(remote, 'hooks', 'pre-receive');
    const pushing = join(dir, 'push-stale-pushing');
    const gate = join(dir, 'push-stale-gate');
    writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\ntouch "${pushing}"\nwhile [ ! -f "${gate}" ]; do sleep 0.05; done\n`);
    chmodSync(hook, 0o755);
    let waiting: ReturnType<typeof pr.wait> | null = null;
    try {
      const first = pr.tip().sha;
      await mergeable(first);
      assert.deepEqual(await turn(), { whose: 'reviewer', github: ['ready to merge on GitHub'] });
      // The agent commits and waits, and its commit is on its way to GitHub.
      const sha = pr.commit('export const stale = 1;\n');
      waiting = pr.wait();
      await until(() => existsSync(pushing), 'the push started');
      assert.deepEqual(await turn(), { whose: 'none', github: [] });
      writeFileSync(gate, '');
      assert.match((await waiting).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
      assert.deepEqual(await turn(), { whose: 'none', github: [] });
      // Force-pushed back to the first commit on GitHub before galley asked: GitHub says what it said
      // before, which is about GitHub's commit now, and pages hear of it.
      const heard: string[] = [];
      const hear = (e: ChangeEvent) => void (e.pullId === pr.id && heard.push(e.type));
      server.service.bus.on('change', hear);
      try {
        await mergeable(first);
      } finally {
        server.service.bus.off('change', hear);
      }
      assert.ok(heard.includes('github_status'), heard.join());
      assert.deepEqual(await turn(), { whose: 'reviewer', github: ['ready to merge on GitHub'] });
      // Pushed again, GitHub would merge the new commit: the reviewer's turn.
      await mergeable(pr.tip().sha);
      assert.deepEqual(await turn(), { whose: 'reviewer', github: ['ready to merge on GitHub'] });
    } finally {
      // The push goes through, also after a failure, before the next test pushes.
      rmSync(hook, { force: true });
      writeFileSync(gate, '');
      await waiting;
      for (const f of [pushing, gate, join(dir, 'gh-pulls.json')]) rmSync(f, { force: true });
    }
  });

  await t.test('a push GitHub declines, for a secret say, is told to the author, and not tried again', async () => {
    const pr = await published('feature/push-declined');
    const before = pr.tip().sha;
    // GitHub's push protection, or a rule on the branch.
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do if [ "$ref" = refs/heads/feature/push-declined ]; then echo "GH013: Repository rule violations found: push cannot contain secrets" >&2; exit 1; fi; done\n');
    chmodSync(hook, 0o755);
    try {
      const sha = pr.commit('export const token = "ghp_0";\n');
      const r = await pr.wait();
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`^Could not push ${sha} to GitHub: git push failed \\(GitHub declined it, for example for a secret in it, or a rule on the branch\\)`, 'm'));
      assert.match(r.stdout, /GH013: Repository rule violations found/);
      assert.equal((await pr.wait('1s')).code, 124);
    } finally {
      rmSync(hook, { force: true });
    }
    assert.equal(pr.tip().sha, before);
  });

  await t.test('GitHub could not be asked: nothing is pushed, the author waits on, and its next wait tries again', async () => {
    const pr = await published('feature/push-retry');
    const before = pr.tip().sha;
    const sha = pr.commit('export const retried = 1;\n');
    await withFakes({ FAKE_GH_FAIL: 'HTTP 502: gh is down' }, async () => {
      // The author hears nothing of it, and one wait tries once.
      assert.equal((await pr.wait('3s')).code, 124);
    });
    assert.equal(pr.tip().sha, before);
    const failed = await pr.pushes();
    assert.deepEqual(failed.map((p) => [p.result, p.retry, p.error]), [['failed', true, 'could not ask GitHub whether https://github.com/acme/widgets/pull/7 is still open:\nHTTP 502: gh is down']]);
    // The reviewer sees it, and that it is tried again.
    assert.match(await pr.page(), new RegExp(`<strong>Could not push <code>${sha}</code> to GitHub <relative-time [^]*?It is tried again each time agent waits`));
    const { turn } = await human('GET', pr.base);
    assert.equal(turn.whose, 'reviewer');
    assert.ok(turn.reasons.some((x: any) => x.text === `update not published: commits; pushing ${sha} failed`), JSON.stringify(turn.reasons));
    // GitHub answers again: the next wait pushes it.
    assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
    assert.equal(pr.tip().sha, git('rev-parse', 'HEAD'));
  });

  await t.test('nothing is pushed once GitHub says it was merged, also before galley has heard', async () => {
    const pr = await published('feature/push-merged');
    const before = pr.tip().sha;
    pr.commit('export const late = 1;\n');
    // Merged on GitHub a moment ago: following has not asked yet, so galley knows only when it asks before the push.
    await withFakes({ FAKE_GH_VIEW: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-17T12:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: { oid: 'e468a4e' + '2'.repeat(33) } }) }, async () => {
      assert.match((await pr.wait()).stdout, /^Merged on GitHub as e468a4e by laat/m);
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pr.tip().sha, before);
    assert.deepEqual(await pr.pushes(), []);
  });

  await t.test('feedback the author has not seen holds the push until it has', async () => {
    const pr = await published('feature/push-held');
    const before = pr.tip().sha;
    const sha = pr.commit('export const held = 1;\n');
    // The reviewer asks Codex and Claude to look at the new commit. Codex comments; Claude is still at it.
    const gate = join(dir, 'push-held-gate');
    await withFakes({
      FAKE_CODEX_REVIEW: JSON.stringify({ summary: 'One thing.', comments: [{ path: 'push-held.js', line: 1, start_line: null, side: 'RIGHT', priority: 'low', body: 'Name the value.' }] }),
      FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine.', comments: [] }),
      FAKE_CLAUDE_GATE: gate,
    }, async () => {
      try {
        await human('POST', `${pr.base}/reviewers/codex`);
        await human('POST', `${pr.base}/reviewers/claude`);
        await server.service.codex!.settle(pr.id);
        // The agent waits: its wait holds Codex's review for Claude's, and its commit is not pushed meanwhile.
        const waiting = pr.wait();
        await until(async () => (await human('GET', pr.base)).author_waiting, 'the agent waits');
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(pr.tip().sha, before);
        writeFileSync(gate, '');
        const r = await waiting;
        assert.match(r.stdout, /Name the value\./);
        assert.doesNotMatch(r.stdout, /Pushed/);
        await server.service.claude!.settle(pr.id);
        assert.equal(pr.tip().sha, before);
        // Seen, the next wait pushes it.
        assert.match((await pr.wait()).stdout, new RegExp(`^Pushed ${sha} to GitHub`, 'm'));
        assert.equal(pr.tip().sha, git('rev-parse', 'HEAD'));
      } finally {
        rmSync(gate, { force: true });
      }
    });
  });
});

test('the list has a tab for each state: staged, published and open on GitHub, and done', async () => {
  // A repository of its own, so the tabs count only these pull requests.
  const tabs = join(dir, 'tabs');
  const tabsRemote = join(dir, 'tabs.git');
  execFileSync('git', ['init', '-q', '--bare', tabsRemote]);
  execFileSync('git', ['init', '-q', '-b', 'main', tabs]);
  const g = (...args: string[]) => execFileSync('git', ['-C', tabs, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args]);
  g('remote', 'add', 'origin', 'https://github.com/acme/tabs.git');
  g('config', `url.${tabsRemote}.pushInsteadOf`, 'https://github.com/acme/tabs.git');
  writeFileSync(join(tabs, 'a.js'), 'export {};\n');
  g('add', '.');
  g('commit', '-qm', 'Initial commit');
  g('push', '-q', 'origin', 'main');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  await human('POST', '/api/repos', { path: tabs });
  const api = '/api/repos/acme/tabs/pulls';
  /** A pull request with a commit on a branch of its own, staged by the agent. */
  const stage = async (name: string): Promise<{ id: number; number: number }> => {
    g('checkout', '-q', 'main');
    g('checkout', '-qb', name);
    writeFileSync(join(tabs, `${name}.js`), 'export {};\n');
    g('add', '.');
    g('commit', '-qm', `Add ${name}`);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Add ${name}`, head: name, base: 'main', automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const staged = await stage('staged');
  const published = await stage('published');
  const merged = await stage('merged');
  const closedOnGithub = await stage('closed-on-github');
  const closedHere = await stage('closed-here');
  for (const p of [published, merged, closedOnGithub]) await human('POST', `${api}/${p.number}/publish`, { sign: false });
  await human('PATCH', `${api}/${closedHere.number}`, { state: 'closed' });
  // What GitHub says about the published ones.
  const node = (state: string, by: string | null) => ({
    state,
    mergedAt: state === 'MERGED' ? '2026-10-16T09:00:00Z' : null,
    closedAt: state === 'OPEN' ? null : '2026-10-16T09:00:00Z',
    mergedBy: state === 'MERGED' ? { login: by } : null,
    mergeCommit: state === 'MERGED' ? { oid: 'e468a4e' + '1'.repeat(33) } : null,
    timelineItems: { nodes: by ? [{ __typename: 'ClosedEvent', actor: { login: by } }] : [] },
  });
  const repository = { [`p${published.id}`]: node('OPEN', null), [`p${merged.id}`]: node('MERGED', 'laat'), [`p${closedOnGithub.id}`]: node('CLOSED', 'octocat') };
  writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository } }));
  try {
    await server.service.followGithub();
  } finally {
    rmSync(join(dir, 'gh-pulls.json'), { force: true });
  }

  const page = async (path: string) => (await fetch(server.url + path)).text();
  /** The tabs and their counts. */
  const counts = (html: string) => Object.fromEntries([...html.matchAll(/<a class="list-tab[^"]*" href="\/acme\/tabs\?state=(\w+)">[^]*?<\/svg> <span data-content="[^"]*">(\d+) /g)].map((m) => [m[1], Number(m[2])]));
  /** The pull requests a page lists, by number. */
  const listed = (html: string) => [...html.matchAll(/href="\/acme\/tabs\/pull\/(\d+)">s#\1<\/a>/g)].map((m) => Number(m[1])).sort();
  const front = await page('/acme/tabs');
  // Each pull request is in one tab; Staged is the first, and shown unless another is asked for.
  assert.deepEqual(counts(front), { staged: 1, published: 1, done: 3 });
  assert.match(front, /<a class="list-tab selected" href="\/acme\/tabs\?state=staged">/);
  // Each label carries its bold copy (data-content), so it is as wide whether selected or not and selecting a tab moves no other.
  assert.match(front, /href="\/acme\/tabs\?state=published"><svg [^>]*>[^]*?<\/svg> <span data-content="1 Published">1 Published<\/span><\/a>/);
  assert.deepEqual(listed(front), [staged.number]);
  const publishedTab = await page('/acme/tabs?state=published');
  assert.deepEqual(listed(publishedTab), [published.number]);
  const done = await page('/acme/tabs?state=done');
  assert.deepEqual(listed(done), [merged.number, closedOnGithub.number, closedHere.number].sort());
  // Done says how each ended, in the colours of the states: purple merged, red closed. Open on GitHub is green.
  const row = (html: string, n: number) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/tabs/pull/${n}"`))!;
  assert.match(row(done, merged.number), /octicon-git-merge color-fg-done[^]*<span class="Label Label--merged">Merged<\/span>/);
  assert.match(row(done, closedOnGithub.number), /octicon-git-pull-request-closed color-fg-closed[^]*<span class="Label Label--closed">Closed on GitHub<\/span>/);
  assert.match(row(done, closedHere.number), /octicon-git-pull-request-closed color-fg-closed[^]*<span class="Label Label--closed">Closed<\/span>/);
  assert.match(row(publishedTab, published.number), /octicon-mark-github color-fg-open/);
  // A published pull request's title opens it on GitHub, and a staged one's here.
  assert.match(row(publishedTab, published.number), /<a class="pr-row-title" href="https:\/\/github\.com\/acme\/widgets\/pull\/7" target="_blank" rel="noopener">Add published<\/a>/);
  assert.match(row(front, staged.number), new RegExp(`<a class="pr-row-title" href="/acme/tabs/pull/${staged.number}">Add staged</a>`));
  // The staged one waits for the reviewer: its tab says so, whichever tab is shown. The published one waits on GitHub.
  assert.match(done, /href="\/acme\/tabs\?state=staged">[^]*?>1 Staged<\/span> <span class="list-tab-turn" title="1 pull request waiting for you">/);
  assert.match(front, /<h2 class="turn-group-title">Your turn<\/h2>[^]*?href="\/acme\/tabs\/pull\/1">/);
  assert.match(publishedTab, /<h2 class="turn-group-title">Waiting on GitHub<\/h2>/);
  // Staged in a colour of its own, and said in words: staged, not asking to merge.
  const pullPage = await page(`/acme/tabs/pull/${staged.number}`);
  assert.match(pullPage, /<span class="State State--staged"><svg [^>]*octicon-git-pull-request[^>]*>[^]*?<\/svg> Staged<\/span>/);
  assert.match(pullPage, />agent<\/a><span class="Label Label--bot">bot<\/span> staged 1 commit for\s*<span class="branch-name">main<\/span>/);

  // The REST API keeps GitHub's open and closed, with the staging state as an extension.
  const rest = async (state: string) => ((await human('GET', `${api}?state=${state}`)) as any[]).map((p) => [p.number, p.state, p.staging_state]).sort();
  assert.deepEqual(await rest('open'), [[staged.number, 'open', 'staged'], [published.number, 'open', 'published']]);
  assert.deepEqual(await rest('closed'), [[merged.number, 'closed', 'done'], [closedOnGithub.number, 'closed', 'done'], [closedHere.number, 'closed', 'done']].sort());
  assert.deepEqual(await rest('staged'), [[staged.number, 'open', 'staged']]);
  assert.deepEqual(await rest('published'), [[published.number, 'open', 'published']]);
  assert.deepEqual((await rest('done')).length, 3);
  assert.deepEqual(await rest('merged'), [[merged.number, 'closed', 'done']]);
  const bad = await fetch(`${server.url}${api}?state=opened`);
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).message, /^state must be one of staged, published, done, merged, open, closed, all$/);

  // gh's JSON names the state; --state open finds the staged and the published ones, as gh finds open ones.
  const list = async (...args: string[]) => {
    const r = await cli(['pr', 'list', '-R', 'acme/tabs', '--json', 'number,state', ...args]);
    assert.equal(r.code, 0, r.stderr);
    return (JSON.parse(r.stdout) as { number: number; state: string }[]).map((p) => [p.number, p.state]).sort();
  };
  assert.deepEqual(await list(), [[staged.number, 'STAGED'], [published.number, 'PUBLISHED']]);
  assert.deepEqual(await list('--state', 'staged'), [[staged.number, 'STAGED']]);
  assert.deepEqual(await list('--state', 'done'), [[merged.number, 'MERGED'], [closedOnGithub.number, 'CLOSED'], [closedHere.number, 'CLOSED']].sort());
  assert.deepEqual(await list('--state', 'closed'), await list('--state', 'done'));
  const wrong = await cli(['pr', 'list', '-R', 'acme/tabs', '--state', 'opened']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /state must be one of staged, published, done/);
});

/**
 * A repository of its own, acme/<name> on GitHub (pushing to a bare repository), or with `github`
 * false local/<name> with no remote, where `stage` stages a branch with a commit of its own as the agent.
 */
async function scratchRepo(name: string, { github = true } = {}) {
  const path = join(dir, name);
  const bare = join(dir, `${name}.git`);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  const g = (...args: string[]) => execFileSync('git', ['-C', path, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { encoding: 'utf8' }).trim();
  writeFileSync(join(path, 'a.js'), 'export {};\n');
  g('add', '.');
  g('commit', '-qm', 'Initial commit');
  if (github) {
    execFileSync('git', ['init', '-q', '--bare', bare]);
    g('remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
    g('config', `url.${bare}.pushInsteadOf`, `https://github.com/acme/${name}.git`);
    g('push', '-q', 'origin', 'main');
    g('update-ref', 'refs/remotes/origin/main', 'main');
  }
  const { full_name } = await human('POST', '/api/repos', { path });
  const api = `/api/repos/${full_name}/pulls`;
  const stage = async (branch: string): Promise<{ id: number; number: number }> => {
    g('checkout', '-q', 'main');
    g('checkout', '-qb', branch);
    writeFileSync(join(path, `${branch}.js`), 'export {};\n');
    g('add', '.');
    g('commit', '-qm', `Add ${branch}`);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Add ${branch}`, head: branch, base: 'main', automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  return { fullName: full_name as string, api, stage, path, g };
}

test('a repository renamed on GitHub takes its new name, and its old URLs lead there', async () => {
  const { fullName, api, stage, path, g } = await scratchRepo('old-name');
  assert.equal(fullName, 'acme/old-name');
  const pr = await stage('renamed');
  const events: string[] = [];
  const listen = (e: { type: string }) => events.push(e.type);
  server.service.bus.on('change', listen);
  try {
    // The remote follows the rename on GitHub; the next CLI call registers the repository again.
    g('remote', 'set-url', 'origin', 'https://github.com/acme/new-name.git');
    assert.equal((await human('POST', '/api/repos', { path })).full_name, 'acme/new-name');
    // Open pages hear of it, and their next refresh follows the redirect.
    assert.ok(events.includes('repo_renamed'), events.join());
    // The old pages redirect, with the rest of the URL. Browsers do not keep the redirect: the name may change back.
    for (const [from, to] of [
      [`/acme/old-name/pull/${pr.number}/files?diff=split`, `/acme/new-name/pull/${pr.number}/files?diff=split`],
      ['/acme/old-name', '/acme/new-name'],
    ]) {
      const res = await fetch(server.url + from, { redirect: 'manual' });
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.get('location'), to);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.match(await (await fetch(`${server.url}/acme/old-name/pull/${pr.number}`)).text(), new RegExp(`<title>Add renamed by agent · Pull Request s#${pr.number} · acme/new-name</title>`));
    // The API answers at the old paths, for pages opened before and for scripts, in the new name.
    assert.equal((await human('GET', `${api}/${pr.number}`)).html_url, `${server.url}/acme/new-name/pull/${pr.number}`);
    await human('POST', `/api/repos/acme/old-name/issues/${pr.number}/comments`, { body: 'Still reachable' });
    assert.equal((await human('GET', `/api/repos/acme/new-name/issues/${pr.number}/comments`)).at(-1).body, 'Still reachable');

    // Renamed again while nothing registers it: the server follows the remote when it starts.
    g('remote', 'set-url', 'origin', 'https://github.com/acme/third-name.git');
    await server.service.followRemotes();
    const keys = () => server.service.repos().map((r) => `${r.owner}/${r.name}`);
    assert.ok(keys().includes('acme/third-name'), keys().join());
    for (const old of ['acme/old-name', 'acme/new-name']) assert.equal((await human('GET', `/api/repos/${old}`)).full_name, 'acme/third-name');

    // Back to the first name: it is the repository's own again, and the others lead to it.
    g('remote', 'set-url', 'origin', 'https://github.com/acme/old-name.git');
    assert.equal((await human('POST', '/api/repos', { path })).full_name, 'acme/old-name');
    assert.equal((await fetch(`${server.url}/acme/old-name/pull/${pr.number}`, { redirect: 'manual' })).status, 200);
    assert.equal((await fetch(`${server.url}/acme/third-name`, { redirect: 'manual' })).headers.get('location'), '/acme/old-name');

    // A repository that has a name another had before takes it; the other keeps its own.
    const other = await scratchRepo('third-name');
    assert.equal(other.fullName, 'acme/third-name');
    assert.equal((await fetch(`${server.url}/acme/third-name`, { redirect: 'manual' })).status, 200);
    // Renamed to one another repository has, it is numbered as when it was registered.
    g('remote', 'set-url', 'origin', 'https://github.com/acme/third-name.git');
    assert.equal((await human('POST', '/api/repos', { path })).full_name, 'acme/third-name-2');
    assert.equal((await human('GET', '/api/repos/acme/third-name')).full_name, 'acme/third-name');

    // Registered before names followed GitHub, with the new one recorded but not taken: it takes it when the server starts.
    const id = server.service.repos().find((r) => r.name === 'third-name-2')!.id;
    server.service.db.update('repos', id, { name: 'from-before' });
    await server.service.followRemotes();
    assert.equal((await human('GET', '/api/repos/acme/from-before')).full_name, 'acme/third-name-2');

    // A number stays when the repository it made way for moves on, whose old name leads to it still.
    const twin = await scratchRepo('twin');
    const clone = await scratchRepo('twin-clone', { github: false });
    clone.g('remote', 'add', 'origin', 'https://github.com/acme/twin.git');
    assert.equal((await human('POST', '/api/repos', { path: clone.path })).full_name, 'acme/twin-2');
    twin.g('remote', 'set-url', 'origin', 'https://github.com/acme/twin-renamed.git');
    assert.equal((await human('POST', '/api/repos', { path: twin.path })).full_name, 'acme/twin-renamed');
    assert.equal((await human('POST', '/api/repos', { path: clone.path })).full_name, 'acme/twin-2');
    await server.service.followRemotes();
    assert.equal((await human('GET', '/api/repos/acme/twin-2')).full_name, 'acme/twin-2');
    assert.equal((await fetch(`${server.url}/acme/twin`, { redirect: 'manual' })).headers.get('location'), '/acme/twin-renamed');

    // A name that ends in digits is not numbered: renamed to the name without them, it follows.
    const dated = await scratchRepo('project-2');
    dated.g('remote', 'set-url', 'origin', 'https://github.com/acme/project.git');
    assert.equal((await human('POST', '/api/repos', { path: dated.path })).full_name, 'acme/project');

    // Renamed so before names followed GitHub, with the new name recorded but not taken: it takes it when the server starts.
    const legacy = await scratchRepo('legacy-2025');
    legacy.g('remote', 'set-url', 'origin', 'https://github.com/acme/legacy.git');
    server.service.db.run("UPDATE repos SET github_slug = 'acme/legacy' WHERE owner = 'acme' AND name = 'legacy-2025'");
    await server.service.followRemotes();
    assert.equal((await human('GET', '/api/repos/acme/legacy-2025')).full_name, 'acme/legacy');

    // At start, the server picks the remote as registering does: here a GitHub one added to a local repository, not called origin.
    const upstream = await scratchRepo('upstream-only', { github: false });
    assert.equal(upstream.fullName, 'local/upstream-only');
    upstream.g('remote', 'add', 'upstream', 'https://github.com/acme/upstream-only.git');
    await server.service.followRemotes();
    assert.equal((await human('GET', '/api/repos/local/upstream-only')).full_name, 'acme/upstream-only');
  } finally {
    server.service.bus.off('change', listen);
  }
});

test('the reviewer pins pull requests to the top of the front page, until they unpin them', async () => {
  const { api, stage } = await scratchRepo('pins');
  const [a, b, c] = [await stage('pin-a'), await stage('pin-b'), await stage('pin-c')];
  const page = async (path: string) => (await fetch(server.url + path)).text();
  const titles = (html: string) => [...html.matchAll(/<a class="pr-row-title" href="\/acme\/pins\/pull\/(\d+)">/g)].map((m) => Number(m[1]));
  /** The front page's Pinned section, and the list under it. */
  const front = async (path = '/') => {
    const [top, list] = (await page(path)).split('<div class="Box pr-list"');
    return { pinned: titles(top.split('<div class="Box pinned-list">')[1] ?? ''), list: titles(list) };
  };
  /** What open pages hear of pinning. */
  const events: string[] = [];
  const listen = (e: { pullId: number | null; type: string }) => e.type.endsWith('pinned') && events.push(`${e.type} ${e.pullId}`);
  server.service.bus.on('change', listen);
  try {
    // The front page is the reviewer's: agents can not pin, or unpin.
    for (const method of ['PUT', 'DELETE']) {
      const res = await fetch(`${server.url}${api}/${a.number}/pinned`, { method, headers: { 'x-galley-actor': 'agent' } });
      assert.equal(res.status, 403);
      assert.match((await res.json()).message, /only the user can pin/);
    }

    const updated = (await human('GET', `${api}/${a.number}`)).updated_at;
    // Pinned in the same millisecond, the later pin is still the newer.
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await human('PUT', `${api}/${a.number}/pinned`);
      await human('PUT', `${api}/${c.number}/pinned`);
    } finally {
      mock.timers.reset();
    }
    // Pinned again, it keeps its place: no news.
    await human('PUT', `${api}/${a.number}/pinned`);
    assert.deepEqual(events, [`pinned ${a.id}`, `pinned ${c.id}`]);
    const rest = await human('GET', `${api}/${a.number}`);
    // Pinning is not activity.
    assert.equal(rest.updated_at, updated);
    assert.ok(rest.pinned_at < (await human('GET', `${api}/${c.number}`)).pinned_at);
    assert.equal((await human('GET', `${api}/${b.number}`)).pinned_at, null);
    for (const [n, isPinned] of [[a.number, true], [b.number, false]] as const) {
      const view = await cli(['pr', 'view', String(n), '-R', 'acme/pins', '--json', 'isPinned']);
      assert.equal(view.code, 0, view.stderr);
      assert.deepEqual(JSON.parse(view.stdout), { isPinned });
    }

    // At the top of the front page, most recently pinned first, and not again under the tabs.
    let shown = await front();
    assert.deepEqual(shown, { pinned: [c.number, a.number], list: [b.number] });
    assert.match(await page('/'), /<div class="Box-header turn-group">[^]*?<h2 class="turn-group-title">Pinned<\/h2> <span class="Counter">2<\/span> <span class="turn-group-note">most recently pinned first<\/span>/);
    // With their turn, as elsewhere.
    assert.match((await page('/')).split('<div class="Box pr-list"')[0], /<span class="turn-reason" title="agent is not waiting">agent not waiting/);
    // A repository's list has them in their place, with a pin.
    const list = await page('/acme/pins');
    assert.doesNotMatch(list, /pinned-list/);
    const row = (html: string, n: number) => html.split('<div class="Box-row pr-row').find((r) => r.includes(`href="/acme/pins/pull/${n}"`))!;
    for (const n of [a.number, c.number]) assert.match(row(list, n), /<span class="pin-mark" title="Pinned to the top of the front page"><svg class="octicon octicon-pin-fill" [^>]*aria-label="Pinned"/);
    assert.doesNotMatch(row(list, b.number), /pin-mark/);
    // The pull request's pin is filled while it is pinned, and unpins.
    assert.match(await page(`/acme/pins/pull/${a.number}`), new RegExp(`<button type="button" class="btn btn-sm btn-pin js-pin selected" data-api="${api}/${a.number}/pinned" data-method="DELETE" title="Unpin" aria-label="Unpin" aria-pressed="true"><svg class="octicon octicon-pin-fill"`));
    assert.match(await page(`/acme/pins/pull/${b.number}`), new RegExp(`<button type="button" class="btn btn-sm btn-pin js-pin" data-api="${api}/${b.number}/pinned" data-method="PUT" title="Pin to the top of the front page" aria-label="Pin to the top of the front page" aria-pressed="false"><svg class="octicon octicon-pin"`));

    // Pinned through publishing, the merge, and a close here.
    await human('POST', `${api}/${a.number}/publish`, { sign: false });
    const merged = { state: 'MERGED', mergedAt: '2026-10-16T09:00:00Z', closedAt: '2026-10-16T09:00:00Z', mergedBy: { login: 'laat' }, mergeCommit: { oid: 'e468a4e' + '1'.repeat(33) }, timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'laat' } }] } };
    writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { repository: { [`p${a.id}`]: merged } } }));
    try {
      await server.service.followGithub();
    } finally {
      rmSync(join(dir, 'gh-pulls.json'), { force: true });
    }
    await human('PATCH', `${api}/${c.number}`, { state: 'closed' });
    const done = await human('GET', `${api}/${a.number}`);
    assert.deepEqual([done.github_state, done.pinned_at], ['merged', rest.pinned_at]);
    for (const path of ['/', '/?state=done', '/?state=published']) {
      shown = await front(path);
      assert.deepEqual(shown.pinned, [c.number, a.number], path);
      assert.ok(!shown.list.includes(a.number) && !shown.list.includes(c.number), path);
    }
    assert.match((await page('/')).split('<div class="Box pr-list"')[0], /<span class="Label Label--merged">Merged<\/span>/);

    // Unpinned, it is back in its tab.
    await human('DELETE', `${api}/${a.number}/pinned`);
    await human('DELETE', `${api}/${a.number}/pinned`);
    assert.equal((await human('GET', `${api}/${a.number}`)).pinned_at, null);
    assert.deepEqual(await front('/?state=done'), { pinned: [c.number], list: [a.number] });
    await human('DELETE', `${api}/${c.number}/pinned`);
    assert.doesNotMatch(await page('/'), /pinned-list/);
    assert.deepEqual(events, [`pinned ${a.id}`, `pinned ${c.id}`, `unpinned ${a.id}`, `unpinned ${c.id}`]);
  } finally {
    server.service.bus.off('change', listen);
  }
});

test('the front page and a repository\'s list the repositories with pull requests, latest activity first, with your turn in each', async () => {
  const page = async (path: string) => (await fetch(server.url + path)).text();
  /** The repositories beside the list: name, link, avatar, how many are your turn, whether shown, and which is selected. */
  const sidebar = async (path = '/') => {
    const html = await page(path);
    const aside = html.match(/<div class="container container-full dashboard"><aside class="dashboard-sidebar"[^]*?<\/aside>/)?.[0] ?? '';
    const all = [...aside.matchAll(/<li class="repo-list-item( selected)?" data-name="([^"]+)"( hidden)?>\s*<img class="avatar " src="([^"]+)"[^>]*>\s*<a class="repo-list-name" href="([^"]+)" title="[^"]+"( aria-current="page")?>[^<]*<\/a>\s*(?:<span class="list-tab-turn" title="([^"]+)">[^]*?<\/svg> (\d+)<\/span>)?/g)];
    const selected = all.filter((m) => m[1] && m[6]).map((m) => m[2]);
    const repos = all.map((m) => ({
      name: m[2],
      shown: !m[3],
      avatar: m[4],
      href: m[5],
      turn: m[8] ? Number(m[8]) : 0,
      title: m[7],
    }));
    return { aside, repos, selected };
  };
  const north = await scratchRepo('north');
  const south = await scratchRepo('south');
  const local = await scratchRepo('sidebar-local', { github: false });
  const n1 = await north.stage('n1');
  await south.stage('s1');
  await south.stage('s2');
  const s3 = await south.stage('s3');
  // Closed: not your turn, but activity.
  await human('PATCH', `${south.api}/${s3.number}`, { state: 'closed' });
  await local.stage('l1');

  let { repos } = await sidebar();
  const mine = (names: string[]) => repos.filter((r) => names.includes(r.name));
  // Latest activity first, each with how many are your turn; a link to the repository, and the owner's avatar.
  assert.deepEqual(mine([local.fullName, south.fullName, north.fullName]), [
    { name: local.fullName, shown: true, avatar: '/avatars/local.svg', href: `/${local.fullName}`, turn: 1, title: '1 pull request waiting for you' },
    { name: 'acme/south', shown: true, avatar: 'https://github.com/acme.png?size=40', href: '/acme/south', turn: 2, title: '2 pull requests waiting for you' },
    { name: 'acme/north', shown: true, avatar: 'https://github.com/acme.png?size=40', href: '/acme/north', turn: 1, title: '1 pull request waiting for you' },
  ]);
  assert.equal(repos[0].name, local.fullName);
  // A GitHub owner's avatar falls back to the generated one; a generated one needs none.
  assert.match((await sidebar()).aside, /src="https:\/\/github\.com\/acme\.png\?size=40" data-fallback="\/avatars\/acme\.svg"/);
  // A comment is activity; a repository with nothing for you has no count.
  await human('POST', `/api/repos/acme/north/issues/${n1.number}/comments`, { body: 'Moving.' });
  await human('PATCH', `${north.api}/${n1.number}`, { state: 'closed' });
  ({ repos } = await sidebar('/?state=done'));
  assert.deepEqual(repos[0], { name: 'acme/north', shown: true, avatar: 'https://github.com/acme.png?size=40', href: '/acme/north', turn: 0, title: undefined });
  // A repository's page has the same, with that one selected; the front page has none selected.
  const front = await sidebar('/');
  assert.doesNotMatch(front.aside, /selected|aria-current/);
  const onNorth = await sidebar('/acme/north');
  assert.deepEqual(onNorth.repos, front.repos);
  assert.deepEqual(onNorth.selected, ['acme/north']);
  // A repository without pull requests has the same, with none selected.
  const empty = await scratchRepo('sidebar-empty');
  const onEmpty = await sidebar(`/${empty.fullName}`);
  assert.deepEqual(onEmpty.repos, front.repos);
  assert.deepEqual(onEmpty.selected, []);

  // Ten at most, then a filter and "Show more".
  for (let i = repos.length; i < 10; i++) await (await scratchRepo(`more-${i}`)).stage('more');
  let { aside } = await sidebar();
  ({ repos } = await sidebar());
  assert.equal(repos.length, 10);
  assert.doesNotMatch(aside, /js-repo-filter|js-repo-more/);
  await (await scratchRepo('eleventh')).stage('more');
  ({ aside, repos } = await sidebar());
  assert.equal(repos.length, 11);
  assert.deepEqual(repos.map((r) => r.shown), [...Array(10).fill(true), false]);
  assert.equal(repos[0].name, 'acme/eleventh');
  assert.match(aside, /<input type="search" class="form-control repo-filter js-repo-filter" placeholder="Find a repository…"/);
  assert.match(aside, /<ul class="repo-list js-repo-list" data-shown="10">/);
  assert.match(aside, /<button type="button" class="btn-link repo-list-more js-repo-more">Show more<\/button>/);
  // One past the first ten is shown on its page in place of the tenth, so as many are shown.
  const past = await sidebar(`/${repos[10].name}`);
  assert.deepEqual(past.selected, [repos[10].name]);
  assert.deepEqual(past.repos.map((r) => r.shown), [...Array(9).fill(true), false, true]);
  assert.match(past.aside, /js-repo-more/);
});

test('a pull request that conflicts with its base: the reviewer sees it, the author is told to rebase, and auto-publish waits', async (t) => {
  const { fullName, api, path, g } = await scratchRepo('conflicts');
  const agent = { 'content-type': 'application/json', 'x-galley-actor': 'agent' };
  /** Hold up the checks for conflicts, as a slow git would, until the function returned is called. */
  const hold = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.service.conflictChecks = server.service.conflictChecks.then(() => held);
    return release;
  };
  /** Stage `branch`, made from `from` with `file` (a.js) changed to `text`, as the agent. */
  const stage = async (branch: string, from: string, text: string, file = 'a.js') => {
    g('checkout', '-q', '-b', branch, from);
    writeFileSync(join(path, file), text);
    g('add', file);
    g('commit', '-qm', `Set ${file} in ${branch}`);
    const res = await fetch(server.url + api, { method: 'POST', headers: agent, body: JSON.stringify({ title: `Set a in ${branch}`, head: branch, base: 'main', automatic_reviews: false }) });
    assert.equal(res.status, 201);
    const { id, number } = await res.json();
    return {
      n: String(number),
      row: () => server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', id),
      published: async () => (await human('GET', `/api/repos/${fullName}/issues/${number}/timeline`)).filter((e: any) => e.event === 'published').map((e: any) => e.source),
      page: async () => (await fetch(`${server.url}/${fullName}/pull/${number}`)).text(),
      view: async () => JSON.parse((await cli(['pr', 'view', String(number), '--json', 'mergeable,mergeStateStatus,baseConflicts'], { cwd: path })).stdout),
      json: () => human('GET', `${api}/${number}`),
      wait: () => cli(['pr', 'wait', String(number), '--timeout', '20s'], { cwd: path }),
    };
  };
  const pr = await stage('shared', 'main', 'export const a = 1;\n');

  await t.test('a head that merges cleanly says so', async () => {
    await until(async () => (await pr.view()).mergeable === 'MERGEABLE', 'the head merges cleanly into main');
    assert.deepEqual(await pr.view(), { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN', baseConflicts: { ref: 'origin/main', oid: g('rev-parse', 'main'), conflicting: false, files: [], messages: [], behindBy: 0 } });
    assert.match(await pr.page(), new RegExp(`<strong>This branch has no conflicts with <span class="branch-name branch-name-sm">origin/main</span></strong><div class="color-fg-muted">Checked against <code>${g('rev-parse', '--short=7', 'main')}</code>`));
    const first = await pr.wait();
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^No reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
    assert.doesNotMatch(first.stdout, /This branch conflicts/);
  });

  await t.test('the base moves while the author waits: the wait says the head conflicts', async () => {
    const waiting = pr.wait();
    await until(async () => (await pr.json()).author_waiting, 'the author waits');
    // Another pull request is merged, and fetched: main changes the same line.
    g('checkout', '-q', 'main');
    writeFileSync(join(path, 'a.js'), 'export const a = 2;\n');
    g('commit', '-qam', 'Set a to 2');
    g('update-ref', 'refs/remotes/origin/main', 'main');
    const told = await waiting;
    assert.equal(told.code, 0, told.stderr);
    assert.match(told.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    assert.match(told.stdout, /Rebase onto origin\/main, resolve the conflicts and run the tests, then run `galley pr wait s\d+` again\./);
    assert.deepEqual(await pr.view(), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseConflicts: { ref: 'origin/main', oid: g('rev-parse', 'main'), conflicting: true, files: ['a.js'], messages: [], behindBy: 1 } });
    assert.match((await cli(['pr', 'view', pr.n], { cwd: path })).stdout, /^conflicts:\twith origin\/main in a\.js; rebase onto origin\/main\.$/m);
  });

  await t.test('the reviewer sees the conflict, and that the author is rebasing', async () => {
    const { turn } = await pr.json();
    assert.equal(turn.whose, 'author');
    assert.equal(turn.reasons[0].text, 'agent is working on the feedback');
    assert.equal(turn.reasons.find((r: any) => r.kind === 'conflicts').text, 'conflicts with origin/main in a.js');
    const list = await (await fetch(`${server.url}/${fullName}`)).text();
    assert.match(list, /<span class="turn-reason"><svg class="octicon octicon-alert[^>]*>.*?<\/svg>conflicts with origin\/main in a\.js<\/span>/);
    const box = await pr.page();
    assert.match(box, /<strong>This branch has conflicts with <span class="branch-name branch-name-sm">origin\/main<\/span><\/strong>/);
    assert.match(box, /conflicts in 1 file\. agent was told to rebase it\./);
    assert.match(box, new RegExp(`<a href="/${fullName}/pull/${pr.n}/files#diff-[0-9a-f]+"><code>a\\.js</code></a>`));
    // Said once per commit: the author waiting again without a rebase is not told again.
    const again = await fetch(`${server.url}${api}/${pr.n}/wait?timeout=1`, { headers: agent });
    assert.equal((await again.json()).status, 'timeout');
  });

  await t.test('a head that conflicts when staged: the first wait says so, before the reviewer agents are done', async () => {
    // Until it is known, the wait does not say the reviewer agents are done.
    const release = hold();
    let late: Awaited<ReturnType<typeof stage>>;
    try {
      late = await stage('late', 'main~1', 'export const a = 3;\n');
      const early = await fetch(`${server.url}${api}/${late.n}/wait?timeout=1`, { headers: agent });
      assert.equal((await early.json()).status, 'timeout');
    } finally {
      release();
    }
    const first = await late.wait();
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    assert.doesNotMatch(first.stdout, /ask the user/);
    // The author waits again without rebasing: the reviewer is asked, and still hears of the conflict.
    const second = await late.wait();
    assert.match(second.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.\nNo reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
    await human('PATCH', `${api}/${late.n}`, { state: 'closed' });
  });

  await t.test('auto-publish waits for the rebase', async () => {
    await human('PUT', `${api}/${pr.n}/auto-publish`, {});
    const publishing = pr.wait();
    await until(async () => (await pr.json()).author_waiting, 'the author waits');
    assert.equal(server.service.autoPublishReady(pr.row()), false);
    assert.match(await pr.page(), /Conflicts with origin\/main: nothing is published until agent rebases it/);
    // The agent rebases onto main, resolving the conflict.
    g('checkout', '-q', 'shared');
    g('reset', '-q', '--hard', 'main');
    writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
    g('commit', '-qam', 'Set a to 1');
    const published = await publishing;
    assert.equal(published.code, 0, published.stderr);
    assert.match(published.stdout, /^Published to GitHub: /m);
    assert.doesNotMatch(published.stdout, /This branch conflicts/);
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr create --repo acme\/conflicts --base main --head shared /m);
    // Only the rebased head was published.
    assert.deepEqual(await pr.published(), [g('rev-parse', 'shared')]);
  });

  await t.test('auto-publish goes by the answer for the base as it is now, not as it was', async () => {
    const moving = await stage('moving', 'main', 'export const a = 4;\n');
    await until(async () => (await moving.view()).mergeable === 'MERGEABLE', 'the head merges cleanly into main');
    const release = hold();
    let waiting: ReturnType<typeof moving.wait> | undefined;
    try {
      // main moves on to a commit that conflicts, and galley sees it while it works out the merge.
      g('checkout', '-q', 'main');
      writeFileSync(join(path, 'a.js'), 'export const a = 5;\n');
      g('commit', '-qam', 'Set a to 5');
      g('update-ref', 'refs/remotes/origin/main', 'main');
      await server.service.sync(moving.row());
      await human('PUT', `${api}/${moving.n}/auto-publish`, {});
      waiting = moving.wait();
      await until(async () => (await moving.json()).author_waiting, 'the author waits');
      // All else is ready, but the answer for the old base does not count.
      assert.equal(server.service.readiness(moving.row()).agentsDone, true);
      assert.equal(server.service.autoPublishReady(moving.row()), false);
      const box = await moving.page();
      assert.match(box, /This branch has no conflicts with .*origin\/main has moved since; checking again\./);
      assert.match(box, /Checking for conflicts with main/);
    } finally {
      release();
    }
    const told = await waiting!;
    assert.match(told.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    assert.deepEqual(await moving.published(), []);
    await human('PATCH', `${api}/${moving.n}`, { state: 'closed' });
  });

  await t.test('a check git could not do holds up auto-publish, says why, and is tried again', async () => {
    const retried = await stage('retried', 'main', 'export const a = 5;\nexport const b = 1;\n');
    await until(async () => (await retried.view()).mergeable === 'MERGEABLE', 'the head merges cleanly into main');
    // A setting git merge-tree can not use makes it fail; nothing else reads it.
    g('config', 'merge.conflictStyle', 'bogus');
    try {
      await human('PUT', `${api}/${retried.n}/auto-publish`, {});
      writeFileSync(join(path, 'b.js'), 'export const b = 2;\n');
      g('add', 'b.js');
      g('commit', '-qm', 'Add b');
      const publishing = retried.wait();
      await until(async () => /Could not check for conflicts with/.test(await retried.page()), 'the failed check is shown');
      await until(async () => (await retried.json()).author_waiting, 'the author waits');
      assert.equal(server.service.readiness(retried.row()).agentsDone, true);
      assert.equal(server.service.autoPublishReady(retried.row()), false);
      const box = await retried.page();
      assert.match(box, /<pre class="merge-error">git merge-tree failed: error: unknown style /);
      assert.match(box, /Could not check for conflicts with origin\/main: git merge-tree failed: error: unknown style /);
      assert.deepEqual(await retried.published(), []);
      // Fixed, the next poll tries again, finds nothing in the way, and auto-publish publishes.
      g('config', '--unset', 'merge.conflictStyle');
      const published = await publishing;
      assert.match(published.stdout, /^Published to GitHub: /m);
      assert.deepEqual(await retried.published(), [g('rev-parse', 'retried')]);
    } finally {
      // Unset already, unless an assertion failed first.
      try {
        g('config', '--unset', 'merge.conflictStyle');
      } catch {}
    }
  });

  await t.test('a push that conflicts wakes the waiting author, with nothing else asking about the new head', async () => {
    // From before main set a to 5, with a file of its own: it merges cleanly.
    const pushed = await stage('pushed', 'main~1', 'export const c = 1;\n', 'c.js');
    const first = await pushed.wait();
    assert.match(first.stdout, /^No reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
    // No reviewer agent and no auto-publish: only the push can bring news of the new head, and
    // the author does not wake for its own push.
    const waiting = cli(['pr', 'wait', pushed.n, '--timeout', '10s'], { cwd: path });
    await until(async () => (await pushed.json()).author_waiting, 'the author waits');
    writeFileSync(join(path, 'a.js'), 'export const a = 7;\n');
    g('commit', '-qam', 'Set a to 7');
    const told = await waiting;
    assert.equal(told.code, 0, told.stderr);
    assert.match(told.stdout, /^This branch conflicts with origin\/main in a\.js; rebase onto origin\/main\.$/m);
    await human('PATCH', `${api}/${pushed.n}`, { state: 'closed' });
  });

  await t.test('a conflict told along with an approval is the author\'s to rebase, and its turn', async () => {
    const approved = await stage('approved', 'main', 'export const d = 1;\n', 'd.js');
    const first = await approved.wait();
    assert.match(first.stdout, /^No reviewer agent reviews [0-9a-f]{7}; ask the user to review it: /m);
    // The reviewer approves, and main adds a d.js of its own before the author waits again.
    await human('POST', `${api}/${approved.n}/reviews`, { event: 'APPROVE' });
    g('checkout', '-q', 'main');
    writeFileSync(join(path, 'd.js'), 'export const d = 2;\n');
    g('add', 'd.js');
    g('commit', '-qm', 'Add d');
    g('update-ref', 'refs/remotes/origin/main', 'main');
    await until(async () => (await approved.view()).mergeable === 'CONFLICTING', 'it conflicts with main');
    const waited = approved.row().author_waited_at;
    const told = await approved.wait();
    assert.equal(told.code, 0, told.stderr);
    assert.match(told.stdout, /^reviewer reviewed: approved /m);
    assert.match(told.stdout, /^This branch conflicts with origin\/main in d\.js; rebase onto origin\/main\.$/m);
    assert.match(told.stdout, /^Rebase onto origin\/main, resolve the conflicts and run the tests, then run `galley pr wait s\d+` again\.$/m);
    assert.doesNotMatch(told.stdout, /nothing left open/);
    // The wait that hands it the conflict is not an action on it: it is the author's turn until it acts.
    assert.equal(approved.row().author_waited_at, waited);
    const { turn } = await approved.json();
    assert.equal(turn.whose, 'author');
    assert.equal(turn.reasons[0].text, 'agent is working on the feedback');
    await human('PATCH', `${api}/${approved.n}`, { state: 'closed' });
  });

  await t.test('a conflict in no file, such as a directory renamed two ways, is a conflict all the same', async () => {
    g('checkout', '-q', 'main');
    mkdirSync(join(path, 'old'));
    writeFileSync(join(path, 'old', 'a.js'), 'export {};\n');
    writeFileSync(join(path, 'old', 'b.js'), 'export {};\n');
    g('add', 'old');
    g('commit', '-qm', 'Add old');
    g('update-ref', 'refs/remotes/origin/main', 'main');
    // The branch moves old/a.js to left/ and old/b.js to right/: no one place old/ went.
    g('checkout', '-q', '-b', 'split');
    mkdirSync(join(path, 'left'));
    mkdirSync(join(path, 'right'));
    g('mv', 'old/a.js', 'left/a.js');
    g('mv', 'old/b.js', 'right/b.js');
    g('commit', '-qm', 'Split old');
    const res = await fetch(server.url + api, { method: 'POST', headers: agent, body: JSON.stringify({ title: 'Split old', head: 'split', base: 'main', automatic_reviews: false }) });
    const { number } = await res.json();
    const n = String(number);
    const view = async () => JSON.parse((await cli(['pr', 'view', n, '--json', 'mergeable,mergeStateStatus,baseConflicts'], { cwd: path })).stdout);
    await until(async () => (await view()).mergeable === 'MERGEABLE', 'the split merges cleanly at first');
    // main adds a file to old/, which git can not tell where to put.
    g('checkout', '-q', 'main');
    writeFileSync(join(path, 'old', 'new.js'), 'export {};\n');
    g('add', 'old');
    g('commit', '-qm', 'Add old/new.js');
    g('update-ref', 'refs/remotes/origin/main', 'main');
    await until(async () => (await view()).mergeable === 'CONFLICTING', 'the split conflicts with main');
    const said = 'CONFLICT (directory rename split): Unclear where to rename old to; it was renamed to multiple other directories, with no destination getting a majority of the files.';
    assert.deepEqual(await view(), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseConflicts: { ref: 'origin/main', oid: g('rev-parse', 'main'), conflicting: true, files: [], messages: [said], behindBy: 1 } });
    const told = await cli(['pr', 'wait', n, '--timeout', '10s'], { cwd: path });
    assert.equal(told.code, 0, told.stderr);
    assert.ok(told.stdout.includes(`This branch conflicts with origin/main; rebase onto origin/main. git says: ${said}\n`), told.stdout);
    const box = await (await fetch(`${server.url}/${fullName}/pull/${n}`)).text();
    assert.match(box, /<strong>This branch has conflicts with <span class="branch-name branch-name-sm">origin\/main<\/span><\/strong>\s*<div class="color-fg-muted">Merging it into <code>[0-9a-f]{7}<\/code>, its tip in this repository, conflicts\. /);
    assert.ok(box.includes(`<span>${said}</span>`), 'git says why in the merge box');
    const { turn } = await human('GET', `${api}/${n}`);
    assert.equal(turn.reasons.find((r: any) => r.kind === 'conflicts').text, 'conflicts with origin/main');
    // Auto-publish does not take it for clean.
    await human('PUT', `${api}/${n}/auto-publish`, {});
    assert.equal(server.service.autoPublishReady(server.service.db.get<any>('SELECT * FROM pulls WHERE id = ?', (await human('GET', `${api}/${n}`)).id)), false);
    await human('PATCH', `${api}/${n}`, { state: 'closed' });
  });
});

/** Run git in `cwd` as a developer, without signing. */
function gitIn(cwd: string) {
  return (...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { encoding: 'utf8' }).trim();
}

/** Another clone of `bare`, where other pull requests are merged: `merge` commits a file on a branch there (main) and pushes it. */
function otherClone(bare: string, name: string) {
  const path = join(dir, name);
  execFileSync('git', ['clone', '-q', '-b', 'main', bare, path]);
  const g = gitIn(path);
  return (file: string, text: string, branch = 'main'): string => {
    g('checkout', '-q', branch);
    writeFileSync(join(path, file), text);
    g('add', file);
    g('commit', '-qm', `Set ${file}`);
    g('push', '-q', 'origin', branch);
    return g('rev-parse', 'HEAD');
  };
}

test('the base branch is fetched when a page opens, at most once a minute per repository, and right before publishing', async (t) => {
  const { fullName, api, path, g } = await scratchRepo('fetched');
  // Fetches reach the bare repository too, as pushes do. Set after registering the repository:
  // `git remote get-url` would then give the bare repository's path, not GitHub's URL.
  g('config', `url.${join(dir, 'fetched.git')}.insteadOf`, 'https://github.com/acme/fetched.git');
  const merge = otherClone(join(dir, 'fetched.git'), 'fetched-other');
  const tracking = () => g('rev-parse', 'refs/remotes/origin/main');
  const stage = async (branch: string, file: string, text: string) => {
    g('checkout', '-q', '-b', branch, 'main');
    writeFileSync(join(path, file), text);
    g('add', file);
    g('commit', '-qm', `Set ${file} in ${branch}`);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Set ${file}`, head: branch, base: 'main', automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    const { number } = await res.json();
    // Through the API: the CLI would register the repository again, with the bare repository's path for a URL.
    const view = () => human('GET', `/api/repos/${fullName}/gh/pulls/${number}?fields=mergeable,mergeStateStatus,baseConflicts`);
    await until(async () => (await view()).mergeable === 'MERGEABLE', `${branch} merges cleanly into main`);
    return { n: number as number, view, page: async () => (await fetch(`${server.url}/${fullName}/pull/${number}`)).text(), json: () => human('GET', `${api}/${number}`) };
  };
  const mine = await stage('mine', 'a.js', 'export const a = 1;\n');
  const theirs = await stage('theirs', 'c.js', 'export const c = 1;\n');
  const main = g('rev-parse', 'main');
  let merged = '';

  await t.test('opening a pull request fetches its base, and the merge box says how far behind it is', async () => {
    merged = merge('b.js', 'export const b = 1;\n');
    assert.equal(tracking(), main);
    await mine.page();
    await until(() => tracking() === merged, 'origin/main is fetched');
    await until(async () => (await mine.view()).mergeStateStatus === 'BEHIND', 'the head is behind the new base');
    assert.deepEqual(await mine.view(), {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      baseConflicts: { ref: 'origin/main', oid: merged, conflicting: false, files: [], messages: [], behindBy: 1 },
    });
    const json = await mine.json();
    assert.deepEqual([json.mergeable, json.mergeable_state], [true, 'behind']);
    // For information only: nobody is asked to rebase it.
    assert.equal(json.turn.reasons.find((r: any) => r.kind === 'conflicts'), undefined);
    const box = await mine.page();
    assert.match(box, /<strong>1 commit behind <span class="branch-name branch-name-sm">origin\/main<\/span>, no conflicts<\/strong>/);
    // A fetch that worked says nothing: its time would be out of date by the next one.
    assert.match(box, new RegExp(`Checked against <code>${merged.slice(0, 7)}</code>, its tip in this repository\\.</div>`));
    assert.doesNotMatch(box, /data-confirm/);
    // Only origin/main moved: not the local main, nor FETCH_HEAD.
    assert.equal(g('rev-parse', 'main'), main);
    assert.equal(existsSync(join(path, '.git', 'FETCH_HEAD')), false);
  });

  await t.test('pages opened again, of any pull request in the repository, wait a minute to fetch', async () => {
    merge('a.js', 'export const a = 2;\n');
    for (const pr of [mine, theirs, mine]) await pr.page();
    // The poll would have seen a fetch by now.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(tracking(), merged);
    assert.equal((await mine.view()).mergeable, 'MERGEABLE');
  });

  await t.test('publishing fetches first, and a head that conflicts takes a second click', async () => {
    const expected = (await mine.page()).match(/name="expected" value="([^"]+)"/)![1];
    const refused = await fetch(`${server.url}${api}/${mine.n}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected, sign: false }) });
    assert.equal(refused.status, 428);
    assert.deepEqual(await refused.json(), {
      message: 'This branch conflicts with origin/main in a.js: GitHub can not merge it until the conflicts are resolved.',
      status: '428',
      acknowledge: ['during_conflict'],
    });
    assert.notEqual(tracking(), merged);
    const box = await mine.page();
    assert.match(box, /class="btn btn-primary btn-publish" data-confirm="Click again to publish anyway" data-acknowledge="during_conflict"/);
    assert.match(box, /GitHub can not merge it until the conflicts are resolved, so publishing takes a second click\./);
    const url = `${server.url}/${fullName}/pull/${mine.n}`;
    const asked = await cli(['pr', 'publish', url, '--no-sign'], { actor: 'reviewer' });
    assert.equal(asked.code, 1);
    assert.match(asked.stderr, new RegExp(`in a\\.js: GitHub can not merge it until the conflicts are resolved\\.\\nRun \`galley pr publish s${mine.n} --during-conflict\` to publish anyway\\.`));
    const published = await cli(['pr', 'publish', url, '--no-sign', '--during-conflict'], { actor: 'reviewer' });
    assert.equal(published.code, 0, published.stderr);
    assert.match(readFileSync(join(dir, 'gh.log'), 'utf8'), /^pr create --repo acme\/fetched --base main --head mine /m);
    assert.equal((await mine.json()).staging_state, 'published');
    await human('PATCH', `${api}/${theirs.n}`, { state: 'closed' });
  });
});

test('publishing fetches its base also while a fetch of the other base branches runs', async (t) => {
  const { fullName, api, path, g } = await scratchRepo('releases');
  g('push', '-q', 'origin', 'main:release');
  g('update-ref', 'refs/remotes/origin/release', 'main');
  // Fetches reach the bare repository, as in the test above.
  g('config', `url.${join(dir, 'releases.git')}.insteadOf`, 'https://github.com/acme/releases.git');
  const merge = otherClone(join(dir, 'releases.git'), 'releases-other');
  const stage = async (branch: string, base: string, file: string) => {
    g('checkout', '-q', '-b', branch, `origin/${base}`);
    writeFileSync(join(path, file), `export const ${branch.replace('-', '_')} = 1;\n`);
    g('add', file);
    g('commit', '-qm', `Set ${file}`);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Set ${file}`, head: branch, base, automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).number as number;
  };
  // Fetching main is held up, as a slow network would, until released.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const fetchBranch = Repo.prototype.fetchBranch;
  t.mock.method(Repo.prototype, 'fetchBranch', async function (this: Repo, ...args: Parameters<Repo['fetchBranch']>) {
    if (args[1] === 'main') await held;
    return fetchBranch.apply(this, args);
  });
  try {
    const onMain = await stage('on-main', 'main', 'b.js');
    // Opening its page starts fetching main, the only base so far.
    await fetch(`${server.url}/${fullName}/pull/${onMain}`);
    // A pull request into release is staged, and release moves on GitHub to a commit it conflicts with.
    const onRelease = await stage('on-release', 'release', 'a.js');
    merge('a.js', 'export const a = 2;\n', 'release');
    const publishing = fetch(`${server.url}${api}/${onRelease}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sign: false }) });
    await new Promise((r) => setTimeout(r, 300));
    release();
    const refused = await publishing;
    assert.equal(refused.status, 428);
    assert.equal((await refused.json()).message, 'This branch conflicts with origin/release in a.js: GitHub can not merge it until the conflicts are resolved.');
  } finally {
    release();
  }
});

test('publishing fetches its own base alone, and a repository with nothing to fetch does not hold up the next fetch', async () => {
  const { fullName, api, path, g } = await scratchRepo('quiet');
  g('push', '-q', 'origin', 'main:release');
  g('update-ref', 'refs/remotes/origin/release', 'main');
  g('config', `url.${join(dir, 'quiet.git')}.insteadOf`, 'https://github.com/acme/quiet.git');
  const merge = otherClone(join(dir, 'quiet.git'), 'quiet-other');
  const tracking = (base: string) => g('rev-parse', `refs/remotes/origin/${base}`);
  const stage = async (branch: string, base: string, file: string) => {
    g('checkout', '-q', '-b', branch, `origin/${base}`);
    writeFileSync(join(path, file), 'export {};\n');
    g('add', file);
    g('commit', '-qm', `Add ${file}`);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Add ${file}`, head: branch, base, automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    const { number } = await res.json();
    return { n: number as number, page: () => fetch(`${server.url}/${fullName}/pull/${number}`).then((r) => r.text()) };
  };
  const intoRelease = await stage('into-release', 'release', 'r.js');
  const published = await stage('published', 'main', 'p.js');
  // Publishing fetches main, its base, and not release: a slow GitHub costs it one fetch.
  const before = tracking('release');
  merge('r2.js', 'export {};\n', 'release');
  const mainNow = merge('m.js', 'export {};\n');
  assert.equal((await human('POST', `${api}/${published.n}/publish`, { sign: false })).staging_state, 'published');
  assert.equal(tracking('main'), mainNow);
  assert.equal(tracking('release'), before);
  // With no other pull request open, the published one's page has nothing to fetch, and fetches nothing.
  await human('PATCH', `${api}/${intoRelease.n}`, { state: 'closed' });
  await published.page();
  // So a pull request staged next is fetched when its page opens, not a minute later.
  const next = await stage('next', 'main', 'n.js');
  const merged = merge('m2.js', 'export {};\n');
  await next.page();
  await until(() => tracking('main') === merged, 'origin/main is fetched');
});

test('a page whose base is a local branch does not hold up fetching the bases staged after it', async () => {
  const { fullName, api, path, g } = await scratchRepo('stacked');
  g('config', `url.${join(dir, 'stacked.git')}.insteadOf`, 'https://github.com/acme/stacked.git');
  const merge = otherClone(join(dir, 'stacked.git'), 'stacked-other');
  const stage = async (branch: string, base: string, from: string) => {
    g('checkout', '-q', '-b', branch, from);
    writeFileSync(join(path, `${branch}.js`), 'export {};\n');
    g('add', `${branch}.js`);
    g('commit', '-qm', `Add ${branch}.js`);
    const res = await fetch(server.url + api, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
      body: JSON.stringify({ title: `Add ${branch}.js`, head: branch, base, automatic_reviews: false }),
    });
    assert.equal(res.status, 201);
    const { number } = await res.json();
    return () => fetch(`${server.url}/${fullName}/pull/${number}`).then((r) => r.text());
  };
  // Stacked on a branch that is not on GitHub: its base is the local branch, which is not fetched.
  g('branch', 'stack', 'main');
  await (await stage('on-stack', 'stack', 'stack'))();
  const onMain = await stage('on-main', 'main', 'origin/main');
  const merged = merge('m.js', 'export {};\n');
  await onMain();
  await until(() => g('rev-parse', 'refs/remotes/origin/main') === merged, 'origin/main is fetched');
});

test('a fetch that fails shows in the merge box, is logged once, and does not hold up publishing', async (t) => {
  const { fullName, api, path, g } = await scratchRepo('unfetched');
  g('checkout', '-q', '-b', 'mine');
  writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
  g('commit', '-qam', 'Set a');
  const res = await fetch(server.url + api, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
    body: JSON.stringify({ title: 'Set a', head: 'mine', base: 'main', automatic_reviews: false }),
  });
  const { number } = await res.json();
  const errors = t.mock.method(console, 'error');
  const logged = () => errors.mock.calls.filter((c) => /^could not fetch origin\/main into .*\/unfetched\/\.git: /.test(String(c.arguments[0]))).map((c) => c.arguments[0]);
  const page = async () => (await fetch(`${server.url}/${fullName}/pull/${number}`)).text();
  // The remote is out of reach (see the git config at the top).
  await page();
  await until(async () => /Could not fetch origin\/main: /.test(await page()), 'the merge box says the fetch failed');
  assert.match(await page(), /<strong>This branch has no conflicts with <span class="branch-name branch-name-sm">origin\/main<\/span><\/strong><div class="color-fg-muted">Checked against <code>[0-9a-f]{7}<\/code>, its tip in this repository\. Could not fetch origin\/main: fatal: unable to access &#39;https:\/\/github\.com\/acme\/unfetched\.git\/&#39;: Failed to connect to 127\.0\.0\.1 port 1 [^<]*<\/div>/);
  const published = await human('POST', `${api}/${number}/publish`, { sign: false });
  assert.equal(published.staging_state, 'published');
  assert.equal(logged().length, 1);
  assert.ok(logged()[0].startsWith(`could not fetch origin/main into ${g('rev-parse', '--path-format=absolute', '--git-common-dir')}: fatal: unable to access 'https://github.com/acme/unfetched.git/': Failed to connect to 127.0.0.1 port 1 `), logged()[0]);
});

test('a remote with an ssh URL is fetched from GitHub over https with gh, and never over ssh', async () => {
  const bare = join(dir, 'sshremote.git');
  const path = join(dir, 'sshremote');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  const g = gitIn(path);
  writeFileSync(join(path, 'a.js'), 'export {};\n');
  g('add', 'a.js');
  g('commit', '-qm', 'Initial commit');
  g('push', '-q', bare, 'main');
  g('remote', 'add', 'origin', 'git@github.com:acme/sshremote.git');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  // ssh is a stand-in that says it ran: the agent behind the real one may ask for approval in a window.
  const sshLog = join(dir, 'ssh.log');
  const ssh = join(dir, 'ssh');
  writeFileSync(ssh, `#!/bin/sh\necho "$@" >> "${sshLog}"\nexit 255\n`);
  chmodSync(ssh, 0o755);
  g('config', 'core.sshCommand', ssh);
  // As some set up git: GitHub's https URLs turned into ssh ones.
  g('config', 'url.ssh://git@github.com/.insteadOf', 'https://github.com/');
  const { full_name: fullName } = await human('POST', '/api/repos', { path });
  assert.equal(fullName, 'acme/sshremote');
  g('checkout', '-q', '-b', 'mine');
  writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
  g('commit', '-qam', 'Set a');
  const res = await fetch(`${server.url}/api/repos/${fullName}/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-galley-actor': 'agent' },
    body: JSON.stringify({ title: 'Set a', head: 'mine', base: 'main', automatic_reviews: false }),
  });
  const { number } = await res.json();
  const page = async () => (await fetch(`${server.url}/${fullName}/pull/${number}`)).text();
  const merged = otherClone(bare, 'sshremote-other')('b.js', 'export const b = 1;\n');

  // Also when the server was started with ssh allowed, which git would put above its config.
  process.env.GIT_ALLOW_PROTOCOL = 'ssh';
  try {
    await page();
    await until(async () => /Could not fetch origin\/main: fatal: transport &#39;ssh&#39; not allowed/.test(await page()), 'the fetch over ssh is refused');
  } finally {
    delete process.env.GIT_ALLOW_PROTOCOL;
  }
  assert.equal(existsSync(sshLog), false, 'ssh never ran');

  // Over https, which reaches the bare repository here, it is fetched.
  g('config', '--unset', 'url.ssh://git@github.com/.insteadOf');
  g('config', `url.${bare}.insteadOf`, 'https://github.com/acme/sshremote.git');
  const every = server.service.fetchEveryMs;
  server.service.fetchEveryMs = 0;
  try {
    await page();
    await until(() => g('rev-parse', 'refs/remotes/origin/main') === merged, 'origin/main is fetched over https');
  } finally {
    server.service.fetchEveryMs = every;
  }
  await until(async () => /1 commit behind .*, no conflicts/.test(await page()), 'the merge box has the fetched base');
  assert.doesNotMatch(await page(), /Could not fetch/);
  assert.equal(existsSync(sshLog), false, 'ssh never ran');
});

test('the server fetches base branches on its timer, and a waiting author hears when its head conflicts with the new base', async () => {
  const bare = join(dir, 'timer.git');
  const path = join(dir, 'timer');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  const g = gitIn(path);
  writeFileSync(join(path, 'a.js'), 'export {};\n');
  g('add', 'a.js');
  g('commit', '-qm', 'Initial commit');
  g('push', '-q', bare, 'main');
  g('remote', 'add', 'origin', 'https://github.com/acme/timer.git');
  g('update-ref', 'refs/remotes/origin/main', 'main');
  const merge = otherClone(bare, 'timer-other');
  g('checkout', '-q', '-b', 'mine');
  writeFileSync(join(path, 'a.js'), 'export const a = 1;\n');
  g('commit', '-qam', 'Set a');
  const head = g('rev-parse', 'HEAD');
  const timed = await startServer({ port: 0, dataDir: join(dir, 'timer-data'), ghBin: 'false', reviewersDir: join(dir, 'timer-data', 'reviewers'), viewerLogin: 'reviewer', pollMs: 50, followMs: 50, fetchMs: 100 });
  try {
    const agent = { 'content-type': 'application/json', 'x-galley-actor': 'agent' };
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(timed.url + p, { method, headers: agent, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      assert.ok(res.ok, `${method} ${p} -> ${res.status} ${text}`);
      return text ? JSON.parse(text) : null;
    };
    const { full_name } = await call('POST', '/api/repos', { path });
    // Fetches from GitHub reach the bare repository. Set after registering, since `git remote get-url` would give its path.
    g('config', `url.${bare}.insteadOf`, 'https://github.com/acme/timer.git');
    const { number } = await call('POST', `/api/repos/${full_name}/pulls`, { title: 'Set a', head: 'mine', base: 'main', automatic_reviews: false });
    const base = `/api/repos/${full_name}/pulls/${number}`;
    // The first wait hands the head to the reviewer; the author says so and waits again.
    const first = await call('GET', `${base}/wait?timeout=10`);
    assert.equal(first.status, 'agents_done');
    await call('PUT', `${base}/seen`, { at: first.seen_at, agents_done: first.agents_done.sha });
    const waiting = call('GET', `${base}/wait?timeout=10`);
    // Another pull request sets a too, and is merged on the remote. Nobody opens a page.
    const merged = merge('a.js', 'export const a = 2;\n');
    const told = await waiting;
    assert.equal(told.status, 'conflicts');
    assert.equal(told.conflicts, head);
    assert.deepEqual(told.pr.baseConflicts, { ref: 'origin/main', oid: merged, conflicting: true, files: ['a.js'], messages: [], behindBy: 1 });
  } finally {
    await timed.close();
  }
});
