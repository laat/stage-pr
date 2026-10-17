// Custom reviewers: definition files, and reviewers of the description and of the code that
// review only their repositories, may approve, and are one bot each.
import { gitconfig } from './helpers/env.ts';
import { withFakes } from './helpers/fakes.ts';
import { until } from './helpers/until.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/server.ts';
import { checkDefinition, formatDefinition, parseDefinition, reviewsRepo } from '../src/server/reviewers/definition.ts';
import type { PullRow, ReviewRow } from '../src/server/db.ts';

// ------------------------------------------------------------------ the file

const EXAMPLE = `---
# NRK's house rules for pull requests
engine: claude            # or codex
model: sonnet
effort: low
repos:
  - nrkno/*
  - "laat/galley"
reviews: description
verdict: approve
max_iterations: 2
---
Check the title and description against these rules: …
`;

test('a definition file is read from its front matter and body, and written back the same', () => {
  const d = parseDefinition('nrk-house-rules', EXAMPLE);
  assert.deepEqual(d, {
    name: 'nrk-house-rules',
    engine: 'claude',
    model: 'sonnet',
    effort: 'low',
    repos: ['nrkno/*', 'laat/galley'],
    reviews: 'description',
    verdict: 'approve',
    max_iterations: 2,
    run_tests: true,
    enabled: true,
    instructions: 'Check the title and description against these rules: …',
  });
  assert.deepEqual(parseDefinition('nrk-house-rules', formatDefinition(d)), d);
  // A glob that starts with * is quoted, as YAML would read it as an alias.
  const all = checkDefinition('all', { engine: 'codex', repos: ['*/*'], reviews: 'code' });
  assert.match(formatDefinition(all), /^repos: \["\*\/\*"\]$/m);
  assert.deepEqual(parseDefinition('all', formatDefinition(all)), all);
  // Lists in line, and from a form one text a line or comma apart; none is every repository.
  assert.deepEqual(parseDefinition('x', '---\nengine: codex\nrepos: [a/b, "c/*"] # two\n---\n').repos, ['a/b', 'c/*']);
  assert.deepEqual(checkDefinition('x', { engine: 'codex', repos: 'a/b\nc/d, e/*' }).repos, ['a/b', 'c/d', 'e/*']);
  assert.equal(checkDefinition('x', { engine: 'codex', repos: '' }).repos, null);
  // The name in the file, when given, is its file's.
  assert.equal(parseDefinition('x', '---\nname: x\nengine: codex\n---\n').name, 'x');
});

test('a definition that is wrong says what and where', () => {
  const fails = (name: string, text: string, why: RegExp) => assert.throws(() => parseDefinition(name, text), why);
  fails('x', 'engine: codex\n', /must start with front matter/);
  fails('x', '---\nengine: codex\n', /no closing ---/);
  fails('x', '---\nengine: codex\nthis is not yaml\n---\n', /line 3: expected "key: value"/);
  fails('x', '---\nengine: gemini\n---\n', /engine must be codex or claude/);
  fails('x', '---\nreviews: code\n---\n', /engine is required/);
  fails('x', '---\nengine: codex\nprompt: hi\n---\n', /unknown setting "prompt"/);
  fails('x', '---\nengine: codex\nrepos: [nrkno]\n---\n', /"nrkno" is not a repository on GitHub/);
  fails('x', '---\nengine: codex\nreviews: description\n---\n', /needs instructions/);
  fails('x', '---\nengine: codex\nverdict: request_changes\n---\n', /verdict must be comment or approve/);
  fails('x', '---\nengine: codex\nmax_iterations: 99\n---\n', /from 0 to 20/);
  fails('x', '---\nname: y\nengine: codex\n---\n', /"y" is not the file's name, "x"/);
  fails('claude', '---\nengine: codex\n---\n', /what the CLI calls author agents/);
  fails('no spaces', '---\nengine: codex\n---\n', /not a valid name/);
});

test('repositories are matched by their GitHub slug, in any case; one without a GitHub remote only by a reviewer of every repository', () => {
  assert.equal(reviewsRepo(null, 'acme/widgets'), true);
  assert.equal(reviewsRepo(null, null), true);
  assert.equal(reviewsRepo(['nrkno/*'], 'NRKNO/plattform-docs'), true);
  assert.equal(reviewsRepo(['nrkno/*'], 'acme/nrkno'), false);
  assert.equal(reviewsRepo(['*/widget?'], 'acme/widgets'), true);
  assert.equal(reviewsRepo(['acme/w.dgets'], 'acme/widgets'), false, 'a dot is a dot');
  assert.equal(reviewsRepo(['nrkno/*'], null), false);
});

// ------------------------------------------------------------- the reviewers

let dir: string;
let reviewersDir: string;
let server: Awaited<ReturnType<typeof startServer>>;
/** How the server is started: again on the same data, or for a server of its own. */
let options: Parameters<typeof startServer>[0];
const BIN = join(import.meta.dirname, '..', 'bin', 'galley.ts');

appendFileSync(gitconfig, '[user]\n\tname = Reviewer\n\temail = reviewer@example.com\n');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
}

