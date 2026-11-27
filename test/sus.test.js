'use strict';

// The usability-survey scoring (scripts/sus-score.js). The scoring rule is fixed by the SUS method, so the answers below are
// worked out by hand, not by the code under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { susScore, summarise, parseCsv, readResponses, tCritical, band } = require('../scripts/sus-score');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'sus-score.js');

test('the best possible answers score 100 and the worst score 0', () => {
  // best: agree (5) with the positive statements 1,3,5,7,9 and disagree (1) with the negative ones 2,4,6,8,10
  assert.equal(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]), 100);
  assert.equal(susScore([1, 5, 1, 5, 1, 5, 1, 5, 1, 5]), 0);
});

test('answering 3 to everything scores exactly 50', () => {
  assert.equal(susScore(Array(10).fill(3)), 50);
});

test('a worked example: 4,2,5,1,4,2,5,2,4,1 is 85 and 3,3,4,2,4,3,4,2,3,2 is 65', () => {
  // first: (3+4+3+4+3) + (3+4+3+3+4) = 34, times 2.5
  assert.equal(susScore([4, 2, 5, 1, 4, 2, 5, 2, 4, 1]), 85);
  // second: (2+3+3+3+2) + (2+3+2+3+3) = 26, times 2.5
  assert.equal(susScore([3, 3, 4, 2, 4, 3, 4, 2, 3, 2]), 65);
});

test('scores move in steps of 2.5, and a wrong sheet is refused', () => {
  assert.equal(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, 2]), 97.5);
  for (const bad of [[], [1, 2, 3], Array(11).fill(3), [0, 3, 3, 3, 3, 3, 3, 3, 3, 3], [6, 3, 3, 3, 3, 3, 3, 3, 3, 3], [3.5, 3, 3, 3, 3, 3, 3, 3, 3, 3], ['3', 3, 3, 3, 3, 3, 3, 3, 3, 3], null]) {
    assert.throws(() => susScore(bad), /ten whole numbers/);
  }
});

test('the group figures: average, middle value, sample standard deviation and the 95% interval', () => {
  // scores 85, 65, 50, 100 -> mean 75, median (65+85)/2 = 75
  const rows = [
    { participant: 'A', answers: [4, 2, 5, 1, 4, 2, 5, 2, 4, 1] },
    { participant: 'B', answers: [3, 3, 4, 2, 4, 3, 4, 2, 3, 2] },
    { participant: 'C', answers: Array(10).fill(3) },
    { participant: 'D', answers: [5, 1, 5, 1, 5, 1, 5, 1, 5, 1] },
  ];
  const s = summarise(rows);
  assert.equal(s.participants, 4);
  assert.equal(s.mean, 75);
  assert.equal(s.median, 75);
  assert.equal(s.min, 50);
  assert.equal(s.max, 100);
  // deviations -> 10, -10, -25, 25 ; squares 100+100+625+625 = 1450 ; /3 = 483.33 ; sqrt = 21.985
  assert.ok(Math.abs(s.sd - Math.sqrt(1450 / 3)) < 1e-9);
  // 95% interval uses t for 3 degrees of freedom (3.182): 75 +- 3.182 * 21.985 / 2
  const half = 3.182 * (Math.sqrt(1450 / 3) / 2);
  assert.ok(Math.abs(s.ci[0] - (75 - half)) < 1e-9 && Math.abs(s.ci[1] - Math.min(100, 75 + half)) < 1e-9);
  assert.ok(s.ci[0] >= 0 && s.ci[1] <= 100, 'the interval is kept inside 0 to 100');
  assert.deepEqual(s.scores.map((r) => r.score), [85, 65, 50, 100]);
});

test('one participant has a score but no spread or interval, and nobody at all is an error', () => {
  const s = summarise([{ participant: 'A', answers: Array(10).fill(3) }]);
  assert.equal(s.mean, 50);
  assert.equal(s.sd, null);
  assert.equal(s.ci, null);
  assert.throws(() => summarise([]), /no participants/);
});

test('each statement is averaged after adjusting, so the weakest part of the site shows', () => {
  // everyone gives the best answer to all but statement 4 ("I would need a technical person"), which they all dislike (5)
  const best = [5, 1, 5, 1, 5, 1, 5, 1, 5, 1];
  const rows = [0, 1, 2].map((i) => ({ participant: 'P' + i, answers: best.map((a, k) => (k === 3 ? 5 : a)) }));
  const s = summarise(rows);
  assert.equal(s.perItem[3], 0);
  assert.ok(s.perItem.every((v, i) => (i === 3 ? v === 0 : v === 4)));
});

test('t values and the rule-of-thumb bands', () => {
  assert.equal(tCritical(1), 12.706);
  assert.equal(tCritical(9), 2.262);
  assert.equal(tCritical(30), 2.042);
  assert.equal(tCritical(31), 2.021);
  assert.equal(tCritical(1000), 1.96);
  assert.equal(tCritical(0), null);
  assert.equal(band(40), 'poor');
  assert.equal(band(51), 'below average to average');
  assert.equal(band(68), 'above average to good');
  assert.equal(band(85), 'excellent');
});

const HEAD = 'participant,role,device,q1,q2,q3,q4,q5,q6,q7,q8,q9,q10,comment';

