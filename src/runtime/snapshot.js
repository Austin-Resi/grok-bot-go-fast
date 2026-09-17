// From browser-use/jev-ultrafast (MIT). Atomic DOM snapshot with live node identity.
// opts: { goal?: string, topK?: number } — goal ranks offscreen candidates.
function (opts) {
  if (!document.body) return null;
  opts = opts || {};
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  // Overlay = modal dialog, or a fixed/sticky ancestor covering >=20% of the viewport
  // (cookie walls, donate banners). Controls inside are tagged so the policy can
  // dismiss before typing elsewhere; controls hidden under one are dropped entirely.
  const MODAL='dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const viewportArea=innerWidth*innerHeight, overlayCache=new Map();
  const overlayOf = e => {
    const path=[]; let found=null;
    for (let a=e.parentElement; a && a!==document.body; a=a.parentElement) {
      if (overlayCache.has(a)) { found=overlayCache.get(a); break; }
      path.push(a);
      if (a.matches(MODAL)) { found=a; break; }
      const pos=getComputedStyle(a).position;
      if (pos==='fixed' || pos==='sticky') {
        const r=a.getBoundingClientRect();
        if (r.width*r.height>=viewportArea*0.2) { found=a; break; }
      }
    }
    for (const a of path) overlayCache.set(a,found);
    return found;
  };
  const DISMISS=/^(close|dismiss|no,? thanks?|not now|maybe later|later|skip|got it|ok|okay|i already donated|already donated|continue without|reject( all)?|decline|accept( all)?|agree|[×✕✖x])\b/i;
  const isDismiss = (e,label) => DISMISS.test(label.trim()) ||
    /close|dismiss/i.test(e.getAttribute('aria-label')||'') || e.hasAttribute('data-dismiss') ||
    /(^|[\s_-])(close|dismiss)([\s_-]|$)/i.test(typeof e.className==='string' ? e.className : '');
  // Hit-test each line box, not the union bounding box: for an inline link that
  // wraps, the union's center usually lands on the paragraph between the lines.
  // Probe the center, then 25%/75% along the box for odd shapes. Returns the first
  // point that resolves to the element, or null if every on-screen box is covered.
  const hitPoint = e => {
    let onScreen=false;
    for (const r of e.getClientRects()) {
      if (r.width<=0 || r.height<=0) continue;
      const cy=r.y+r.height/2;
      if (cy<0 || cy>=innerHeight) continue;
      for (const f of [0.5,0.25,0.75]) {
        const x=r.x+r.width*f;
        if (x<0 || x>=innerWidth) continue;
        onScreen=true;
        const top=document.elementFromPoint(x,cy);
        if (top && e.contains(top)) return {x,y:cy,onScreen};
      }
    }
    return onScreen ? {covered:true} : null;
  };
  // Eyes ahead: interactive elements outside the viewport are indexed (no hit-test)
  // and ranked against the goal so the policy can pick a target it cannot see yet.
  // Execution scrolls the node into view and hit-tests before clicking.
  const CHROME='header,nav,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="menubar"],[role="tablist"]';
  const MAIN='main,[role="main"],article,#content,#main,#mw-content-text,.content,.main';
  const tokens = s => (s||'').toLowerCase().replace(/[_\-\/]+/g,' ').match(/[a-z0-9]{3,}/g) || [];
  const STOP=new Set(['the','and','for','with','from','into','then','that','this','via','when','until','stop','click',
    'open','find','page','pages','link','links','goal','use','get','navigate','reach','related','result','results',
    'about','article','following','follow','through','using','only','not','any','all','some','one','once','after',
    'before','visible','shown','show','see','look','which','where','what','there','here','them','they','its']);
  // Tokens of the current host ("wikipedia", "org") match every same-site href and carry no signal.
  const hostTokens=new Set(tokens(location.hostname));
  const goalTokens=new Set(tokens(opts.goal).filter(t=>!STOP.has(t) && !hostTokens.has(t)));
  const topK=Math.max(0,Math.min(120,opts.topK ?? 32));
  const candidates=[], candidateKeys=new Set();
  const hrefPath = href => { try { return new URL(href,location.href).pathname; } catch { return href; } };
  const indexOffscreen = (e,rname) => {
    if (!topK || !['link','button','tab','menuitem'].includes(rname)) return;
    let label=name(e); if (!label) return;
    label=label.replace(/\s+/g,' ').trim().slice(0,80);
    const href=e.getAttribute('href')||'';
    if (/^(#|mailto:|tel:)/i.test(href) && rname==='link') return;
    const path=href && !/^javascript:/i.test(href) ? hrefPath(href) : '';
    const key=label.toLowerCase()+'|'+path;
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    const inMain=!!e.closest(MAIN) && !e.closest(CHROME);
    const chrome=!!e.closest(CHROME);
    let score=0;
    const seen=new Set();
    for (const t of tokens(label+' '+decodeURIComponent(path))) {
      if (goalTokens.has(t) && !seen.has(t)) { seen.add(t); score+=4; }
    }
    if (inMain) score+=1; if (chrome) score-=2; if (rname==='link'||rname==='button') score+=0.5;
    const y=e.getBoundingClientRect().y+scrollY;
    candidates.push({e,rname,label,href,inMain,score,y});
  };
  const actions=[]; let covered=0;
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const rname=role(e);
    if (!rname) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const hit=hitPoint(e);
    if (!hit) { indexOffscreen(e,rname); continue; }
    if (hit.covered) { covered++; continue; }
    const r=e.getBoundingClientRect();
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    if (rname==='link') { const href=e.getAttribute('href'); if (href) base.href=href; }
    if (e.closest(MAIN) && !e.closest(CHROME)) base.main=true;
    const overlay=overlayOf(e);
    if (overlay) {
      base.overlay=identity(overlay);
      if (isDismiss(e,base.label)) base.dismiss=true;
    }
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  // Highest goal overlap first, then main content, then document order (top of page first).
  candidates.sort((a,b)=>b.score-a.score || (b.inMain-a.inMain) || a.y-b.y);
  const viewportBottom=scrollY+innerHeight;
  candidates.slice(0,topK).forEach((c,i)=>{
    const a={id:'o'+(i+1),node:identity(c.e),kind:'click',role:c.rname,label:c.label,value:'',
      offscreen:c.y>=viewportBottom?'below':'above',score:Math.round(c.score*10)/10};
    if (c.href) a.href=c.href; if (c.inMain) a.main=true;
    actions.push(a);
  });
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions,covered_actions:covered,
    indexed_candidates:candidates.length};
}