/** A repository with a commit on main and a branch with one more, fetched from `remote` (none: no remote). */
function makeRepo(name: string, remote: string | null): string {
  const repo = join(dir, name);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  if (remote) git(repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(repo, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Initial commit');
  if (remote) git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, 'checkout', '-qb', 'feature/mul');
  writeFileSync(join(repo, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n\nexport const mul = (a, b) => a * b;\n');
  git(repo, 'commit', '-qam', 'Add mul', '-m', 'Multiplication, for the widgets.');
  return repo;
}

async function cli(cwd: string, args: string[], opts: { actor?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = execFile(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, GALLEY_URL: server.url, GALLEY_ACTOR: opts.actor ?? 'agent', NO_COLOR: '1' } });
  child.stdin!.end();
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (d) => (stdout += d));
  child.stderr!.on('data', (d) => (stderr += d));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  return { stdout, stderr, code };
}

/** A request from the web UI, as the human. Fails unless it answers `status` (by default, any success). */
async function human(method: string, path: string, body?: unknown, status?: number): Promise<any> {
  const res = await fetch(server.url + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (status !== undefined) assert.equal(res.status, status, text);
  else assert.ok(res.ok, `${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const page = async (path: string) => (await fetch(server.url + path)).text();
const calls = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const reviewer = (name: string) => server.service.custom!.list().find((r) => r.key === name)!;
const row = (owner: string, number: number) => {
  const repo = server.service.repo(owner, owner === 'acme' ? 'widgets' : owner === 'other' ? 'thing' : 'solo');
  return server.service.db.get<PullRow>('SELECT * FROM pulls WHERE repo_id = ? AND number = ?', repo.id, number)!;
};

let acme: string;
let other: string;
let solo: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'galley-custom-'));
  reviewersDir = join(dir, 'config', 'reviewers');
  acme = makeRepo('widgets', 'https://github.com/acme/widgets.git');
  other = makeRepo('thing', 'https://github.com/other/thing.git');
  solo = makeRepo('solo', null);

  // Claude Code headless: it says what it was run with and in, and answers FAKE_CLAUDE_REVIEW
  // once the file FAKE_CLAUDE_GATE exists (at once without one), as the result of stream-json.
  const claude = join(dir, 'claude');
  process.env.FAKE_CLAUDE_LOG = join(dir, 'claude.log');
  writeFileSync(
    claude,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), files: fs.readdirSync('.') }) + '\\n');
const answer = () => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 900, output_tokens: 80 }, structured_output: JSON.parse(process.env.FAKE_CLAUDE_REVIEW) }));
const gate = process.env.FAKE_CLAUDE_GATE;
if (gate) { const t = setInterval(() => fs.existsSync(gate) && (clearInterval(t), answer()), 20); } else answer();
`,
  );
  chmodSync(claude, 0o755);
  // Codex: no models, and \`exec\` answering FAKE_CODEX_REVIEW (once the file FAKE_CODEX_GATE exists,
  // when there is one), saying what it ran with, in, and the schema it was given.
  const codex = join(dir, 'codex');
  process.env.FAKE_CODEX_LOG = join(dir, 'codex.log');
  writeFileSync(
    codex,
    `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'debug') { console.log('[]'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt, schema, cwd: process.cwd(), files: fs.readdirSync('.') }) + '\\n');
const answer = () => fs.writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_CODEX_REVIEW);
const gate = process.env.FAKE_CODEX_GATE;
if (gate) { const t = setInterval(() => fs.existsSync(gate) && (clearInterval(t), answer()), 20); } else answer();
`,
  );
  chmodSync(codex, 0o755);

  // Written by hand before the server starts: one for acme's repositories, one with the Codex
  // reviewer's name, and one that can not be read.
  mkdirSync(reviewersDir, { recursive: true });
  writeFileSync(
    join(reviewersDir, 'house-rules.md'),
    `---\n# The rules for acme\nengine: claude\nmodel: haiku\neffort: low\nrepos: [acme/*]\nreviews: description\nverdict: approve\nmax_iterations: 3\n---\nThe title is in the imperative. The description says why.\n`,
  );
  writeFileSync(join(reviewersDir, 'codex-review.md'), '---\nengine: claude\n---\n');
  writeFileSync(join(reviewersDir, 'broken.md'), '---\nengine: claude\nrepos: [acme/*\n---\n');
  options = { port: 0, dataDir: join(dir, 'data'), ghBin: 'false', codexBin: codex, claudeBin: claude, viewerLogin: 'reviewer', pollMs: 50, reviewersDir };
  server = await startServer(options);
});

after(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Stage the branch in a repository, and give its number. */
async function stage(cwd: string, args: string[] = []): Promise<{ number: number; stderr: string }> {
  const r = await cli(cwd, ['pr', 'create', '--title', 'Add mul', '--body', 'The widgets multiply.', ...args]);
  assert.equal(r.code, 0, r.stderr);
  return { number: Number(r.stdout.trim().split('/').pop()), stderr: r.stderr };
}

/** The author waits once, and gets what came. */
async function wait(cwd: string, number: number): Promise<string> {
  const r = await cli(cwd, ['pr', 'wait', String(number), '--timeout', '20s']);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
}

const sha = (cwd: string) => git(cwd, 'rev-parse', 'HEAD');
/** What the merge box says each reviewer agent found in the last round, as text. */
const round = (path: string) => page(path).then((html) => (html.match(/<div class="iterations-found">([^]*?)<\/div>/)?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
const runStatus = (id: number) => server.service.db.get<{ status: string }>('SELECT status FROM review_runs WHERE id = ?', id)!.status;

test('definitions are read when the server starts; those that can not run say why', async () => {
  const list = await human('GET', '/api/settings/reviewers');
  assert.deepEqual(
    list.map((r: any) => [r.name, r.login, r.error]),
    [
      ['broken', null, 'line 3: a list in [ ] needs a , between items and ] at the end'],
      ['codex-review', null, '"codex-review" would ask for the Codex reviewer (--reviewer codex-review); choose another'],
      ['house-rules', 'house-rules', null],
    ],
  );
  assert.equal(list[2].path, join(reviewersDir, 'house-rules.md'));
  const html = await page('/settings/reviewers');
  assert.match(html, /<a href="\/settings\/reviewers\/house-rules"><strong>house-rules<\/strong><\/a>/);
  assert.match(html, /Claude · the title, description and commit messages · acme\/\* · approves when it finds nothing · up to 3 automatic reviews/);
  assert.match(html, /Not running: &quot;codex-review&quot; would ask for the Codex reviewer/);
  assert.match(await page('/settings/reviewers/house-rules'), /<textarea class="form-control" id="reviewer-instructions" name="instructions" rows="12">The title is in the imperative\. The description says why\.<\/textarea>/);
  // A new one: the models of the tool chosen, Claude's to begin with.
  const fresh = await page('/settings/new-reviewer');
  assert.match(fresh, /<button type="submit" class="btn btn-primary">Create reviewer<\/button>/);
  assert.match(fresh, /data-default-label="Claude default" data-engine="claude" selected>Claude default<\/option>/);
  assert.match(fresh, /data-engine="codex" hidden disabled/);
  assert.doesNotMatch(await page('/settings'), /house-rules/, 'Codex and Claude have the code review settings to themselves');
  // Its name is its own from the start.
  const r = await cli(acme, ['pr', 'list'], { actor: 'house-rules' });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /"house-rules" is the name of the house-rules reviewer/);
});

test('a reviewer of the description reads no code, and approves what follows its rules; the approval is its own', async () => {
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'Follows the rules.', verdict: 'approve', comments: [] });
  const { number, stderr } = await stage(acme);
  assert.match(stderr, /^When you wait, house-rules reviews the title, description and commit messages\.$/m);
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const out = await wait(acme, number);
  assert.match(out, /house-rules reviewed: approved/);
  assert.match(out, /Follows the rules\./);
  assert.doesNotMatch(out, /Approved with nothing left open/, 'not the reviewer\'s approval');
  // The only reviewer agent, done: nothing to address, and the next wait hands the commit over.
  assert.match(out, new RegExp(`^Nothing to address\\. Run \`galley pr wait s${number}\` again\\.$`, 'm'));
  assert.doesNotMatch(out, /Address the feedback/);

  // Claude Code in an empty directory, with no tools, the instructions, and what it reviews in the prompt.
  const call = calls(process.env.FAKE_CLAUDE_LOG!).at(-1);
  const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
  assert.deepEqual(call.files, []);
  assert.equal(flag('--tools'), '');
  assert.ok(!call.args.includes('--allowedTools'));
  assert.equal(flag('--model'), 'haiku');
  const schema = JSON.parse(flag('--json-schema'));
  assert.deepEqual(schema.required, ['summary', 'verdict', 'comments']);
  assert.deepEqual(schema.items?.required ?? schema.properties.comments.items.required, ['about', 'commit', 'priority', 'body']);
  assert.match(call.prompt, /The title is in the imperative\. The description says why\./);
  assert.match(call.prompt, /Title: Add mul\n\nDescription:\nThe widgets multiply\./);
  assert.match(call.prompt, new RegExp(`commit ${sha(acme)}\n    Add mul\n    \n    Multiplication, for the widgets\\.`));
  assert.match(call.prompt, /Answer with the verdict approve when nothing needs to change/);

  const review = (await human('GET', `${base}/reviews`)).at(-1);
  assert.equal(review.state, 'APPROVED');
  assert.equal(review.user.login, 'house-rules');
  assert.match(review.body, new RegExp(`<sub>house-rules \\(Claude, haiku, low effort\\) reviewed the title, description and commit messages at \`${sha(acme).slice(0, 7)}\`, automatic review 1 of 3\\.</sub>$`));
  // Done with the head, as one that found nothing is; the decision is still the reviewer's to make.
  const status = server.service.readiness(row('acme', number)).reviewers.find((r) => r.login === 'house-rules')!.status;
  assert.deepEqual([status.state, status.description], ['approved', true]);
  const view = await cli(acme, ['pr', 'view', String(number), '--json', 'reviewDecision,turn']);
  assert.equal(JSON.parse(view.stdout).reviewDecision, 'REVIEW_REQUIRED');
  assert.match(await wait(acme, number), new RegExp(`^The reviewer agents are done with ${sha(acme).slice(0, 7)} \\(house-rules approved the description\\); ask the user to review it`, 'm'));
  const turn = server.service.turn(row('acme', number));
  assert.ok(turn.reasons.some((r) => r.text === 'house-rules approved the description' && r.reviewer === 'house-rules'));
  assert.ok(!turn.reasons.some((r) => r.kind === 'approved'));

  // The page: its row in the sidebar, and its approval in the timeline as its own.
  const html = await page(`/acme/widgets/pull/${number}`);
  assert.match(html, /<a class="agent-name" href="\/settings\/reviewers\/house-rules" title="Claude · reviews the title, description and commit messages, and approves when it finds nothing">house-rules<\/a>/);
  assert.match(html, /title="Approved the description at [0-9a-f]{7}"><svg class="octicon octicon-check color-fg-success"[^>]*>[^]*?<\/svg><span>Approved · <code>[0-9a-f]{7}<\/code><\/span>/);
  assert.match(html, /house-rules<\/a><span class="Label Label--bot">bot<\/span> approved the description/);
  assert.match(html, /Ask house-rules to review/);
  // In the merge box's last round too, its approval reads as one.
  assert.equal(await round(`/acme/widgets/pull/${number}`), 'Last round: house-rules approved');
});

test('it reviews again when the title, description or commit messages change, not for a commit that leaves them as they are', async () => {
  const number = 1;
  const runs = async () => (await human('GET', `/api/repos/acme/widgets/pulls/${number}/reviewers/house-rules`)).runs;
  // The same message on a new commit: nothing new to read.
  writeFileSync(join(acme, 'math.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  git(acme, 'commit', '-qa', '--amend', '--no-edit');
  assert.match(await wait(acme, number), new RegExp(`^The reviewer agents are done with ${sha(acme).slice(0, 7)} \\(house-rules approved the description\\)`, 'm'));
  assert.equal((await runs()).length, 1);

  // A new title: it says what to change, a commit's message on the commit. Approving with comments is commenting.
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({
    summary: 'Two things.',
    verdict: 'approve',
    comments: [
      { about: 'title', commit: null, priority: 'medium', body: 'Say what it adds.' },
      { about: 'commit', commit: sha(acme).slice(0, 8), priority: null, body: '[P3] Say why.' },
      { about: 'commit', commit: 'deadbeef', priority: 'low', body: 'No such commit.' },
    ],
  });
  assert.equal((await cli(acme, ['pr', 'edit', String(number), '--title', 'Multiply'])).code, 0);
  let out = await wait(acme, number);
  assert.match(out, /house-rules reviewed: commented/);
  assert.match(out, new RegExp(`thread \\d+ on the message of commit ${sha(acme).slice(0, 7)} "Add mul"`));
  let review = (await human('GET', `/api/repos/acme/widgets/pulls/${number}/reviews`)).at(-1);
  assert.equal(review.state, 'COMMENTED');
  assert.match(review.body, /\*\*Comments on the title and description\*\*\n\n- Title \(medium priority\): Say what it adds\.\n- Commit `deadbee` \(low priority\): No such commit\./);
  const thread = (await human('GET', `/api/repos/acme/widgets/pulls/${number}/comments`)).at(-1);
  assert.deepEqual([thread.subject_type, thread.commit_id, thread.priority, thread.body], ['commit', sha(acme), 'low', 'Say why.']);
  assert.deepEqual((await runs()).map((r: any) => [r.status, r.findings]), [['done', 0], ['done', 3]]);
  // The merge box's last round counts them: the thread on the commit, and those in the body.
  assert.equal(await round(`/acme/widgets/pull/${number}`), 'Last round: house-rules 1 Medium 2 Low');
  assert.match(server.service.turn(row('acme', number)).reasons.map((r) => r.text).join('; '), /house-rules commented on the description/);
  // Only a new version answers it: with its findings seen and its thread replied to, auto-publish still waits for one.
  assert.equal((await cli(acme, ['pr', 'comment', String(number), '--reply-to', String(thread.id), '-b', 'The description says why.'])).code, 0);
  await human('PUT', `/api/repos/acme/widgets/pulls/${number}/auto-publish`, {});
  const held = await cli(acme, ['pr', 'wait', String(number), '--timeout', '2s']);
  assert.equal(held.code, 124);
  assert.match(held.stderr, /^house-rules commented on the description: edit the title or description, or reword the commits, as it asks; a reply does not answer it\. The reviewer agents are not done with it until then\.$/m);
  assert.ok((await human('GET', `/api/repos/acme/widgets/pulls/${number}`)).auto_publish, 'auto-publish is still on, and nothing was published');
  assert.match(await page(`/acme/widgets/pull/${number}`), /house-rules found problems in the description, and reviews it again once it changes/);
  assert.match(server.service.turn(row('acme', number)).reasons.map((r) => r.text).join('; '), /house-rules commented on the description/);

  // A reworded commit: a verdict that is not approve, with nothing to point at, is a finding; one it may not give is a comment.
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'The message does not say why.', verdict: 'request_changes', comments: [] });
  git(acme, 'commit', '-q', '--amend', '-m', 'Add mul', '-m', 'Widgets multiply now.');
  out = await wait(acme, number);
  assert.match(out, /The message does not say why\./);
  assert.match(out, /^Address the feedback\./m, 'with nothing to point at, its summary is the finding');
  await human('DELETE', `/api/repos/acme/widgets/pulls/${number}/auto-publish`);
  review = (await human('GET', `/api/repos/acme/widgets/pulls/${number}/reviews`)).at(-1);
  assert.equal(review.state, 'COMMENTED');
  assert.deepEqual((await runs()).map((r: any) => r.findings), [0, 3, 1]);
  // Its three automatic reviews are used up.
  assert.equal(server.service.readiness(row('acme', number)).reviewers.find((r) => r.login === 'house-rules')!.status.state, 'capped');
  // With one more to go, the merge box counts its summary for the finding.
  await human('PATCH', `/api/repos/acme/widgets/pulls/${number}/reviewers/house-rules`, { max_iterations: 4 });
  assert.equal(await round(`/acme/widgets/pull/${number}`), 'Last round: house-rules 1 unprioritized');
  await human('PATCH', `/api/repos/acme/widgets/pulls/${number}/reviewers/house-rules`, { max_iterations: null });
});

test('a review of the description is cancelled when the title or description is edited, not by a push that leaves the messages as they are', async () => {
  const number = 1;
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const gate = join(dir, 'gate');
  process.env.FAKE_CLAUDE_GATE = gate;
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'Fine.', verdict: 'approve', comments: [] });
  try {
    const { run_id } = await human('POST', `${base}/reviewers/house-rules`);
    writeFileSync(join(acme, 'math.js'), 'export const mul = (a, b) => a * b;\n');
    git(acme, 'commit', '-qa', '--amend', '--no-edit');
    await cli(acme, ['pr', 'view', String(number)]);
    assert.ok(reviewer('house-rules').isRunning(row('acme', number).id), 'a new commit with the same messages leaves it');
    await human('PATCH', base, { body: 'The widgets multiply, as asked in #12.' });
    const run = (await human('GET', `${base}/reviewers/house-rules`)).runs.find((r: any) => r.id === run_id);
    assert.deepEqual([run.status, run.reason], ['cancelled', 'edited']);
  } finally {
    writeFileSync(gate, '');
    await reviewer('house-rules').settle(row('acme', number).id);
    delete process.env.FAKE_CLAUDE_GATE;
  }
  assert.match(await page(`/acme/widgets/pull/${number}`), /<span class="agent-chunk">Title or description edited<\/span>/);
});