test('the CSV reader handles quotes, commas in comments, blank lines, # lines, Windows line ends and a leading BOM', () => {
  const text = `﻿# a note\r\n${HEAD}\r\n\r\nP01,car,phone,4,2,5,1,4,2,5,2,4,1,"easy, but the ""pay"" button was small"\r\n# another\r\nP02,bike,laptop,3,3,4,2,4,3,4,2,3,2,\r\n`;
  const { rows, problems } = readResponses(text);
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].participant, 'P01');
  assert.deepEqual(rows[1].answers, [3, 3, 4, 2, 4, 3, 4, 2, 3, 2]);
  const raw = parseCsv(text);
  assert.equal(raw[1].cells[13], 'easy, but the "pay" button was small');
});

test('columns may be in any order, and other columns are ignored', () => {
  const text = 'q10,q9,q8,q7,q6,q5,q4,q3,q2,q1,participant\n1,5,1,5,1,5,1,5,1,5,Zed\n';
  const { rows, problems } = readResponses(text);
  assert.deepEqual(problems, []);
  assert.equal(susScore(rows[0].answers), 100);
  assert.equal(rows[0].participant, 'Zed');
});

test('a file with a problem is refused with the line number, and nothing is scored', () => {
  const text = `${HEAD}\nP01,car,phone,4,2,5,1,4,2,5,2,4,1,ok\nP02,car,phone,4,2,,1,4,2,5,2,4,1,\nP03,car,phone,4,2,7,1,4,2,5,2,4,1,\nP04,car,phone,4,2,x,1,4,2,5,2,4,1,\nP01,car,phone,4,2,5,1,4,2,5,2,4,1,again\n`;
  const { rows, problems } = readResponses(text);
  assert.ok(problems.some((p) => p.startsWith('Line 3:') && p.includes('no answer for q3')), problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('Line 4:') && p.includes('"7"')));
  assert.ok(problems.some((p) => p.startsWith('Line 5:') && p.includes('"x"')));
  assert.ok(problems.some((p) => p.startsWith('Line 6:') && p.includes('appears twice')));
  assert.equal(rows.length, 1, 'only the good line is kept, and the command line still scores nothing (next test)');
});

test('a missing column, an empty file and an unclosed quote are each reported', () => {
  assert.match(readResponses('participant,q1,q2\nP1,3,3\n').problems.join(' '), /no column named q3/);
  assert.match(readResponses('').problems.join(' '), /no header line/);
  assert.match(readResponses(`${HEAD}\n`).problems.join(' '), /no participants/);
  assert.match(readResponses(`${HEAD}\nP1,car,phone,3,3,3,3,3,3,3,3,3,3,"never closed\n`).problems.join(' '), /quote was opened/);
});

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}
function tmpFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sus-'));
  const file = path.join(dir, 'responses.csv');
  fs.writeFileSync(file, text);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the command prints the table and the group figures, and --json gives the same numbers', (t) => {
  const { file, cleanup } = tmpFile(`${HEAD}\nP01,car,phone,4,2,5,1,4,2,5,2,4,1,\nP02,bike,phone,3,3,4,2,4,3,4,2,3,2,\n`);
  t.after(cleanup);
  const out = run([file]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /\| P01 \| 85 \|/);
  assert.match(out.stdout, /\| P02 \| 65 \|/);
  assert.match(out.stdout, /Average:\s+75/);
  assert.match(out.stdout, /2 participants is few/);
  const json = run([file, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.equal(data.mean, 75);
  assert.equal(data.participants, 2);
  assert.deepEqual(data.scores.map((r) => r.score), [85, 65]);
});

test('the command exits with an error and prints no score when the file has a problem or does not exist', (t) => {
  const { file, cleanup } = tmpFile(`${HEAD}\nP01,car,phone,4,2,9,1,4,2,5,2,4,1,\n`);
  t.after(cleanup);
  const bad = run([file]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Nothing was scored/);
  assert.match(bad.stderr, /Line 2: q3 is "9"/);
  assert.equal(bad.stdout, '');
  const missing = run([path.join(os.tmpdir(), 'no-such-sus-file.csv')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist/);
});

test('the template in usability/ is a valid file, and the survey page carries the ten standard statements', () => {
  const template = fs.readFileSync(path.join(root, 'usability', 'responses-template.csv'), 'utf8');
  const { rows, problems } = readResponses(template);
  assert.deepEqual(problems, []);
  assert.ok(rows.length >= 1);
  const doc = fs.readFileSync(path.join(root, 'usability', 'SUS-SURVEY.md'), 'utf8');
  const statements = [
    'I think that I would like to use this website frequently.',
    'I found the website unnecessarily complex.',
    'I thought the website was easy to use.',
    'I think that I would need the support of a technical person to be able to use this website.',
    'I found the various functions in this website were well integrated.',
    'I thought there was too much inconsistency in this website.',
    'I would imagine that most people would learn to use this website very quickly.',
    'I found the website very cumbersome to use.',
    'I felt very confident using the website.',
    'I needed to learn a lot of things before I could get going with this website.',
  ];
  // all ten are there, in the standard order (odd and even statements are worded in opposite directions on purpose)
  const positions = statements.map((st) => doc.indexOf(st));
  assert.ok(positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1])), positions.join(','));
});

test('npm run sus is wired up, and the load-test tool stays out of what the live site installs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.sus, 'node scripts/sus-score.js');
  assert.ok(pkg.devDependencies && pkg.devDependencies.autocannon, 'autocannon is a development dependency');
  assert.ok(!pkg.dependencies.autocannon, 'autocannon is not installed on the live site');
});
