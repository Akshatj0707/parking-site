#!/usr/bin/env node
'use strict';

/*
 * Works out System Usability Scale (SUS) scores from the answers of a usability test.
 *
 *   npm run sus                                     reads usability/responses.csv
 *   npm run sus -- some/other.csv
 *   npm run sus -- usability/responses.csv --json   the same numbers as JSON
 *
 * The file has one line per participant, with columns named q1 to q10 (answers 1 to 5), and any other columns you like
 * (participant, role, device, comment ...). See usability/SUS-SURVEY.md. The script refuses to score a file that has a problem
 * (a missing answer, a number outside 1 to 5, a repeated participant) and says which line, so a typo cannot change the result.
 */

const fs = require('node:fs');
const path = require('node:path');

const ITEMS = 10;

// Brooke's scoring: statements 1, 3, 5, 7, 9 are worded positively (answer - 1), 2, 4, 6, 8, 10 negatively (5 - answer);
// the ten adjusted values add up to 0..40, and times 2.5 gives 0..100.
function adjusted(answers) {
  return answers.map((a, i) => (i % 2 === 0 ? a - 1 : 5 - a));
}

function susScore(answers) {
  if (!Array.isArray(answers) || answers.length !== ITEMS || !answers.every((a) => Number.isInteger(a) && a >= 1 && a <= 5)) {
    throw new Error('A SUS answer sheet needs ten whole numbers from 1 to 5');
  }
  return adjusted(answers).reduce((sum, v) => sum + v, 0) * 2.5;
}

// Two-sided 95% critical values of Student's t for 1 to 30 degrees of freedom (the usual table).
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08,
  2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];
function tCritical(df) {
  if (df < 1) return null;
  if (df <= 30) return T95[df - 1];
  if (df <= 40) return 2.021;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}

// A short, plain reading of a score (the usual rules of thumb: about 68 is the average over many products).
function band(score) {
  if (score < 51) return 'poor';
  if (score < 68) return 'below average to average';
  if (score < 80) return 'above average to good';
  return 'excellent';
}

const round = (n, digits = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** digits) / 10 ** digits);

function summarise(rows) {
  const n = rows.length;
  if (n === 0) throw new Error('There are no participants to score');
  const scores = rows.map((r) => susScore(r.answers));
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  let sd = null;
  let ci = null;
  if (n > 1) {
    sd = Math.sqrt(scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / (n - 1)); // sample standard deviation
    const half = tCritical(n - 1) * (sd / Math.sqrt(n));
    ci = [Math.max(0, mean - half), Math.min(100, mean + half)];
  }
  // each statement's average after the 0..4 adjustment (4 = the best possible answer), to see which one drags the score down
  const perItem = Array.from({ length: ITEMS }, (_, i) => rows.reduce((sum, r) => sum + adjusted(r.answers)[i], 0) / n);
  return {
    participants: n,
    scores: rows.map((r, i) => ({ participant: r.participant, score: scores[i] })),
    mean,
    median,
    sd,
    ci,
    min: sorted[0],
    max: sorted[n - 1],
    band: band(mean),
    perItem,
  };
}

// A small CSV reader: commas, "quoted, fields" with "" for a quote, blank lines and lines starting with # ignored.
function parseCsv(text) {
  const lines = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0].trim() === '') && !(row[0] || '').trim().startsWith('#')) lines.push({ line: startLine, cells: row.map((c) => c.trim()) });
    row = [];
  };
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      line++;
      startLine = line;
    } else field += ch;
  }
  if (quoted) lines.push({ line: startLine, cells: null, problem: 'a quote was opened and never closed' });
  else if (field !== '' || row.length) endRow();
  return lines;
}