test('a review goes by the definition it started with, also when the definition changes before it is done', async () => {
  const number = 1;
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const gate = join(dir, 'gate-redefined');
  process.env.FAKE_CLAUDE_GATE = gate;
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'The title.', verdict: 'comment', comments: [{ about: 'title', commit: null, priority: 'low', body: 'Shorter.' }] });
  const before = reviewer('house-rules');
  try {
    await human('POST', `${base}/reviewers/house-rules`);
    // Made a reviewer of the code, with Codex, while it reads the description.
    await human('PATCH', '/api/settings/reviewers/house-rules', { reviews: 'code', engine: 'codex' });
    assert.equal(reviewer('house-rules').reviews, 'code');
  } finally {
    writeFileSync(gate, '');
    await before.settle(row('acme', number).id);
    delete process.env.FAKE_CLAUDE_GATE;
  }
  const review = (await human('GET', `${base}/reviews`)).at(-1);
  assert.match(review.body, /\*\*Comments on the title and description\*\*\n\n- Title \(low priority\): Shorter\./);
  assert.doesNotMatch(review.body, /undefined/);
  assert.match(review.body, /house-rules \(Claude, haiku, low effort\) reviewed the title, description and commit messages/);
  await human('PATCH', '/api/settings/reviewers/house-rules', { reviews: 'description', engine: 'claude' });
});

