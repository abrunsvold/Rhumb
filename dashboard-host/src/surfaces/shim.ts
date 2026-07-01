// Injected into served surface HTML. Attaches the surface's capability token as
// X-Rhumb-Surface-Token on same-origin /data/* fetch and XHR requests, so the
// data endpoint can identify the calling surface without trusting Referer.
export function renderShim(surfaceId: string, token: string): string {
  const T = JSON.stringify(token);
  const S = JSON.stringify(surfaceId);
  return (
    `<meta name="rhumb-surface-token" content=${JSON.stringify(token)}>` +
    `<script>(function(){` +
    `var T=${T},S=${S};` +
    `try{window.__RHUMB__={surfaceId:S,token:T};}catch(e){}` +
    `function d(u){try{var x=new URL(u,location.href);return x.origin===location.origin&&x.pathname.indexOf('/data/')===0;}catch(e){return false;}}` +
    `var f=window.fetch;` +
    `if(f){window.fetch=function(i,n){try{var u=(typeof i==='string')?i:(i&&i.url);if(d(u)){n=n||{};var h=new Headers(n.headers||(typeof i!=='string'&&i.headers)||{});h.set('X-Rhumb-Surface-Token',T);n.headers=h;}}catch(e){}return f.call(this,i,n);};}` +
    `var o=XMLHttpRequest.prototype.open,s=XMLHttpRequest.prototype.send;` +
    `XMLHttpRequest.prototype.open=function(m,u){this.__rd=d(u);return o.apply(this,arguments);};` +
    `XMLHttpRequest.prototype.send=function(b){if(this.__rd){try{this.setRequestHeader('X-Rhumb-Surface-Token',T);}catch(e){}}return s.apply(this,arguments);};` +
    `})();</script>`
  );
}

export function injectShim(html: string, markup: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag && htmlTag.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  return markup + html;
}
