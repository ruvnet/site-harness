
const topicTerms={
 'AI agents':['agent','agents','agentic','llm','llms','inference','prompt','prompts'],
 'Coding & development':['coding','code','developer','developers','programming','debug','debugging','repository','github'],
 'Design & interfaces':['design','designer','designers','ui','ux','figma','interface','screens','prototype'],
 'Cloud & infrastructure':['cloud','hosting','deploy','deployment','server','servers','infrastructure','docker'],
 'Video & media':['video','videos','editing','animation','creator','creators','audio'],
 'Productivity & workflows':['productivity','workflow','workflows','calendar','tasks','scheduling'],
 'Growth & marketing':['marketing','seo','advertising','ads','leads','growth','conversion','conversions'],
 'Data & analytics':['analytics','database','databases','sql','dataset','datasets'],
 'Mobile apps':['iphone','android','ios','mobile','watch'],
 'Learning':['learn','learning','education','course','courses','study','skills']
};
const stop=new Set('this that with from have your their they them what when where which about into some more just been will would could should made make built build building app apps tool tools product products free using use used help helps today launch launches new next first best only really even after before people like need want works work users user find full public post source captured feed discussion link project sideproject'.split(' '));
const words=s=>new Set(String(s||'').toLowerCase().match(/[a-z0-9]+/g)||[]);
function connection(p,r){
 const a=words(p.name+' '+p.description),b=words(r.name);
 const shared=[...a].filter(w=>w.length>3&&!stop.has(w)&&b.has(w));
 const topics=Object.entries(topicTerms).filter(([,ts])=>ts.some(t=>a.has(t))&&ts.some(t=>b.has(t))).map(([k])=>k);
 const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 const pn=norm(p.name),rn=' '+norm(r.name)+' ';
 const mention=pn.length>=8&&pn.split(' ').filter(w=>!stop.has(w)).length>=2&&rn.includes(' '+pn+' ');
 if(mention)return {score:100,reason:'Product name appears in the post title',type:'Name match'};
 if(shared.length>=2)return {score:20+shared.length,reason:'Shared terms: '+shared.slice(0,3).join(', '),type:'Inferred relevance'};
 if(topics.length)return {score:5+topics.length,reason:'Shared topic: '+topics.slice(0,2).join(' + '),type:'Topic match'};
 return null;
}
function combinedRows(items){const reddit=items.filter(p=>p.source==='reddit');return items.filter(p=>p.source==='producthunt').map(p=>({p,matches:reddit.map(r=>({r,m:connection(p,r)})).filter(x=>x.m).sort((a,b)=>b.m.score-a.m.score).slice(0,2)}))}

export {connection,combinedRows};