test('it reviews only the repositories it names', async () => {
  const { number, stderr } = await stage(other, ['--reviewer', 'house-rules']);
  assert.match(stderr, /Ignored reviewer house-rules: galley has no reviewer agent by that name for this repository\./);
  assert.match(stderr, /^No reviewer agent reviews it\.$/m);
  assert.doesNotMatch(await page(`/other/thing/pull/${number}`), /house-rules/);
  assert.ok(!server.service.readiness(row('other', number)).reviewers.some((r) => r.login === 'house-rules'));
  await human('POST', `/api/repos/other/thing/pulls/${number}/reviewers/house-rules`, undefined, 404);
  await human('PATCH', `/api/repos/other/thing/pulls/${number}/reviewers/house-rules`, { enabled: true }, 404);
  await human('GET', `/api/repos/other/thing/pulls/${number}/reviewers/house-rules`, undefined, 404);
  // Without a GitHub remote, a repository has no slug to match.
  const solo1 = await stage(solo);
  const { message } = await human('POST', `/api/repos/local/solo/pulls/${solo1.number}/reviewers/house-rules`, undefined, 404);
  assert.equal(message, 'house-rules does not review repositories without a GitHub remote');
});

test('galley reviewers lists the reviewer agents of the repository, without their instructions', async () => {
  const text = await cli(acme, ['reviewers']);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(
    text.stdout,
    [
      'NAME           ENGINE  REVIEWS      AUTOMATIC  LIMIT',
      'codex-review   codex   code         no         3',
      'claude-review  claude  code         no         3',
      'house-rules    claude  description  yes        3',
      '',
    ].join('\n'),
  );
  const json = await cli(acme, ['reviewers', '--json']);
  assert.deepEqual(JSON.parse(json.stdout), [
    { name: 'codex-review', engine: 'codex', reviews: 'code', automatic: false, limit: 3 },
    { name: 'claude-review', engine: 'claude', reviews: 'code', automatic: false, limit: 3 },
    { name: 'house-rules', engine: 'claude', reviews: 'description', automatic: true, limit: 3 },
  ]);
  const api = await human('GET', '/api/repos/acme/widgets/reviewers');
  assert.deepEqual(api.at(-1), { login: 'house-rules', reviewer: 'house-rules', engine: 'claude', reviews: 'description', automatic: true, max_iterations: 3 });
  assert.doesNotMatch(JSON.stringify(api), /imperative/);
  // Only those that review the repository; -R names another.
  assert.doesNotMatch((await cli(other, ['reviewers'])).stdout, /house-rules/);
  assert.match((await cli(other, ['reviewers', '-R', 'acme/widgets'])).stdout, /^house-rules +claude +description +yes +3$/m);
});

