import { FalkorDB } from 'falkordb';
async function main() {
  const db = await FalkorDB.connect({ socket: { host: 'localhost', port: 6379 } });
  const g = db.selectGraph('localclaw_memory');
  const bySender = await g.query('MATCH (f:Fact) RETURN f.senderId AS s, count(f) AS n ORDER BY n DESC');
  console.log('Facts by senderId:', JSON.stringify(bySender.data));
  const noEmb = await g.query('MATCH (f:Fact) WHERE f.embedding IS NULL RETURN count(f) AS n');
  console.log('Facts WITHOUT embedding:', JSON.stringify(noEmb.data));
  const total = await g.query('MATCH (f:Fact) RETURN count(f) AS n');
  console.log('Total facts:', JSON.stringify(total.data));
  const sample = await g.query("MATCH (f:Fact) WHERE toLower(f.text) CONTAINS 'localclaw' OR toLower(f.text) CONTAINS 'spark' RETURN f.senderId, left(f.text, 60) LIMIT 5");
  console.log('Sample hardware-ish facts:', JSON.stringify(sample.data));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
