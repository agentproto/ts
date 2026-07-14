import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
const ROOT='/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/knowledge'
const CORPORA={'ai-companion':'compagnon-ia','personal-assistant':'assistant-ia','openclaw':'openclaw'}
const walk=(d,acc=[])=>{for(const e of readdirSync(d)){const p=join(d,e);const s=statSync(p);if(s.isDirectory())walk(p,acc);else if(e.endsWith('.md'))acc.push(p)}return acc}
const fm=(t)=>{const m=t.match(/^---\n([\s\S]*?)\n---/);if(!m)return null;try{return YAML.parse(m[1])}catch{return null}}
const domain=(u)=>{try{return new URL(u).hostname.replace(/^www\./,'')}catch{return ''}}
const pubdate=(u)=>{let m=u.match(/\/(20\d{2})[\/-](\d{2})[\/-](\d{2})/);if(m)return `${m[1]}-${m[2]}-${m[3]}`;m=u.match(/\/(20\d{2})\/(\d{2})\//);if(m)return `${m[1]}-${m[2]}`;m=u.match(/-(20\d{2})(\d{2})(\d{2})/);if(m)return `${m[1]}-${m[2]}-${m[3]}`;return ''}
const csv=(v)=>'\"'+String(v??'').replace(/\"/g,'\"\"').replace(/\s+/g,' ').trim()+'\"'
const rows=[['topic','media','type','titre_article','url','date_publi_estimee','date_scrape','contact_a_enrichir']]
for(const [c,topic] of Object.entries(CORPORA)){const dir=join(ROOT,c,'sources');let files=[];try{files=walk(dir)}catch{continue}
 for(const f of files){const fr=fm(readFileSync(f,'utf8'));if(!fr)continue;const url=fr?.metadata?.corpus?.originalUrl||fr?.metadata?.corpus?.importerSourceUrl||'';const title=fr?.title||'';const cap=String(fr?.captured_at||'').slice(0,10);const type=fr?.metadata?.corpus?.fetchKind||fr?.fetchKind||'article';rows.push([topic,domain(url),type,title,url,pubdate(url),cap,''])}}
const out=rows.map(r=>r.map(csv).join(',')).join('\n')
const dest=ROOT+'/outreach-media-contacts.csv'
writeFileSync(dest,out)
console.log('lignes:',rows.length-1,'->',dest)
const by={}; for(const r of rows.slice(1)) by[r[1]]=(by[r[1]]||0)+1
console.log('medias uniques:',Object.keys(by).length)
console.log('avec date publi:',rows.slice(1).filter(r=>r[5]).length+'/'+(rows.length-1))