test('a custom reviewer with the head still to review keeps the pull request with the agents, where it reviews', async () => {
  git(acme, 'checkout', '-qb', 'feature/neg', 'main');
  writeFileSync(join(acme, 'neg.js'), 'export const neg = (a) => -a;\n');
  git(acme, 'add', 'neg.js');
  git(acme, 'commit', '-qm', 'Add neg');
  const { number } = await stage(acme);
  // Codex and Claude are off: house-rules is the one to start, when the author waits.
  const turn = server.service.turn(row('acme', number));
  assert.equal(turn.whose, 'author');
  const texts = turn.reasons.map((r) => r.text);
  assert.ok(texts.includes('agent has not asked for review yet (pr wait)'), texts.join('; '));
  assert.ok(texts.includes('house-rules reviews the description when agent waits for review'), texts.join('; '));
  await human('PATCH', `/api/repos/acme/widgets/pulls/${number}`, { state: 'closed' });
  // Where it does not review, nothing is left for a reviewer agent: the pull request is the reviewer's.
  const elsewhere = server.service.turn(row('other', 1));
  assert.equal(elsewhere.whose, 'reviewer');
  assert.ok(!elsewhere.reasons.some((r) => r.kind === 'reviewer_agent' || r.text.includes('has not asked for review')), elsewhere.reasons.map((r) => r.text).join('; '));
});

test('an edit while the author waits has the reviewer of the description review the new version at once', async () => {
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'Follows the rules.', verdict: 'approve', comments: [] });
  git(acme, 'checkout', '-qb', 'feature/sub', 'main');
  writeFileSync(join(acme, 'sub.js'), 'export const sub = (a, b) => a - b;\n');
  git(acme, 'add', 'sub.js');
  git(acme, 'commit', '-qm', 'Add sub');
  const { number } = await stage(acme);
  assert.match(await wait(acme, number), /house-rules reviewed: approved/);
  assert.match(await wait(acme, number), /The reviewer agents are done with/);
  // Nothing more to say about this version: the author waits for the reviewer.
  const id = row('acme', number).id;
  const waiting = wait(acme, number);
  await until(() => (server.service.waiters.get(id) ?? 0) > 0, 'the author waits');
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'Say what it subtracts.', verdict: 'comment', comments: [{ about: 'title', commit: null, priority: 'low', body: 'What is subtracted?' }] });
  await human('PATCH', `/api/repos/acme/widgets/pulls/${number}`, { title: 'Subtract' });
  assert.match(await waiting, /Say what it subtracts\./);
  await human('PATCH', `/api/repos/acme/widgets/pulls/${number}`, { state: 'closed' });
});

test('findings on the description keep the reviewer agents from being done until it reviews an edited version, whatever the author has seen', async () => {
  git(acme, 'checkout', '-qb', 'feature/mod', 'main');
  writeFileSync(join(acme, 'mod.js'), 'export const mod = (a, b) => a % b;\n');
  git(acme, 'add', 'mod.js');
  git(acme, 'commit', '-qm', 'Add mod');
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'The title.', verdict: 'comment', comments: [{ about: 'title', commit: null, priority: 'low', body: 'Say what it adds.' }] });
  const { number } = await stage(acme);
  try {
    assert.match(await wait(acme, number), /house-rules reviewed: commented/);
    // Seen, with no thread to reply in: the next wait does not hand the commit to the reviewer, and says what would.
    const held = await cli(acme, ['pr', 'wait', String(number), '--timeout', '2s']);
    assert.equal(held.code, 124);
    assert.match(held.stderr, /^house-rules commented on the description: edit the title or description, or reword the commits, as it asks; a reply does not answer it\./m);
    // An edited title: it reviews the new version, and once that finds nothing, the reviewer agents are done.
    process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'Follows the rules.', verdict: 'approve', comments: [] });
    assert.equal((await cli(acme, ['pr', 'edit', String(number), '--title', 'Add mod, the remainder'])).code, 0);
    assert.match(await wait(acme, number), /house-rules reviewed: approved/);
    assert.match(await wait(acme, number), /^The reviewer agents are done with [0-9a-f]{7} \(house-rules approved the description\); ask the user to review it/m);
    assert.equal((await human('GET', `/api/repos/acme/widgets/pulls/${number}/reviewers/house-rules`)).runs.length, 2);
  } finally {
    await human('PATCH', `/api/repos/acme/widgets/pulls/${number}`, { state: 'closed' });
  }
});

test('a review of the description is cancelled when the base moves and changes the commits, also with the head where it was', async () => {
  git(acme, 'checkout', '-qb', 'feature/two', 'main');
  writeFileSync(join(acme, 'two.js'), 'export const two = 2;\n');
  git(acme, 'add', 'two.js');
  git(acme, 'commit', '-qm', 'Add two');
  git(acme, 'branch', 'with-two');
  writeFileSync(join(acme, 'three.js'), 'export const three = 3;\n');
  git(acme, 'add', 'three.js');
  git(acme, 'commit', '-qm', 'Add three');
  const { number } = await stage(acme);
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const gate = join(dir, 'gate-base');
  process.env.FAKE_CLAUDE_GATE = gate;
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'Fine.', verdict: 'approve', comments: [] });
  try {
    const { run_id } = await human('POST', `${base}/reviewers/house-rules`);
    // Onto a base that has the first commit: the review read a message that is no longer there.
    await human('PATCH', base, { base: 'with-two' });
    const run = (await human('GET', `${base}/reviewers/house-rules`)).runs.find((r: any) => r.id === run_id);
    assert.deepEqual([run.status, run.reason], ['cancelled', 'base_moved']);
  } finally {
    writeFileSync(gate, '');
    await reviewer('house-rules').settle(row('acme', number).id);
    delete process.env.FAKE_CLAUDE_GATE;
  }
  assert.match(await page(`/acme/widgets/pull/${number}`), /<span class="agent-chunk">The base moved<\/span>/);
  await human('PATCH', base, { state: 'closed' });
});

