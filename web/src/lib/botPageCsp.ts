// A page a Bot wrote (html_render, or an HTML file in its Library) is shown inside the app, and
// the Bot may have been told what to write by a web page it read. It may draw and run its own
// inline script, but it reaches nothing: no requests, no remote scripts, images or fonts, no
// forms. So it cannot send out what the user types into it, or load anything from this app with
// the user's cookie. The frame's sandbox and this app's own frame-src stop it navigating away.
export const BOT_PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

/**
 * The page with that policy as the first thing the parser sees, so nothing in the page runs or
 * loads before it and no markup of the page's own (a comment holding a fake <head>) can absorb it.
 * A page that had a doctype keeps standards mode.
 */
export function withBotPageCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${BOT_PAGE_CSP}">`;
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `<!doctype html>${meta}${html.slice(doctype[0].length)}` : meta + html.replace(/^\uFEFF/, "");
}
