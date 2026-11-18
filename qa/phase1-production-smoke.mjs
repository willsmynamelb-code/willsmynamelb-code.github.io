// Post-release audit of the actual deployed public website.
// Does not change the site, send analytics, collect reader data, or access user accounts.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE = 'https://tymetobegin.com/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { scope:'Actual GitHub Pages domain, separate from repository and local lab', base:BASE, checks:[], visual:[], axe:[], failures:[] };
function check(name, passed, details='') {
  const obj={name,passed:!!passed,details};
  report.checks.push(obj);
  console.log((passed?'PASS ':'FAIL ')+name+(details?' :: '+details:''));
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const files = ['index.html','phase1-illuminated.css','illuminated-path-hero.svg','tyme-sober-companion-cover.webp','fonts/libre-baskerville-regular.woff2','fonts/inter-latin-variable.woff2','analytics-off.html'];
await mkdir('qa-results/postrelease',{recursive:true});
let browser;
try {
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await context.route(/google-analytics\\.com|googletagmanager\\.com|doubleclick\\.net|amazon\\.com|facebook\\.com/,route=>route.abort());
  // Wait for GitHub Pages to serve the new SHA. Success here means actual public
  // content matches the source. Retries only read public pages.
  let published=false,last='not started';
  for(let i=0;i<12;i++){
    try{
      const response=await context.request.get(BASE,{timeout:13000,headers:{'cache-control':'no-cache'}});
      const body=await response.body();
      const expected=await readFile('index.html');
      if(response.ok() && sha(body)===sha(expected)){published=true;break;}
      last='status '+response.status()+', expected sha '+sha(expected).slice(0,12)+', live sha '+sha(body).slice(0,12);
    }catch(e){last=String(e).slice(0,240);}
    if(i<11)await sleep(10000);
  }
  check('Public homepage matches merged repository HTML byte for byte',published,last);
  // Continue with diagnostics if bytes differ, but do not make success claims.
  for(const file of files.slice(1)){
    try{
      const r=await context.request.get(BASE+file,{timeout:13000});
      const actual=await r.body();
      const local=await readFile(file);
      check('Deployed asset matches source: '+file,r.ok() && sha(actual)===sha(local),
        'HTTP '+r.status()+' local '+sha(local).slice(0,12)+' live '+sha(actual).slice(0,12));
    }catch(e){check('Deployed asset matches source: '+file,false,String(e).slice(0,240));}
  }
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});
    const res=await page.goto(BASE,{waitUntil:'domcontentloaded',timeout:25000});
    await page.evaluate(()=>document.fonts.ready);
    const result=await page.evaluate(()=>({
      width:innerWidth,scroll:document.documentElement.scrollWidth,
      css:!![...document.styleSheets].find(s=>s.href?.includes('phase1-illuminated.css')),
      svg:getComputedStyle(document.querySelector('.hero')).backgroundImage.includes('illuminated-path-hero.svg'),
      cover:document.querySelector('.hero-cover')?.naturalWidth>0,
      days:document.querySelectorAll('[data-reader-day]').length,
      months:document.querySelectorAll('.month-pick').length
    }));
    report.visual.push(result);
    check('Live responsive '+width+'px',res.ok() && result.scroll<=width+1 && result.css && result.svg && result.cover && result.days===7 && result.months===12,JSON.stringify(result));
    if(width===390||width===1440)
      await page.screenshot({path:'qa-results/postrelease/live-'+width+'.png',fullPage:true,animations:'disabled'});
  }
  await page.setViewportSize({width:390,height:844});
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.locator('#menuButton').click();
  check('Live mobile navigation',await page.locator('#menuButton').getAttribute('aria-expanded')==='true');
  await page.keyboard.press('Escape');
  check('Live mobile Escape closes menu',await page.locator('#menuButton').getAttribute('aria-expanded')==='false');
  await page.locator('[data-reader-select="7"]').click();
  check('Live Jan 7 reflection navigation',await page.locator('#reader-page').textContent()==='7 / 7' &&
    await page.locator('[data-reader-day="7"]').isVisible() &&
    (await page.locator('#reader-finish').textContent()).includes('January 7 selected'));
  await page.locator('.month-pick').last().click();
  check('Live December chapter navigation',await page.locator('#monthHeading').textContent()==='December');
  // A clean browser context tests opt-out without writing data to the user's browser.
  const privacy=await browser.newContext({viewport:{width:390,height:844}});
  await privacy.route(/google-analytics\\.com|googletagmanager\\.com/,r=>r.abort());
  const privatePage=await privacy.newPage();
  privatePage.on('dialog',d=>d.dismiss());
  await privatePage.goto(BASE+'#tyme-analytics-off',{waitUntil:'domcontentloaded'});
  const opt=await privatePage.evaluate(()=>({
    flag:window['ga-disable-G-Y46CQ8WRY5'],
    storage:localStorage.getItem('tyme_analytics_opt_out_v1')
  }));
  check('Live analytics browser opt-out',opt.flag===true&&opt.storage==='1',JSON.stringify(opt));
  await privacy.close();
  check('No uncaught live-page JavaScript exceptions',errors.length===0,JSON.stringify(errors));
  for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
    const violations=results.violations.map(v=>({id:v.id,impact:v.impact,count:v.nodes.length}));
    report.axe.push({width,violations});
    check('Live Axe accessibility '+width+'px: no serious or critical violations',
      violations.every(v=>v.impact!=='serious'&&v.impact!=='critical'),JSON.stringify(violations));
  }
}catch(e){check('Post-release browser QA execution',false,String(e.stack||e).slice(0,700));}
finally{
 if(browser) await browser.close();
 report.summary={passed:report.checks.filter(x=>x.passed).length,failed:report.checks.filter(x=>!x.passed).length};
 report.failures=report.checks.filter(x=>!x.passed);
 await writeFile('qa-results/postrelease/report.json',JSON.stringify(report,null,2));
 console.log('PRODUCTION SMOKE SUMMARY '+JSON.stringify(report.summary));
 if(report.summary.failed)process.exitCode=1;
}
