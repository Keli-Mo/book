/* eslint-disable import/no-commonjs */
// 用户已同意的 Edge 受控布局验证；不连接用户录音/云端，不等同微信原生全流程。
const fs = require('fs');
const assert = require('node:assert/strict');
const path = require('path');
// 默认使用项目可解析的 Playwright；本机可通过 NODE_PATH 指向已安装运行时，无需另装依赖。
const { chromium } = require('playwright');
const { createUiPage, sampleRecording, settle } = require('./helpers/native-ui-fixtures.cjs');
const { readWxssWithImports } = require('./helpers/read-wxss.cjs');
const { byClass, elements } = require('./test-practice-book-route.cjs');

const root = path.resolve(__dirname,'..');
const stage = process.argv[2] || 'after';
const out = path.join(root,'.superpowers','sdd',`ipad-ui-${stage}`);
const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const styleText = value => typeof value==='string'?value:Object.entries(value||{}).map(([key,val])=>`${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}:${typeof val==='number'&&!['opacity','fontWeight','zIndex','flex'].includes(key)?val+'px':val}`).join(';');
function html(node) {
  if (Array.isArray(node)) return node.map(html).join('');
  if (node==null||typeof node==='boolean') return '';
  if (typeof node!=='object') return esc(node);
  const p=node.props||{};
  if (typeof node.type!=='string') return html(p.children);
  const tag={View:'view',Text:'text',Image:'img',Input:'input',Button:'button',ScrollView:'scroll-view'}[node.type]||node.type;
  const attrs=['className','src','placeholder','value','id','aria-label','data-ui-icon-size'].filter(k=>p[k]!=null).map(k=>`${k==='className'?'class':k}="${esc(p[k])}"`).join(' ');
  const extra=tag==='img'?`;object-fit:${p.mode==='aspectFill'?'cover':'contain'}`:tag==='scroll-view'?`;overflow-${p.scrollY?'y':'x'}:auto`:'';
  return `<${tag} ${attrs} style="${esc(styleText(p.style)+extra)}">${['input','img'].includes(tag)?'':html(p.children)+`</${tag}>`}`;
}
const cases=[['Home','recent'],['Home','empty'],['BookLibrary','all'],['BookLibrary','empty'],['Practice','idle'],['Practice','recording'],['Practice','paused'],['Practice','saved'],['Practice','save-failed'],['Practice','directory'],['Practice','error'],['CheckInDetail','local'],['CheckInDetail','playing'],['CheckInDetail','loading'],['CheckInDetail','error'],['CheckInDetail','shared'],['MyCheckIns','records'],['MyCheckIns','empty'],['MyCheckIns','offline'],['MyCheckIns','delete-pending']];
const textScaleCases=[['Home','recent',1.5],['Home','recent',2],['MyCheckIns','records',1.5],['MyCheckIns','records',2]];
async function surface(name,state,profile) {
  const item=sampleRecording('7');
  const shareId='b'.repeat(64);
  const sharedItem={...item,shareRequestId:'a'.repeat(32),share:{id:shareId,shareToken:'ui-test-token',expiresAtMs:Date.now()+30*86400000}};
  const options={profile,params:{},pendingItems:[]};
  if(name==='Home'&&state==='recent') options.history={version:1,bookId:'20',practiceIndex:0};
  if(name==='BookLibrary') options.params={series:'all'};
  if(name==='Practice') options.params={bookId:state==='error'?'missing-book':'3',practice:'0'};
  if(name==='Practice'&&state==='saved') options.savedFilePath='/ui-fixture/saved.mp3';
  if(name==='CheckInDetail') {
    options.params={localId:item.requestId};options.pendingItems=[state==='shared'?sharedItem:item];
    if(state==='error') options.pendingItems=[];
    if(state==='loading') options.overrides={'@/features/listeningPractice/pendingCheckInRuntime':{getPendingCheckInStore:()=>({list:()=>[],ready:()=>new Promise(()=>{})})}};
  }
  if(name==='MyCheckIns') {
    options.pendingItems=state==='empty'?[]:state==='delete-pending'?[sharedItem]:[item,sampleRecording('13'),sampleRecording('20')];
    if(state==='delete-pending') options.cloudRecords=[{...item.context,id:shareId,shareToken:'',status:'deletePending',durationMs:item.durationMs,createdAt:item.completedAtMs,expiresAtMs:1}];
    options.cloudError=state==='offline';
  }
  const app=createUiPage(name,options);
  try {
    app.render();app.show();await settle();let tree=app.render();
    if(name==='BookLibrary'&&state==='empty') {byClass(tree,'book-search__input').props.onInput({detail:{value:'zzzz-not-found'}});tree=app.render();}
    if(name==='Practice'&&['recording','paused','saved','save-failed'].includes(state)) {
      await byClass(tree,'record-button').props.onClick();app.recorderHandlers.Start();tree=app.render();
      if(['saved','save-failed'].includes(state)){
        const stop=elements(tree).find(node=>node.type==='Button'&&node.props.className?.includes('record-button--stop'));
        stop.props.onClick();
        await app.recorderHandlers.Stop({tempFilePath:'/ui-fixture/stopped.mp3',duration:12500,fileSize:60000});
        await settle();tree=app.render();
      }
      if(state==='paused'){byClass(tree,'record-button--pause').props.onClick();app.recorderHandlers.Pause();tree=app.render();}
    }
    if(name==='Practice'&&state==='directory'){byClass(tree,'practice-header__directory').props.onClick();tree=app.render();}
    if(name==='CheckInDetail'&&state==='playing'){await byClass(tree,'shared-recording__play').props.onClick();app.audios[0].currentTime=3;app.audios[0].trigger('TimeUpdate');tree=app.render();}
    // 防止场景设置失败却把普通首屏误报成已验证的录音/播放状态。
    if(name==='Practice'&&state==='saved') {
      assert.ok(byClass(tree,'check-in-button'),'已录完场景必须实际显示完成练习按钮');
      assert.match(html(tree),/已安全保存在本机/,'成功保存场景不能误用保存失败状态');
    }
    if(name==='Practice'&&state==='save-failed') assert.match(html(tree),/录音保存失败/,'存储失败场景必须实际显示失败与重试入口');
    if(name==='Practice'&&state==='paused') assert.ok(byClass(tree,'record-button--resume'),'暂停场景必须显示继续录音按钮');
    if(name==='CheckInDetail'&&state==='playing') assert.match(html(tree),/0:03/,'播放场景必须实际显示当前秒数');
    if(name==='CheckInDetail'&&state==='shared') assert.ok(byClass(tree,'shared-recording__repair'),'已分享本机录音必须显示分享修复入口');
    if(name==='MyCheckIns'&&state==='delete-pending') {
      const rendered=html(tree);
      assert.match(rendered,/待删除/,'云端待删录音必须显示待删除状态');
      assert.match(rendered,/重试/,'云端待删录音必须显示重试入口');
    }
    return html(tree);
  } finally {app.dispose();}
}
async function applyTextScale(page,scale) {
  if(scale===1) return;
  await page.evaluate(multiplier=>{
    // 先一次性快照，避免父元素放大后再读取子元素而发生继承倍率叠乘。
    const metrics=[...document.querySelectorAll('body *')].map(el=>{
      const style=getComputedStyle(el);
      return {el,fontSize:parseFloat(style.fontSize),lineHeight:parseFloat(style.lineHeight),pixelLineHeight:style.lineHeight.endsWith('px')};
    });
    for(const {el,fontSize,lineHeight,pixelLineHeight} of metrics){
      if(el.classList.contains('at-icon')) continue;
      if(Number.isFinite(fontSize)&&fontSize>0) el.style.setProperty('font-size',`${fontSize*multiplier}px`,'important');
      if(pixelLineHeight&&Number.isFinite(lineHeight)&&lineHeight>0) el.style.setProperty('line-height',`${lineHeight*multiplier}px`,'important');
    }
  },scale);
}
(async()=>{
  fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});const results=[];
  const bottomFocus=stage==='home-bottom';
  const profiles=stage==='before'?[[768,1024,true,0]]:bottomFocus?[[390,844,false,34]]:[[320,740,false,0],[390,844,false,34],[844,390,false,21],[768,1024,true,0],[1024,768,true,20],[1180,820,true,20],[375,700,true,0],[600,400,true,0]];
  try {for(const [width,height,isPad,safeAreaBottom] of profiles){
    const profile={windowWidth:width,windowHeight:height,isPad,orientation:width>height?'landscape':'portrait',isSplit:isPad&&width>=960&&height>=600,statusBarHeight:20,safeAreaBottom};
    const context=await browser.newContext({viewport:{width,height}});const page=await context.newPage();
    const scaledCases=(width===390&&height===844)||(width===1024&&height===768)?textScaleCases:[];
    const scenarios=bottomFocus?[['Home','recent',2]]:[...cases.map(([name,state])=>[name,state,1]),...scaledCases];
    for(const [name,state,textScale] of scenarios){
      const body=(await surface(name,state,profile)).replace(/(-?[\d.]+)rpx/g,(_,v)=>Number(v)*width/750+'px');
      // 加载实际构建产物，额外导航组件的样式由页面 bundle 自动收集。
      let css=['dist/app.wxss',`dist/pages/${name}/${name}.wxss`].map(f=>readWxssWithImports(path.join(root,f))).join('\n').replace(/(-?[\d.]+)rpx/g,(_,v)=>Number(v)*width/750+'px');
      // Edge 不具备微信设备安全区；显式模拟底部/横屏刘海 inset，保留原 constant 不支持行为。
      const sideInset=!isPad&&width>height?44:0;
      css=css.replace(/env\(safe-area-inset-(bottom|left|right|top)\)/g,(_,side)=>(side==='bottom'?safeAreaBottom:side==='top'?0:sideInset)+'px');
      await page.setContent(`<html><meta charset="utf-8"><style>html,body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif}view,scroll-view{display:block}text{display:inline}input{border:0;box-sizing:border-box;background:transparent}button{display:block;margin:0 auto;padding:0 14px;font-size:18px;line-height:2.555;text-align:center;border:0;box-sizing:border-box}img{display:block}scroll-view{scrollbar-width:none}</style><style>${css}</style><body>${body}</body></html>`,{waitUntil:'domcontentloaded'});
      await page.locator('img').evaluateAll(images=>Promise.all(images.map(img=>img.complete?null:new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;setTimeout(resolve,5000)}))));
      await applyTextScale(page,textScale);
      const measure=await page.evaluate(({name:surfaceName,state:surfaceState,textScale:fontScale,isPad:padSurface,statusBarHeight,safeAreaBottom:bottomInset,sideInset:notchInset})=>{
        const errors=[];const box=el=>el.getBoundingClientRect();const $=s=>document.querySelector(s);
        const overlaps=(first,second)=>{
          const a=box(first),b=box(second);
          return Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
        };
        const textIsClipped=el=>{
          const range=document.createRange();range.selectNodeContents(el);
          const textBox=range.getBoundingClientRect();
          if(textBox.left<-1||textBox.right>innerWidth+1||textBox.top<-1) return true;
          for(let ancestor=el;ancestor;ancestor=ancestor.parentElement){
            const style=getComputedStyle(ancestor);
            if(!['hidden','clip'].includes(style.overflowX)&&!['hidden','clip'].includes(style.overflowY)) continue;
            const clipBox=box(ancestor);
            if(textBox.left<clipBox.left-1||textBox.right>clipBox.right+1||textBox.top<clipBox.top-1||textBox.bottom>clipBox.bottom+1) return true;
          }
          return false;
        };
        const nav=$('.check-in-navigation');
        if(nav){
          if(Math.abs(box(nav).top)>1) errors.push('自定义导航未贴视口顶部');
          const back=$('.check-in-navigation__back'),home=$('.check-in-navigation__home');
          if(back&&box(back).top<statusBarHeight-1) errors.push('导航按钮侵入状态栏');
          if(back&&box(back).left<notchInset) errors.push('导航返回按钮侵入横屏刘海安全区');
          if(home&&box(home).right>window.innerWidth-100) errors.push('首页图标进入胶囊预留区');
          if(home){const s=getComputedStyle(home);if(s.boxShadow!=='none'||!['rgba(0, 0, 0, 0)','transparent'].includes(s.backgroundColor))errors.push('首页图标残留背景或阴影');}
        }
        if(document.documentElement.scrollWidth>window.innerWidth+1) errors.push('页面横向溢出');
        const content=$(surfaceName==='Home'?'.library-home__content':surfaceName==='BookLibrary'?'.book-library':surfaceName==='Practice'?'.practice-page, .practice-empty':surfaceName==='MyCheckIns'?'.my-check-ins':'.check-in-detail, .check-in-state');
        const padding=content?parseFloat(getComputedStyle(content).paddingLeft):null;
        if(content&&padding<10) errors.push('正文左右留白丢失');
        if(surfaceName==='Practice'){
          const shell=$('.practice-screen');
          const title=$('.check-in-navigation__title');
          if(!shell||!nav) errors.push('教材页缺少公共导航外壳');
          if(title?.textContent?.trim()!=='听力跟读训练') errors.push('教材导航标题错误');
          if(shell&&nav&&nav.parentElement!==shell) errors.push('教材导航未直接放在全宽外壳');
          if(nav&&(Math.abs(box(nav).left)>1||Math.abs(box(nav).width-window.innerWidth)>1)) errors.push('教材导航被正文留白或限宽挤压');
          if(content&&nav&&(content.contains(nav)||box(content).top<box(nav).bottom-1)) errors.push('教材正文与导航重叠');
        }
        if(surfaceName==='Home'){
          const homeNav=$('.library-home__navigation'),card=$('.continue-card');
          const title=$('.continue-card__title'),progress=$('.continue-card__progress'),button=$('.continue-card__button');
          if($('.library-home__heading')) errors.push('首页残留卡片上方独立标题');
          if(surfaceState==='empty'){
            if(title?.textContent?.trim()!=='开始跟读练习') errors.push('首页空态卡片标题错误');
            if(progress?.textContent?.trim()!=='还没有跟读记录，先去书库选择教材') errors.push('首页空态说明错误');
            if(button?.textContent?.trim()!=='选择教材') errors.push('首页空态按钮错误');
          }else if(button?.textContent?.trim()!=='继续跟读') errors.push('首页历史态按钮错误');
          if(homeNav&&card&&box(card).top<box(homeNav).bottom-1) errors.push('首页卡片侵入导航区');
          if(card&&title&&progress&&button){
            const cardBox=box(card),cardStyle=getComputedStyle(card);
            const inner={
              top:cardBox.top+parseFloat(cardStyle.paddingTop),
              right:cardBox.right-parseFloat(cardStyle.paddingRight),
              bottom:cardBox.bottom-parseFloat(cardStyle.paddingBottom),
              left:cardBox.left+parseFloat(cardStyle.paddingLeft),
            };
            const titleBox=box(title),progressBox=box(progress),buttonBox=box(button);
            if(titleBox.bottom>progressBox.top+1||progressBox.bottom>buttonBox.top+1) errors.push('首页卡片标题、说明或按钮重叠');
            for(const [label,item] of [['标题',titleBox],['说明',progressBox],['按钮',buttonBox]]){
              if(item.top<inner.top-1||item.right>inner.right+1||item.bottom>inner.bottom+1||item.left<inner.left-1) errors.push(`首页卡片${label}越过内边界`);
            }
          }
        }
        if(fontScale>1){
          const titleSelectors=surfaceName==='Home'?['.continue-card__title','.series-row__title']:surfaceName==='MyCheckIns'?['.check-in-list-card__section','.check-in-list-card__book']:[];
          for(const selector of titleSelectors){
            const titles=[...document.querySelectorAll(selector)];
            if(!titles.length) errors.push(`大字号标题缺失:${selector}`);
            for(const [index,title] of titles.entries()){
              if(title.scrollWidth>title.clientWidth+1||title.scrollHeight>title.clientHeight+1) errors.push(`大字号标题被截断:${selector}[${index}]`);
            }
          }
          const buttonSelector=surfaceName==='Home'?'.continue-card__button':surfaceName==='MyCheckIns'?'.check-in-list-card__actions button':null;
          if(buttonSelector){
            const buttons=[...document.querySelectorAll(buttonSelector)];
            if(!buttons.length) errors.push(`大字号卡片按钮缺失:${buttonSelector}`);
            for(const [index,button] of buttons.entries()){
              if(textIsClipped(button)) errors.push(`大字号卡片按钮内容被截断:${buttonSelector}[${index}]`);
            }
          }
          const cards=surfaceName==='Home'?[...document.querySelectorAll('.continue-card')]:surfaceName==='MyCheckIns'?[...document.querySelectorAll('.check-in-list-card')]:[];
          for(const [cardIndex,card] of cards.entries()){
            const ordered=surfaceName==='Home'?[card.querySelector('.continue-card__title'),card.querySelector('.continue-card__progress'),card.querySelector('.continue-card__button')]:[card.querySelector('.check-in-list-card__section'),card.querySelector('.check-in-list-card__book'),card.querySelector('.check-in-list-card__meta'),card.querySelector('.check-in-list-card__actions')];
            const visible=ordered.filter(Boolean);
            for(let index=0;index<visible.length-1;index++) if(overlaps(visible[index],visible[index+1])) errors.push(`大字号卡片内容重叠:${surfaceName}[${cardIndex}]`);
            const buttons=[...card.querySelectorAll('button')];
            for(let first=0;first<buttons.length;first++) for(let second=first+1;second<buttons.length;second++) if(overlaps(buttons[first],buttons[second])) errors.push(`大字号卡片按钮重叠:${surfaceName}[${cardIndex}]`);
          }
        }
        const largeIcons=[...document.querySelectorAll('.at-icon[data-ui-icon-size]')].filter(el=>Math.abs(parseFloat(getComputedStyle(el).fontSize)-Number(el.dataset.uiIconSize))>0.5);
        if(largeIcons.length) errors.push(`图标随屏宽放大:${largeIcons.length}`);
        const tab=$('.home-tabs');
        if(tab&&fontScale===1){if(parseFloat(getComputedStyle(tab).paddingBottom)<bottomInset)errors.push('底栏未预留模拟安全区');const end=box(tab).bottom-parseFloat(getComputedStyle(tab).paddingBottom);for(const el of document.querySelectorAll('.home-tabs__item > text:not(.at-icon)')) if(box(el).bottom>end+1) errors.push('底栏文字超出安全内容区');}
        const overflowingDeleteLabels=fontScale===1?[...document.querySelectorAll('.check-in-list-card__delete')].filter(el=>{
          const range=document.createRange();range.selectNodeContents(el);
          const textBox=range.getBoundingClientRect(),buttonBox=box(el),style=getComputedStyle(el);
          return textBox.left<buttonBox.left+parseFloat(style.paddingLeft)-0.5||textBox.right>buttonBox.right-parseFloat(style.paddingRight)+0.5;
        }):[];
        if(overflowingDeleteLabels.length) errors.push(`删除按钮文字越界:${overflowingDeleteLabels.length}`);
        const preview=$('.check-in-list-card__preview');if(padSurface&&preview&&box(preview).width>100) errors.push('Pad封面flex-basis仍随rpx放大');
        const empty=$('.my-check-ins-state__button');if(empty&&box(empty).bottom>window.innerHeight) errors.push('空态按钮首屏不可见');
        const sheet=$('.practice-directory-sheet');const scroll=$('.practice-directory-scroll');if(sheet&&scroll&&box(scroll).bottom>box(sheet).bottom-parseFloat(getComputedStyle(sheet).paddingBottom)+1) errors.push('目录滚动区越过面板底部');
        const targets=[...document.querySelectorAll('.device-touch-target')].filter(el=>box(el).width<43.9||box(el).height<43.9);if(targets.length)errors.push(`命中区不足44px:${targets.length}`);
        if([...document.images].some(el=>!el.naturalWidth))errors.push('教材图片未加载成功');
        return {errors,padding,largeIcons:largeIcons.map(el=>({name:el.className,size:getComputedStyle(el).fontSize})),previewWidth:preview?box(preview).width:null,missingImages:[...document.images].filter(el=>!el.naturalWidth).length};
      },{name,state,textScale,isPad,statusBarHeight:profile.statusBarHeight,safeAreaBottom,sideInset});
      const scaleSuffix=textScale===1?'':`-text-${Math.round(textScale*100)}`;
      const file=`${width}x${height}-${name}-${state}${scaleSuffix}.png`;await page.screenshot({path:path.join(out,file),fullPage:state!=='directory'});
      if(bottomFocus){
        await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
        await page.waitForTimeout(50);
        const bottomReachability=await page.evaluate(()=>{
          const rows=[...document.querySelectorAll('.series-row')],last=rows.at(-1),tab=document.querySelector('.home-tabs');
          if(!last||!tab) return {errors:['末个系列或固定底栏缺失']};
          const row=last.getBoundingClientRect(),bar=tab.getBoundingClientRect();
          const point={x:Math.max(0,Math.min(innerWidth-1,row.left+row.width/2)),y:Math.max(0,Math.min(innerHeight-1,row.top+row.height/2))};
          const hit=document.elementFromPoint(point.x,point.y);const errors=[];
          if(scrollY<1) errors.push('页面未实际滚动');
          if(row.top<0||row.bottom>bar.top+1) errors.push(`末个系列未完整停在底栏上方:${row.top.toFixed(1)}..${row.bottom.toFixed(1)}>${bar.top.toFixed(1)}`);
          if(row.width<43.9||row.height<43.9) errors.push(`末个系列命中区不足44px:${row.width.toFixed(1)}x${row.height.toFixed(1)}`);
          if(!hit||!(hit===last||last.contains(hit))) errors.push(`末个系列中心不可命中:${hit?.className||hit?.tagName||'none'}`);
          return {errors,scrollY,row:{top:row.top,bottom:row.bottom,width:row.width,height:row.height},tabTop:bar.top,hit:hit?.className||hit?.tagName||''};
        });
        measure.bottomReachability=bottomReachability;
        measure.errors.push(...bottomReachability.errors);
        await page.screenshot({path:path.join(out,`${width}x${height}-${name}-${state}${scaleSuffix}-bottom.png`),fullPage:false});
      }
      results.push({width,height,name,state,textScale,...measure,file});
    }
    await context.close();
  }}finally{fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(results,null,2));await browser.close();}
  const failed=results.filter(r=>r.errors.length);console.log(JSON.stringify({scenes:results.length,failed:failed.map(({width,name,state,errors})=>({width,name,state,errors}))},null,2));
  if(stage!=='before'&&failed.length)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
