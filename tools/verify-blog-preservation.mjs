// Read-only candidate check. No admin session or mutation is used.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCloudflareProductionHandler} from '../src/blog-cloudflare-production.mjs';
const baseline=process.argv[2],output=process.argv[3];
if(!baseline||!output)throw Error('Usage: node tools/verify-blog-preservation.mjs BASELINE_DIRECTORY OUTPUT_JSON');
const manifest=JSON.parse(await readFile(`${baseline}/manifest.json`,'utf8'));
const originalSitemap=await readFile(`${baseline}/sitemap.xml`,'utf8');
const hash=html=>createHash('sha256').update(html.replace(/\r\n/g,'\n')).digest('hex');
const handler=createCloudflareProductionHandler();
async function candidate(route,slug){const r={statusCode:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},status(s){this.statusCode=s;return this;},end(body){this.body=body||'';return this;}};await handler({method:'GET',query:{route,slug}},r);return r;}
const results=[];
for(const article of manifest.articles){const slug=article.path.split('/').at(-1),original=await readFile(`${baseline}/${slug}.html`,'utf8'),result=await candidate('post',slug);results.push({path:article.path,status:result.statusCode,contentUnchanged:hash(result.body)===hash(original)});}
const sitemap=await candidate('sitemap');
const entries=xml=>[...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(m=>m[1].replace(/>\s+</g,'><').trim()).sort();
const oldEntries=entries(originalSitemap),newEntries=entries(sitemap.body);
const report={checkedAt:new Date().toISOString(),articles:results,sitemap:{status:sitemap.statusCode,baselineEntries:oldEntries.length,candidateEntries:newEntries.length,unchanged:JSON.stringify(oldEntries)===JSON.stringify(newEntries)},pass:results.every(r=>r.status===200&&r.contentUnchanged)&&sitemap.statusCode===200&&JSON.stringify(oldEntries)===JSON.stringify(newEntries)};
await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:report.pass,articles:results.length,changed:results.filter(r=>!r.contentUnchanged),sitemap:report.sitemap}));if(!report.pass)process.exitCode=1;