test('a reviewer of the code with its own instructions, run by Codex, staged for and turned off per pull request', async () => {
  const created = await human('POST', '/api/settings/reviewers', {
    name: 'error-handling',
    engine: 'codex',
    reviews: 'code',
    repos: 'acme/widgets',
    run_tests: false,
    enabled: false,
    max_iterations: '1',
    instructions: 'Check the error handling.',
  });
  assert.deepEqual([created.login, created.error, created.max_iterations], ['error-handling', null, 1]);
  const file = readFileSync(join(reviewersDir, 'error-handling.md'), 'utf8');
  assert.match(file, /^---\nengine: codex\nrepos: \[acme\/widgets\]\nreviews: code\nverdict: comment\nmax_iterations: 1\nrun_tests: false\nenabled: false\n---\n\nCheck the error handling\.\n$/);
  // What GET gives can be sent back as it is.
  await human('PATCH', '/api/settings/reviewers/error-handling', await human('GET', '/api/settings/reviewers/error-handling'));
  assert.equal(readFileSync(join(reviewersDir, 'error-handling.md'), 'utf8'), file);

  // Off in its definition, on for one pull request by staging.
  git(acme, 'checkout', '-qb', 'feature/div', 'main');
  writeFileSync(join(acme, 'div.js'), 'export const div = (a, b) => a / b;\n');
  git(acme, 'add', 'div.js');
  git(acme, 'commit', '-qm', 'Add div');
  process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'Division by zero.', comments: [{ path: 'div.js', line: 1, start_line: null, side: 'RIGHT', priority: 'high', body: 'b may be 0.' }] });
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'Fine.', verdict: 'approve', comments: [] });
  const { number } = await stage(acme, ['--reviewer', 'error-handling:1']);
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  assert.deepEqual((await human('GET', `${base}/reviewers/error-handling`)).overrides, { enabled: true, max_iterations: 1 });
  assert.deepEqual(JSON.parse(row('acme', number).reviewer_overrides!), { 'error-handling': { enabled: true, max_iterations: 1 } });
  const out = await wait(acme, number);
  assert.match(out, /error-handling reviewed: commented/);
  assert.match(out, /house-rules reviewed: approved/, 'the reviews of a commit come together');
  const call = calls(process.env.FAKE_CODEX_LOG!).at(-1);
  assert.ok(call.files.includes('div.js'), 'in a checkout of the head');
  assert.deepEqual(call.args.slice(call.args.indexOf('-s'), call.args.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.deepEqual(call.schema.required, ['summary', 'comments']);
  assert.match(call.prompt, /\nCheck the error handling\.\n\nIf the pull request is fine, say so in the summary and leave no comments\./);
  assert.doesNotMatch(call.prompt, /Look for bugs/);
  assert.match((await human('GET', `${base}/reviews`)).find((r: any) => r.user.login === 'error-handling').body, /<sub>error-handling \(Codex, default model\) reviewed `[0-9a-f]{7}`, automatic review 1 of 1\.<\/sub>/);

  // Turned off for this pull request: the other reviewer's setting stays.
  await human('PATCH', `${base}/reviewers/error-handling`, { enabled: false });
  await human('PATCH', `${base}/reviewers/house-rules`, { max_iterations: 5 });
  assert.deepEqual(JSON.parse(row('acme', number).reviewer_overrides!), { 'error-handling': { enabled: false, max_iterations: 1 }, 'house-rules': { enabled: null, max_iterations: 5 } });
  await human('PATCH', `${base}/reviewers/house-rules`, { max_iterations: null });
  assert.deepEqual(JSON.parse(row('acme', number).reviewer_overrides!), { 'error-handling': { enabled: false, max_iterations: 1 } });
  assert.match(await page(`/acme/widgets/pull/${number}`), /<span class="agent-chunk">Automatic: off for this pull request<\/span>/);
});

test('a running review is cancelled for a change to what it reads as it started, whatever its definition says now', async () => {
  const number = server.service.db.get<{ number: number }>("SELECT number FROM pulls WHERE head_ref = 'feature/div'")!.number;
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const gate = join(dir, 'gate-codex');
  process.env.FAKE_CODEX_GATE = gate;
  process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'Fine.', comments: [] });
  const before = reviewer('error-handling');
  let runId: number;
  try {
    ({ run_id: runId } = await human('POST', `${base}/reviewers/error-handling`));
    // A reviewer of the description now, while it reviews the code: an edit leaves the code as it was.
    await human('PATCH', '/api/settings/reviewers/error-handling', { reviews: 'description' });
    await human('PATCH', base, { title: 'Divide' });
    assert.equal(runStatus(runId), 'running');
  } finally {
    writeFileSync(gate, '');
    await before.settle(row('acme', number).id);
    delete process.env.FAKE_CODEX_GATE;
  }
  assert.equal(runStatus(runId), 'done');
  await human('PATCH', '/api/settings/reviewers/error-handling', { reviews: 'code' });
});

test('a reviewer may be called anything a login may be, constructor too, and its settings for one pull request stay there', async () => {
  await human('POST', '/api/settings/reviewers', { name: 'constructor', engine: 'claude', reviews: 'description', repos: 'acme/*', instructions: 'Be brief.' });
  await human('PATCH', '/api/repos/acme/widgets/pulls/1/reviewers/constructor', { enabled: false });
  assert.deepEqual(JSON.parse(row('acme', 1).reviewer_overrides!).constructor, { enabled: false, max_iterations: null });
  const untouched = await human('GET', '/api/repos/acme/widgets/pulls/2/reviewers/constructor');
  assert.deepEqual([untouched.enabled, untouched.overrides], [true, { enabled: null, max_iterations: null }]);
  assert.equal((Object as unknown as Record<string, unknown>).enabled, undefined, 'Object is left alone');
  await human('PATCH', '/api/repos/acme/widgets/pulls/1/reviewers/constructor', { enabled: null });
  await human('DELETE', '/api/settings/reviewers/constructor');
});

