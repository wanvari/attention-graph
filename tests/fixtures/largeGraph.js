'use strict';
// Synthetic scale regression matching the reported 117 trails / 1,025 pages.
// No browsing data from the user's screenshots is copied into this fixture.
module.exports = function largeGraph(now = new Date(2026, 8, 10, 23).getTime()) {
  const names = ['Rust async programming', 'Chess opening preparation', 'Interface design systems', 'Local model evaluation', 'Sourdough fermentation', 'Database query planning', 'Running routes and training', 'Book research and notes', 'Browser extension APIs', 'Distributed systems', 'Photography and composition', 'Public transport routes', 'Music discovery', 'Garden planting notes', 'Data visualization', 'Keyboard customization', 'Space exploration', 'Travel planning'];
  const snapshot = {topics: [], pages: [], memberships: [], visits: [], settings: []};
  for (let i=0;i<117;i++) snapshot.topics.push({topicId:`large-${i}`,label:`${names[i%names.length]} — ${i+1}: references and source material`,state:'active',rationale:'Suggested grouping of recorded source pages.'});
  for (let i=0;i<1025;i++) {
    const url=`https://source-${i%37}.example.test/article-${i}`;
    snapshot.pages.push({normalizedUrl:url,url,title:`Source ${i}: ${names[i%names.length]} in practice`});
    if (i<258) snapshot.memberships.push({normalizedUrl:url,topicId:`large-${i%117}`});
  }
  for(let i=0;i<1962;i++) {
    const page=snapshot.pages[i%1025];
    snapshot.visits.push({visitId:`large-visit-${i}`,url:page.url,normalizedUrl:page.url,title:page.title,visitTime:now-20*86400000+i*7*60000,dwellMs:60000});
  }
  return snapshot;
};
