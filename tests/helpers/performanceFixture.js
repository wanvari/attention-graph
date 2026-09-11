'use strict';
function makeRecordFixture(count = 20000, pages = 1000, topics = 100) {
  const now = new Date(2026, 8, 11, 15).getTime();
  const urls = Array.from({ length: pages }, (_, i) => `https://reference${i % 17}.example.test/page/${i}`);
  const data = { visits: [], captures: [], pages: urls.map((url, i) => ({ normalizedUrl: url, url, title: `Reference ${i}` })),
    topics: Array.from({ length: topics }, (_, i) => ({ topicId: `t${i}`, label: `Topic ${i}`, state: 'active' })),
    memberships: urls.map((url, i) => ({ topicId: `t${i % topics}`, normalizedUrl: url })), corrections: [], settings: [], runs: [], intent_sessions: [] };
  for (let i = 0; i < count; i++) {
    const url = urls[i % pages], time = now - (count - i) * 60000;
    data.visits.push({ visitId: `v${i}`, url, normalizedUrl: url, title: `Reference ${i % pages}`, visitTime: time, dwellMs: 30000 });
  }
  return { data, now };
}
module.exports = { makeRecordFixture };