test('a reviewer keeps its name, which nobody else may have, and comes back with its reviews when defined again', async () => {
  for (const [name, why] of [
    ['agent', /"agent" is already used by an author agent or another reviewer/],
    ['AgEnT', /"AgEnT" is already used by agent, an author agent or another reviewer/],
    ['codex', /would ask for the Codex reviewer/],
    ['claude-review', /would ask for the Claude reviewer/],
    ['reviewer', /"reviewer" is your name/],
    ['opencode', /what the CLI calls author agents/],
    ['House-Rules', /there is a reviewer called House-Rules already/],
  ] as const) {
    const { message } = await human('POST', '/api/settings/reviewers', { name, engine: 'claude' }, 422);
    assert.match(message, why, name);
  }
  assert.match((await human('PATCH', '/api/settings/reviewers/house-rules', { name: 'rules' }, 422)).message, /keeps its name/);
  assert.match((await human('PUT', '/api/settings/claude', { name: 'house-rules' }, 422)).message, /"house-rules" is already used by someone else/);
  // Nor the name of one that does not run, which would be in its way.
  assert.match((await human('PUT', '/api/settings/claude', { name: 'broken' }, 422)).message, /"broken" is the name of a custom reviewer/);
  await human('PATCH', '/api/settings/reviewers/house-rules', { effort: 'extreme' }, 422);
  // One written by hand a moment ago, before anything read it, is there all the same.
  const hand = '---\nengine: codex\n---\nMine.\n';
  writeFileSync(join(reviewersDir, 'by-hand.md'), hand);
  assert.match((await human('POST', '/api/settings/reviewers', { name: 'by-hand', engine: 'claude' }, 422)).message, /there is a reviewer called by-hand already/);
  assert.equal(readFileSync(join(reviewersDir, 'by-hand.md'), 'utf8'), hand);
  await human('DELETE', '/api/settings/reviewers/by-hand');
  // A reviewer may be called "new": its page is its own, not the form for a new one.
  await human('POST', '/api/settings/reviewers', { name: 'new', engine: 'codex' });
  const named = await page('/settings/reviewers/new');
  assert.match(named, /Save reviewer/);
  assert.match(named, /new\.md/);
  await human('DELETE', '/api/settings/reviewers/new');
  // Agents can not define reviewers.
  const res = await fetch(`${server.url}/api/settings/reviewers/house-rules`, { method: 'DELETE', headers: { 'x-galley-actor': 'agent' } });
  assert.equal(res.status, 403);

  // Deleted while it reviews: the review is interrupted by the time deleting returns, so the
  // reviewer defined again right after never finds it still running.
  const gate = join(dir, 'gate-deleted');
  await withFakes({ FAKE_CLAUDE_GATE: gate, FAKE_CLAUDE_REVIEW: JSON.stringify({ summary: 'Fine.', verdict: 'approve', comments: [] }) }, async () => {
    const old = reviewer('house-rules');
    const { run_id } = await human('POST', '/api/repos/acme/widgets/pulls/1/reviewers/house-rules');
    const runs = (await human('GET', '/api/repos/acme/widgets/pulls/1/reviewers/house-rules')).runs.length;
    server.service.custom!.remove('house-rules');
    assert.equal(runStatus(run_id), 'interrupted');
    writeFileSync(gate, '');
    await old.settle(row('acme', 1).id);
    assert.equal(existsSync(join(reviewersDir, 'house-rules.md')), false);
    // Its name in another case is its bot's too.
    assert.match((await human('POST', '/api/settings/reviewers', { name: 'House-Rules', engine: 'claude' }, 422)).message, /"House-Rules" is already used by house-rules/);
    // Its bot stays its own: a CLI caller by its name would pass for it, with approvals that count.
    const claim = await cli(acme, ['pr', 'list'], { actor: 'house-rules' });
    assert.notEqual(claim.code, 0);
    assert.match(claim.stderr, /"house-rules" is the name of a custom reviewer/);
    assert.doesNotMatch(await page('/acme/widgets/pull/1'), /id="agent-house-rules"/);
    assert.match(await page('/acme/widgets/pull/1'), /house-rules<\/a><span class="Label Label--bot">bot<\/span> approved the description/, 'its reviews stay');
    const reviews = server.service.db.all<ReviewRow>("SELECT * FROM reviews WHERE pull_id = ? AND state != 'PENDING'", row('acme', 1).id);
    assert.ok(reviews.some((r) => r.state === 'APPROVED'));
    assert.equal(server.service.reviewDecision(row('acme', 1), reviews), 'REVIEW_REQUIRED', 'and stand in for nobody');
    // Their transcripts too.
    const first = server.service.db.get<{ id: number }>("SELECT id FROM review_runs WHERE pull_id = ? AND reviewer = 'house-rules' AND review_id IS NOT NULL ORDER BY id", row('acme', 1).id)!.id;
    assert.match(await page('/acme/widgets/pull/1'), new RegExp(`<a class="review-run-link" href="/acme/widgets/pull/1/runs/${first}">`));
    const transcript = await fetch(`${server.url}/acme/widgets/pull/1/runs/${first}`);
    assert.equal(transcript.status, 200);
    assert.match(await transcript.text(), /house-rules/);

    // Written by hand again, it is the same reviewer: its bot and its runs, and the review asked
    // for by hand that deleting interrupted runs again.
    writeFileSync(join(reviewersDir, 'house-rules.md'), '---\nengine: claude\nrepos: [acme/*]\nreviews: description\n---\nThe title is in the imperative.\n');
    server.service.custom!.load();
    await reviewer('house-rules').settle(row('acme', 1).id);
    const again = (await human('GET', '/api/repos/acme/widgets/pulls/1/reviewers/house-rules')).runs;
    assert.equal(again.length, runs + 1);
    assert.deepEqual(again.slice(-2).map((r: any) => [r.trigger, r.status]), [['manual', 'interrupted'], ['manual', 'done']]);
    assert.equal(server.service.db.all("SELECT * FROM actors WHERE login = 'house-rules'").length, 1);
    assert.match(await page('/acme/widgets/pull/1'), /id="agent-house-rules"/);
  });
});

test('the reviewer agents\' approvals are their own for `pr wait` too: it says which approvals came before a new review', async () => {
  const base = '/api/repos/acme/widgets/pulls/1';
  await human('POST', `${base}/reviews`, { event: 'APPROVE', body: 'Good.' });
  const other = await cli(acme, ['pr', 'review', '1', '--comment', '-b', 'One more thing.'], { actor: 'other-bot' });
  assert.equal(other.code, 0, other.stderr);
  const view = JSON.parse((await cli(acme, ['pr', 'view', '1', '--json', 'reviews,reviewDecision'])).stdout);
  assert.equal(view.reviewDecision, 'APPROVED');
  assert.deepEqual(
    [...new Set(view.reviews.map((r: any) => `${r.author.login} ${r.byReviewerAgent}`))].sort(),
    ['house-rules true', 'other-bot false', 'reviewer false'],
  );
  const out = await wait(acme, 1);
  assert.match(out, /The approval from reviewer came before this review from other-bot\./);
  assert.doesNotMatch(out, /The approval from house-rules/);
});

