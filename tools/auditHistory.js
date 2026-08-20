#!/usr/bin/env node

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AttentionAnalysis = require('../attentionAnalysis.js');

const CHROME_EPOCH_OFFSET_MS = 11644473600000;

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function chromeTimeToMs(value) {
  return Math.round(Number(value) / 1000 - CHROME_EPOCH_OFFSET_MS);
}

function msToChromeTime(ms) {
  return Math.round((Number(ms) + CHROME_EPOCH_OFFSET_MS) * 1000);
}

function sqliteJson(dbPath, sql) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  }).trim();
  return out ? JSON.parse(out) : [];
}

function copyHistoryDb(profilePath) {
  const source = path.join(profilePath, 'History');
  assert.ok(fs.existsSync(source), `Chrome History DB not found at ${source}`);
  const tmpDir = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const target = path.join(tmpDir, `History-${Date.now()}.sqlite`);
  fs.copyFileSync(source, target);
  return target;
}

function sqlString(value) {
  return String(value).replace(/'/g, "''");
}

function loadHistoryFromSqlite({ days, maxResults, profilePath }) {
  const dbPath = copyHistoryDb(profilePath);
  const startMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const startChrome = msToChromeTime(startMs);
  const urlRows = sqliteJson(dbPath, `
    SELECT
      urls.id AS url_id,
      urls.url AS url,
      urls.title AS title,
      urls.last_visit_time AS last_visit_time,
      COUNT(visits.id) AS visit_count
    FROM urls
    JOIN visits ON visits.url = urls.id
    WHERE visits.visit_time >= ${startChrome}
      AND urls.url LIKE 'http%'
    GROUP BY urls.id
    ORDER BY urls.last_visit_time DESC
    LIMIT ${Number(maxResults)}
  `);
  const ids = urlRows.map(row => Number(row.url_id)).filter(Number.isFinite);
  if (!ids.length) return { historyItems: [], visitMap: {}, dbPath };
  const visitRows = sqliteJson(dbPath, `
    SELECT
      visits.id AS visit_id,
      visits.url AS url_id,
      visits.visit_time AS visit_time,
      visits.transition AS transition,
      urls.url AS url
    FROM visits
    JOIN urls ON urls.id = visits.url
    WHERE visits.visit_time >= ${startChrome}
      AND visits.url IN (${ids.join(',')})
    ORDER BY visits.visit_time ASC
  `);
  const historyItems = urlRows.map(row => ({
    id: String(row.url_id),
    url: row.url,
    title: row.title || '',
    lastVisitTime: chromeTimeToMs(row.last_visit_time),
    visitCount: Number(row.visit_count) || 0
  }));
  const visitMap = {};
  for (const row of visitRows) {
    if (!visitMap[row.url]) visitMap[row.url] = [];
    visitMap[row.url].push({
      visitId: String(row.visit_id),
      visitTime: chromeTimeToMs(row.visit_time),
      transition: String(row.transition || 'unknown')
    });
  }
  return { historyItems, visitMap, dbPath };
}

function domainRunSummary(events, limit = 12) {
  const runs = [];
  let current = null;
  for (const event of events) {
    if (!current || current.domain !== event.domain || current.last?.endsSession) {
      if (current) runs.push(current);
      current = {
        domain: event.domain,
        visits: 0,
        dwellMs: 0,
        start: event.visitTime,
        end: event.visitTime,
        titles: [],
        last: null
      };
    }
    current.visits++;
    current.dwellMs += event.dwellMs || 0;
    current.end = event.visitTime;
    if (current.titles.length < 4) current.titles.push(event.title);
    current.last = event;
  }
  if (current) runs.push(current);
  return runs
    .sort((a, b) => b.dwellMs - a.dwellMs || b.visits - a.visits)
    .slice(0, limit)
    .map(run => ({
      domain: run.domain,
      visits: run.visits,
      estimatedMinutes: AttentionAnalysis.msToMinutes(run.dwellMs),
      sampleTitles: run.titles
    }));
}

function transitionSample(events, limit = 24) {
  const samples = [];
  for (let i = 0; i < events.length - 1 && samples.length < limit; i++) {
    const from = events[i];
    const to = events[i + 1];
    if (from.endsSession) continue;
    samples.push({
      gapMinutes: AttentionAnalysis.msToMinutes(to.visitTime - from.visitTime),
      fromDomain: from.domain,
      toDomain: to.domain,
      fromTitle: from.title,
      toTitle: to.title
    });
  }
  return samples;
}

function compactAnalysis(analysis) {
  return {
    ok: analysis.ok,
    source: analysis.source,
    coverage: analysis.coverage,
    categorizedCoverage: analysis.categorizedCoverage,
    topics: analysis.topics.map(topic => ({
      id: topic.id,
      label: topic.label,
      confidence: Number(topic.confidence.toFixed(2)),
      visits: topic.visitCount,
      estimatedMinutes: topic.estimatedDwellMinutes,
      topDomains: topic.topDomains.map(item => item.domain),
      topPages: topic.topPages.slice(0, 4).map(page => ({
        title: page.title,
        domain: page.domain,
        visits: page.visitCount
      })),
      rationale: topic.rationale
    })),
    transitions: analysis.transitions.slice(0, 20).map(transition => ({
      label: transition.label,
      source: transition.sourceLabel,
      target: transition.targetLabel,
      visits: transition.visitCount,
      confidence: Number(transition.confidence.toFixed(2)),
      similarity: Number(transition.similarity.toFixed(2)),
      examples: transition.representativeVisits.slice(0, 2).map(item => ({
        from: item.from.title,
        to: item.to.title,
        gapMinutes: item.estimatedGapMinutes
      })),
      rationale: transition.rationale
    })),
    metrics: analysis.metrics,
    uncategorized: analysis.uncategorized,
    adjudicationSummary: analysis.adjudicationSummary
  };
}

async function main() {
  const days = Number(argValue('--days', 7));
  const maxResults = Number(argValue('--max-results', 2000));
  const withOllama = hasFlag('--with-ollama');
  const profilePath = argValue(
    '--profile',
    path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default')
  );
  const loaded = loadHistoryFromSqlite({ days, maxResults, profilePath });
  const built = AttentionAnalysis.buildVisitEventsFromHistoryItems(loaded.historyItems, loaded.visitMap, { days, maxResults });
  const result = {
    generatedAt: new Date().toISOString(),
    profilePath,
    copiedDbPath: loaded.dbPath,
    input: { days, maxResults, withOllama },
    coverage: built.coverage,
    domainRuns: domainRunSummary(built.events),
    transitionSamples: transitionSample(built.events)
  };
  if (withOllama) {
    const analysis = await AttentionAnalysis.analyzeVisitEvents(built.events, {
      useOllama: true,
      maxPagesForAi: Number(argValue('--max-pages', AttentionAnalysis.DEFAULTS.maxPagesForAi)),
      onProgress: message => console.error(message)
    });
    analysis.coverage = built.coverage;
    result.analysis = compactAnalysis(analysis);
  }
  const outDir = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `history-audit-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    report: outPath,
    coverage: result.coverage,
    domainRuns: result.domainRuns.slice(0, 5),
    analysisTopics: result.analysis ? result.analysis.topics.length : null,
    analysisTransitions: result.analysis ? result.analysis.transitions.length : null
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