// Turns the CSV text into participants, or says what is wrong. Never guesses.
function readResponses(text) {
  const lines = parseCsv(text);
  const problems = [];
  const broken = lines.find((l) => l.cells === null);
  if (broken) return { rows: [], problems: [`Line ${broken.line}: ${broken.problem}`] };
  if (lines.length === 0) return { rows: [], problems: ['The file has no header line and no participants'] };
  const header = lines[0].cells.map((h) => h.toLowerCase());
  const col = {};
  for (let i = 1; i <= ITEMS; i++) {
    col[i] = header.indexOf('q' + i);
    if (col[i] === -1) problems.push(`The header line has no column named q${i}`);
  }
  const idCol = header.indexOf('participant');
  if (problems.length) return { rows: [], problems };
  const rows = [];
  const seen = new Set();
  for (const { line, cells } of lines.slice(1)) {
    const answers = [];
    let ok = true;
    for (let i = 1; i <= ITEMS; i++) {
      const raw = cells[col[i]];
      if (raw === undefined || raw === '') {
        problems.push(`Line ${line}: no answer for q${i}`);
        ok = false;
      } else if (!/^[1-5]$/.test(raw)) {
        problems.push(`Line ${line}: q${i} is "${raw}", it must be a whole number from 1 to 5`);
        ok = false;
      } else answers.push(Number(raw));
    }
    const name = (idCol >= 0 && cells[idCol]) || `line ${line}`;
    if (seen.has(name.toLowerCase())) {
      problems.push(`Line ${line}: the participant "${name}" appears twice`);
      ok = false;
    }
    seen.add(name.toLowerCase());
    if (ok) rows.push({ participant: name, answers });
  }
  if (!problems.length && rows.length === 0) problems.push('The file has a header line but no participants');
  return { rows, problems };
}

const ITEM_TEXT = [
  'I would like to use it frequently',
  'It was unnecessarily complex',
  'It was easy to use',
  'I would need a technical person',
  'The functions were well integrated',
  'Too much inconsistency',
  'Most people would learn it quickly',
  'It was very cumbersome',
  'I felt very confident',
  'I needed to learn a lot first',
];

function report(s) {
  const out = [];
  out.push('SUS results');
  out.push('===========');
  out.push('');
  out.push('| Participant | SUS score |');
  out.push('|---|---:|');
  for (const r of s.scores) out.push(`| ${r.participant} | ${r.score} |`);
  out.push('');
  out.push(`Participants:        ${s.participants}`);
  out.push(`Average:             ${round(s.mean)}  (${s.band}; the average over many products is about 68)`);
  out.push(`Middle value:        ${round(s.median)}`);
  out.push(`Lowest / highest:    ${s.min} / ${s.max}`);
  if (s.sd === null) {
    out.push('Spread and interval: need at least two participants');
  } else {
    out.push(`Spread (std dev):    ${round(s.sd)}`);
    out.push(`95% interval:        ${round(s.ci[0])} to ${round(s.ci[1])}  (the true average for people like these is probably in here)`);
  }
  if (s.participants < 10) out.push(`\nNote: ${s.participants} participants is few. Treat the average as a rough guide and report the interval with it.`);
  out.push('');
  out.push('Each statement, averaged (0 to 4 after adjusting; 4 is the best possible):');
  const worst = Math.min(...s.perItem);
  const single = s.perItem.filter((v) => v === worst).length === 1; // a tie points at nothing in particular
  s.perItem.forEach((v, i) => out.push(`  ${String(i + 1).padStart(2)}. ${ITEM_TEXT[i].padEnd(38)} ${round(v, 2).toFixed(2)}${single && v === worst && s.participants > 1 ? '   <- lowest' : ''}`));
  return out.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const file = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'usability', 'responses.csv');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${file}: ${err.code === 'ENOENT' ? 'the file does not exist. Copy usability/responses-template.csv to usability/responses.csv and fill it in.' : err.message}`);
    return 1;
  }
  const { rows, problems } = readResponses(text);
  if (problems.length) {
    console.error(`Nothing was scored. Fix ${problems.length === 1 ? 'this' : 'these'} in ${file}:`);
    for (const p of problems) console.error('  - ' + p);
    return 1;
  }
  const summary = summarise(rows);
  if (json) {
    console.log(JSON.stringify({ ...summary, mean: round(summary.mean, 2), median: round(summary.median, 2), sd: round(summary.sd, 2), ci: summary.ci && summary.ci.map((v) => round(v, 2)), perItem: summary.perItem.map((v) => round(v, 2)) }, null, 2));
  } else console.log(report(summary));
  return 0;
}

module.exports = { susScore, summarise, parseCsv, readResponses, tCritical, band, report };

if (require.main === module) process.exitCode = main(process.argv);
