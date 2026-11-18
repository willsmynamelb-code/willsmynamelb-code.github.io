// Branch-only, browser-based QA. Never contacts real analytics or makes a deployment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE = 'http://127.0.0.1:8765/';
const widths = [320, 360, 390, 768, 1024, 1440];
// Approved Figma node geometry, at identical CSS-pixel viewport widths.
const figma = {
  320: {copy:[24,115],cover:[50,840,220],factsY:1254},
  360: {copy:[24,115],cover:[70,811,220],factsY:1225},
  390: {copy:[24,124],cover:[85,738,220],factsY:1178},
  1440:{copy:[96,184],cover:[1016,200,300],factsY:860}
};
const near=(a,b)=>Math.abs(a-b)<=3;
const report = { branch: process.env.GITHUB_REF_NAME || 'local', checks: [], viewports: [], axe: [], pageErrors: [], consoleErrors: [], notes: [] };
const checks = (name, condition, details = '') => {
  report.checks.push({ name, pass: Boolean(condition), details });
  console.log((condition ? 'PASS' : 'FAIL') + ' ' + name + (details ? ' :: ' + details : ''));
};
const verify = async (name, task) => {
  try { const value = await task(); checks(name, Boolean(value), value === false ? 'false' : ''); }
  catch (error) { checks(name, false, String(error?.message || error)); }
};
await mkdir('qa-results', { recursive:true });
const server = spawn('python3', ['-m','http.server','8765','--bind','127.0.0.1'], { stdio:'ignore' });
let browser;
try {
  // Node's undici may intermittently assert when a server closes a readiness
  // socket. Let Chromium itself load the local page instead of using fetch.
  await delay(800);
  browser = await chromium.launch({ headless:true });
  const context = await browser.newContext({ viewport:{width:1440,height:900}, reducedMotion:'reduce' });
  // Avoid real third-party analytics requests during QA; leave application code unchanged.
  await context.route(/google-analytics\.com|googletagmanager\.com|facebook\.com|amazon\.com|doubleclick\.net/, route => route.abort());
  const page = await context.newPage();
  page.on('pageerror',error=>report.pageErrors.push(String(error.message)));
  page.on('console',msg=>{if(msg.type()==='error' && !/ERR_FAILED|google-analytics|googletagmanager/i.test(msg.text()))report.consoleErrors.push(msg.text());});
  page.on('dialog',dialog=>dialog.dismiss());
  for(const width of widths) {
    await page.setViewportSize({width,height:900});
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.hero-cover').waitFor({state:'visible'});
    // The lower book-cover image is intentionally lazy-loaded. Trigger its
    // fetch before verifying it, rather than treating lazy loading as a failure.
    await page.locator('.journey-cover img').scrollIntoViewIfNeeded();
    await page.locator('.journey-cover img').evaluate(img=>img.decode().catch(()=>{}));
    await page.evaluate(()=>window.scrollTo(0,0));
    const metrics=await page.evaluate(()=>{
      const hero=document.querySelector('.hero');
      const btns=[...document.querySelectorAll('.hero .action-row a, .reader-day-btn, .month-pick, #menuButton')]
        .filter(el=>getComputedStyle(el).display!=='none')
        .map(el=>({name:el.getAttribute('aria-label')||el.textContent.trim().slice(0,25),w:Math.round(el.getBoundingClientRect().width),h:Math.round(el.getBoundingClientRect().height)}));
      return {
        width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
        bodyWidth:document.body.scrollWidth,
        heroHeight:Math.round(hero.getBoundingClientRect().height),
        navHeight:Math.round(document.querySelector('.nav-wrap').getBoundingClientRect().height),
        heroCopy:(()=>{const r=document.querySelector('.hero-copy').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width)};})(),
        heroCover:(()=>{const r=document.querySelector('.hero-cover').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};})(),
        factsY:Math.round(document.querySelector('.quick-facts').getBoundingClientRect().y),
        headings:[...document.querySelectorAll('h1')].map(x=>x.textContent.trim()),
        coverLoaded:[...document.querySelectorAll('.hero-cover,.journey-cover img')].every(x=>x.complete && x.naturalWidth>0),
        svgLoaded:getComputedStyle(hero).backgroundImage.includes('illuminated-path-hero.svg'),
        fontLibre:document.fonts.check('400 20px "Libre Baskerville"'),
        fontInter:document.fonts.check('400 20px "Inter"'),
        actionableMinSize:btns.reduce((min,x)=>Math.min(min,x.w,x.h),Infinity),
        smallControls:btns.filter(x=>x.w<44||x.h<44),
        navMenuVisible:getComputedStyle(document.querySelector('#menuButton')).display!=='none'
      };
    });
    report.viewports.push(metrics);
    console.log('VIEWPORT METRICS '+JSON.stringify(metrics));
    checks(width+'px horizontal reflow',metrics.scrollWidth<=width+1,'scrollWidth '+metrics.scrollWidth);
    if(figma[width]) {
      const f=figma[width];
      const match=near(metrics.heroCopy.x,f.copy[0])&&near(metrics.heroCopy.y,f.copy[1])
        &&near(metrics.heroCover.x,f.cover[0])&&near(metrics.heroCover.y,f.cover[1])
        &&near(metrics.heroCover.w,f.cover[2])&&near(metrics.factsY,f.factsY);
      checks(width+'px approved Figma hero geometry within 3px',match,
        'copy '+JSON.stringify(metrics.heroCopy)+' cover '+JSON.stringify(metrics.heroCover)+' factsY '+metrics.factsY);
    }
    checks(width+'px original SVG background',metrics.svgLoaded);
    checks(width+'px authentic cover(s) loaded',metrics.coverLoaded);
    checks(width+'px primary controls min 44px',metrics.smallControls.length===0,JSON.stringify(metrics.smallControls));
    if(width===390 || width===1440) {
      await page.screenshot({path:'qa-results/homepage-'+width+'.png',fullPage:true,animations:'disabled'});
    } else {
      await page.locator('.hero').screenshot({path:'qa-results/hero-'+width+'.png',animations:'disabled'});
    }
  }
  checks('Approved literary display font available',report.viewports.every(x=>x.fontLibre));
  checks('Approved body font available',report.viewports.every(x=>x.fontInter));
  checks('Browser console has no uncaught JavaScript exceptions',report.pageErrors.length===0,JSON.stringify(report.pageErrors));

  await page.setViewportSize({width:390,height:844});
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await verify('Mobile menu begins collapsed',async()=>await page.locator('#menuButton').getAttribute('aria-expanded')==='false');
  await page.locator('#menuButton').click();
  await verify('Mobile menu opens and exposes links',async()=>await page.locator('#menuButton').getAttribute('aria-expanded')==='true' && await page.locator('#navLinks a[href="#resources"]').isVisible());
  await page.keyboard.press('Escape');
  await verify('Escape closes menu and restores focus',async()=>await page.locator('#menuButton').getAttribute('aria-expanded')==='false' && await page.locator('#menuButton').evaluate(el=>document.activeElement===el));
  await verify('Reader has exactly seven original day regions',async()=>await page.locator('[data-reader-day]').count()===7);
  await verify('Reader has exactly seven selectable day buttons',async()=>await page.locator('[data-reader-select]').count()===7);
  await verify('Reflection buttons include visible Jan X text in accessible name',async()=>await page.locator('.reader-day-btn').evaluateAll(btns=>btns.every(el=>el.getAttribute('aria-label')?.includes(el.textContent.trim()))));
  await verify('Day 1 initial state and disabled Previous',async()=>await page.locator('#reader-page').textContent()==='1 / 7' && await page.locator('#reader-prev').isDisabled());
  for(let day=1;day<=7;day++) {
    await page.locator('[data-reader-select="'+day+'"]').click();
    await verify('Day '+day+' selects only its own full reflection',async()=>{
      return await page.locator('#reader-page').textContent()===day+' / 7'
        && await page.locator('[data-reader-day="'+day+'"]').isVisible()
        && await page.locator('.reader-entry:visible').count()===1
        && await page.locator('[data-reader-select="'+day+'"]').getAttribute('aria-pressed')==='true'
        && await page.locator('[data-reader-day="'+day+'"] .reader-prompts .prompt-label').count()===3;
    });
  }
  await verify('Day 7 does not claim completion from page selection',async()=>{
    const finish=await page.locator('#reader-finish').textContent();
    return await page.locator('#reader-next').isDisabled() && /January 7 selected/.test(finish) && !/week is complete/i.test(finish);
  });
  await page.locator('#reader-prev').click();
  await verify('Previous day navigation',async()=>await page.locator('#reader-page').textContent()==='6 / 7');
  await page.locator('[data-reader-select="3"]').focus();
  await page.keyboard.press('ArrowRight');
  await verify('Keyboard ArrowRight selects next reflection',async()=>await page.locator('#reader-page').textContent()==='4 / 7');
  await page.keyboard.press('Home');
  await verify('Keyboard Home selects Jan 1',async()=>await page.locator('#reader-page').textContent()==='1 / 7');

  await verify('Twelve original month controls retained',async()=>await page.locator('.month-pick').count()===12);
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  for(let i=0;i<12;i++) {
    await page.locator('.month-pick').nth(i).click();
    await verify(months[i]+' selection updates correct month panel',async()=>{
      return await page.locator('#monthHeading').textContent()===months[i]
        && await page.locator('.month-pick').nth(i).getAttribute('aria-pressed')==='true';
    });
  }
  await page.locator('#monthNext').click();
  await verify('December Next wraps to January',async()=>await page.locator('#monthHeading').textContent()==='January');
  await page.locator('#monthPrev').click();
  await verify('January Previous wraps to December',async()=>await page.locator('#monthHeading').textContent()==='December');
  await page.locator('.month-pick').nth(5).focus();
  await page.keyboard.press('Home');
  await verify('Keyboard Home returns to January month',async()=>await page.locator('#monthHeading').textContent()==='January');

  const anchors=await page.locator('a[href^="#"]').evaluateAll(els=>els.map(el=>({href:el.getAttribute('href'),exists:!!document.getElementById(el.getAttribute('href').slice(1))})));
  checks('Every internal anchor points to an existing element',anchors.every(x=>x.exists),JSON.stringify(anchors.filter(x=>!x.exists)));
  const links=await page.locator('a[target="_blank"]').evaluateAll(els=>els.map(el=>({href:el.href,rel:el.rel})));
  checks('External new-tab links protect opener',links.every(x=>x.rel.includes('noopener')),JSON.stringify(links.filter(x=>!x.rel.includes('noopener'))));
  const preserved=await page.evaluate(()=>({
    original7:[...document.querySelectorAll('[data-reader-day]')].every(x=>x.querySelector('.body')&&x.querySelectorAll('.reader-prompts p').length===3),
    noPromptInputs:document.querySelectorAll('.reader-entry input,.reader-entry textarea').length===0,
    analyticsFlagInScript:document.documentElement.outerHTML.includes('tyme_analytics_opt_out_v1'),
    vision:document.querySelector('#vision')?.textContent.includes('My vision for'),
    resources:document.querySelector('#resources')?.querySelectorAll('a').length>=7,
    headings:document.querySelectorAll('h1').length===1
  }));
  for(const [k,v] of Object.entries(preserved)) checks('Preserve '+k,Boolean(v));

  // Isolated preview checks: keyboard reachability, reading-order integrity, and
  // larger text. These simulations are supplementary, not manual AT certification.
  await page.setViewportSize({width:390,height:844});
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await page.keyboard.press('Tab');
  const skipState=await page.locator('.skip-link').evaluate(el=>({
    focused:document.activeElement===el,
    visible:el.getBoundingClientRect().top>=0,
    focusVisible:el.matches(':focus-visible')
  }));
  checks('Keyboard first Tab exposes usable Skip to main content link',
    skipState.focused&&skipState.visible&&skipState.focusVisible,JSON.stringify(skipState));
  await page.keyboard.press('Enter');
  checks('Skip to main content actually moves focus to main',
    await page.locator('#main-content').evaluate(el=>document.activeElement===el));
  // The prompts must remain behind their approved reflection in DOM order;
  // never send any answers, and do not infer reading or completion from viewing.
  const readingOrder=await page.evaluate(()=>{
    const entries=[...document.querySelectorAll('[data-reader-day]')];
    return entries.every(entry=>{
      const body=entry.querySelector('.body');
      const prompts=entry.querySelector('.reader-prompts');
      const labels=prompts?[...prompts.querySelectorAll('.prompt-label')].map(x=>x.textContent.trim()):[];
      return !!body&&!!prompts&&body.compareDocumentPosition(prompts)&Node.DOCUMENT_POSITION_FOLLOWING
        && labels.length===3 && labels[0].includes('Practice')
        && labels[1].includes('Ask Yourself')
        && labels[2].includes('Carry This');
    });
  });
  checks('All seven reflection prompts follow full reflection text in reading order',Boolean(readingOrder));
  await page.locator('#menuButton').click();
  await page.screenshot({path:'qa-results/interactive-menu-open-390.png',animations:'disabled'});
  await page.keyboard.press('Escape');
  await page.locator('[data-reader-select="4"]').click();
  await page.locator('#readerDay4').scrollIntoViewIfNeeded();
  await page.screenshot({path:'qa-results/interactive-day4-390.png',animations:'disabled'});
  await page.locator('.month-pick[data-month="8"]').click();
  await page.locator('#monthPanel').scrollIntoViewIfNeeded();
  await page.screenshot({path:'qa-results/interactive-month9-390.png',animations:'disabled'});
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    // Text-only resizing is a valuable regression signal but is not the same
    // as native browser zoom, platform text enlargement or assistive technology.
    const scalable=await page.evaluate(()=>{
      document.documentElement.style.fontSize='32px';
      const offenders=[...document.querySelectorAll('body *')].filter(el=>{
        const st=getComputedStyle(el),r=el.getBoundingClientRect();
        return st.display!=='none' && r.width>0 && r.height>0 &&
          (r.right>window.innerWidth+2 || r.left< -2);
      }).slice(0,20).map(el=>({tag:el.tagName,cl:String(el.className).slice(0,90),
        text:(el.textContent||'').trim().slice(0,35),left:Math.round(el.getBoundingClientRect().left),
        right:Math.round(el.getBoundingClientRect().right)}));
      const overflowContainers=[...document.querySelectorAll('html,body,body *')].filter(el=>
        el.scrollWidth>el.clientWidth+3 && el.clientWidth>0).slice(0,35).map(el=>({
        tag:el.tagName,cl:String(el.className).slice(0,80),
        id:el.id,scroll:el.scrollWidth,client:el.clientWidth,
        overflow:getComputedStyle(el).overflowX}));
      return {horizontal:document.documentElement.scrollWidth>window.innerWidth+1,
        display:getComputedStyle(document.querySelector('h1')).fontFamily,
        documentWidth:document.documentElement.scrollWidth,viewport:window.innerWidth,
        bodyWidth:document.body.scrollWidth,offenders,overflowContainers};
    });
    checks('Text-only font scaling has no horizontal page overflow at '+width+'px',
      !scalable.horizontal,JSON.stringify(scalable));
    const monthButtonsFit=await page.locator('.month-actions .month-nav').evaluateAll(els=>
      els.every(el=>el.scrollWidth<=el.clientWidth+2));
    checks('Month navigation labels fit buttons at 200% text size, '+width+'px',monthButtonsFit);
    if(width===320 || width===390) await page.screenshot({path:'qa-results/text-scale-200-percent-'+width+'.png',
      fullPage:false,animations:'disabled'});
  }
  await page.evaluate(()=>document.documentElement.style.fontSize='');
  checks('Reduced-motion mode disables reader progress animation',
    await page.locator('#reader-progress-fill').evaluate(el=>
      parseFloat(getComputedStyle(el).transitionDuration)<=0.02));

  // One specific browser, no persistent account data or analytics traffic.
  const optoutContext=await browser.newContext({viewport:{width:390,height:844}});
  await optoutContext.route(/google-analytics\.com|googletagmanager\.com/,route=>route.abort());
  const optPage=await optoutContext.newPage();
  optPage.on('dialog',dialog=>dialog.dismiss());
  await optPage.goto(BASE+'#tyme-analytics-off',{waitUntil:'domcontentloaded'});
  const opted=await optPage.evaluate(()=>({flag:window['ga-disable-G-Y46CQ8WRY5'],saved:localStorage.getItem('tyme_analytics_opt_out_v1')}));
  checks('Analytics opt-out blocks tracking in browser',opted.flag===true && opted.saved==='1',JSON.stringify(opted));
  // The public opt-out page's re-enable link navigates to the homepage.
  // Test that real cross-document flow, not a same-document fragment jump.
  await optPage.goto(BASE+'analytics-off.html',{waitUntil:'domcontentloaded'});
  await optPage.goto(BASE+'#tyme-analytics-on',{waitUntil:'domcontentloaded'});
  const optedBack=await optPage.evaluate(()=>({flag:window['ga-disable-G-Y46CQ8WRY5'],saved:localStorage.getItem('tyme_analytics_opt_out_v1')}));
  checks('Analytics re-enable reverses browser flag',optedBack.flag===false && optedBack.saved===null,JSON.stringify(optedBack));
  await optoutContext.close();

  // Audit a representative mobile and desktop page. Axe is a supplementary
  // signal, not WCAG certification; report both existing and introduced risks.
  for(const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:900});
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    const scan=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
    const violations=scan.violations.map(v=>({id:v.id,impact:v.impact,count:v.nodes.length,description:v.help,targets:v.nodes.slice(0,5).map(n=>n.target.join(' '))}));
    report.axe.push({width,violations,incomplete:scan.incomplete.length,passes:scan.passes.length});
    console.log('AXE '+width+' '+JSON.stringify(violations));
    checks('Axe '+width+'px no serious or critical violations',!violations.some(v=>v.impact==='critical'||v.impact==='serious'));
  }
} catch(error) {
  report.notes.push('Browser QA fatal: '+String(error.stack||error));
  checks('Browser QA execution completes',false,String(error.message||error));
} finally {
  if(browser) await browser.close();
  server.kill('SIGTERM');
  const passed=report.checks.filter(x=>x.pass).length;
  const failed=report.checks.filter(x=>!x.pass);
  report.summary={passed,failed:failed.length,total:report.checks.length,failures:failed};
  await writeFile('qa-results/report.json',JSON.stringify(report,null,2));
  console.log('QA SUMMARY '+JSON.stringify(report.summary));
  if(failed.length) process.exitCode=1;
}