test('a deleted custom reviewer\'s review is still a reviewer agent\'s: held while another reviews, to come with its review', async () => {
  await human('POST', '/api/settings/reviewers', { name: 'gone', engine: 'claude', reviews: 'code', repos: 'acme/widgets', instructions: 'Look.' });
  git(acme, 'checkout', '-qb', 'feature/gone', 'main');
  writeFileSync(join(acme, 'gone.js'), 'export const gone = 1;\n');
  git(acme, 'add', 'gone.js');
  git(acme, 'commit', '-qm', 'Add gone');
  const { number } = await stage(acme, ['--no-review']);
  const base = `/api/repos/acme/widgets/pulls/${number}`;
  const id = row('acme', number).id;
  process.env.FAKE_CLAUDE_REVIEW = JSON.stringify({ summary: 'Fine.', comments: [] });
  const gone = reviewer('gone');
  await human('POST', `${base}/reviewers/gone`);
  await gone.settle(id);
  await human('DELETE', '/api/settings/reviewers/gone');
  const gate = join(dir, 'gate-gone');
  process.env.FAKE_CODEX_GATE = gate;
  process.env.FAKE_CODEX_REVIEW = JSON.stringify({ summary: 'Fine too.', comments: [] });
  try {
    await human('POST', `${base}/reviewers/codex`);
    // While Codex reviews, its review waits for Codex's, as it would have before its file was deleted.
    const held = await cli(acme, ['pr', 'wait', String(number), '--timeout', '1s']);
    assert.equal(held.code, 124, held.stdout);
    writeFileSync(gate, '');
    const out = await wait(acme, number);
    assert.match(out, /gone reviewed: commented/);
    assert.match(out, /codex-review reviewed: commented/);
  } finally {
    writeFileSync(gate, '');
    await server.service.codex!.settle(id);
    delete process.env.FAKE_CODEX_GATE;
    await human('PATCH', base, { state: 'closed' });
  }
});

test('a restart leaves custom reviewers their runs: Codex takes no other reviewer\'s', async () => {
  const runs = async () => (await human('GET', '/api/repos/acme/widgets/pulls/1/reviewers/house-rules')).runs.map((r: any) => r.id);
  const before = await runs();
  assert.ok(before.length > 1);
  await server.close();
  server = await startServer(options);
  assert.deepEqual(await runs(), before);
  assert.equal(server.service.db.all("SELECT * FROM review_runs WHERE reviewer = 'error-handling'").length, 2);
  assert.deepEqual((await human('GET', '/api/repos/acme/widgets/pulls/1/reviewers/codex')).runs, []);
});

test('an interrupted review does not run again for a repository its reviewer no longer reviews', async () => {
  const number = 1;
  const id = row('acme', number).id;
  const runs = () => server.service.db.all("SELECT * FROM review_runs WHERE pull_id = ? AND reviewer = 'house-rules'", id).length;
  process.env.FAKE_CLAUDE_GATE = join(dir, 'gate-never');
  let run_id: number;
  let count: number;
  try {
    ({ run_id } = await human('POST', `/api/repos/acme/widgets/pulls/${number}/reviewers/house-rules`));
    count = runs();
    await server.close();
  } finally {
    delete process.env.FAKE_CLAUDE_GATE;
  }
  writeFileSync(join(reviewersDir, 'house-rules.md'), '---\nengine: claude\nrepos: [other/*]\nreviews: description\n---\nThe title is in the imperative.\n');
  server = await startServer(options);
  await reviewer('house-rules').settle(id);
  assert.equal(runStatus(run_id), 'interrupted');
  assert.equal(runs(), count, 'not run again');
  // Nor is it in the last round of a pull request it no longer reviews, beside one that does.
  await human('PATCH', `/api/repos/acme/widgets/pulls/${number}/reviewers/error-handling`, { enabled: true });
  const html = await page(`/acme/widgets/pull/${number}`);
  assert.match(html, />Stop iterating<\/button>/);
  assert.doesNotMatch(html, /title="house-rules's latest review/);
  await human('PATCH', `/api/repos/acme/widgets/pulls/${number}/reviewers/error-handling`, { enabled: null });
});

test('a custom reviewer\'s bot moves off your name when you take it, also the bot of one deleted', async () => {
  // Deleted earlier: its bot is still its, and was no reviewer agent to move.
  await server.close();
  server = await startServer({ ...options, viewerLogin: 'constructor' });
  assert.equal(server.service.viewer().type, 'User');
  await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
  assert.ok(server.service.db.get("SELECT 1 FROM actors WHERE login = 'constructor-reviewer' AND type = 'Bot'"));
  // One that runs is no longer valid by your name, and leaves it to you.
  await server.close();
  server = await startServer({ ...options, viewerLogin: 'house-rules' });
  assert.equal(server.service.viewer().type, 'User');
  await human('PUT', '/api/settings/publish', { mergeMethod: 'squash' });
  const entry = (await human('GET', '/api/settings/reviewers')).find((r: any) => r.name === 'house-rules');
  assert.match(entry.error, /"house-rules" is your name/);
});

test('the reviewers\' directory is made at start and followed, also once it is removed and made again', async () => {
  const fresh = join(dir, 'fresh', 'reviewers');
  const other = await startServer({ ...options, dataDir: join(dir, 'fresh-data'), reviewersDir: fresh });
  const names = async () => (await (await fetch(`${other.url}/api/settings/reviewers`)).json()).map((r: any) => r.name);
  try {
    assert.ok(existsSync(fresh));
    writeFileSync(join(fresh, 'first.md'), '---\nengine: claude\n---\n');
    // What a watcher on the files hears comes in its own time.
    await until(async () => (await names()).includes('first'), 'the new definition is read');
    rmSync(fresh, { recursive: true });
    await until(async () => (await names()).length === 0, 'the removed directory leaves no reviewers');
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'second.md'), '---\nengine: claude\n---\n');
    await until(async () => (await names()).join() === 'second', 'the directory made again is followed');
  } finally {
    await other.close();
  }
});
