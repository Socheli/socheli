#!/usr/bin/env python3
"""Generate DOC SOC-002/003/004 (+404) from one shared shell — same tokens as the
landing, sober treatment: one star divider, zero Caveat, zero other sketch."""
import os

SHELL_CSS = """
@font-face{font-family:"Inter";src:url(/assets/fonts/inter-var.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"JetBrains Mono";src:url(/assets/fonts/jbmono-400.woff2) format("woff2");font-weight:400;font-display:optional}
:root{color-scheme:dark;--bg:#0a0a0a;--surface:#101010;--rule:#1e1e1e;--border:rgba(236,230,216,.07);
--border-hi:rgba(236,230,216,.15);--ink-1:#ECE6D8;--ink-2:#B8B2A6;--ink-3:#87827A;--ink-4:#5C5851;
--sans:"Inter",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink-1);font:400 15px/1.7 var(--sans);letter-spacing:-.011em;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--ink-3)}
a:hover{text-decoration-color:var(--ink-1)}
:focus-visible{outline:1px solid var(--ink-1);outline-offset:2px}
.nav{position:sticky;top:0;height:64px;display:flex;align-items:center;background:rgba(10,10,10,.85);backdrop-filter:blur(12px);border-bottom:1px solid rgba(236,230,216,.06);z-index:10}
.nav-in{width:100%;max-width:1344px;margin:0 auto;padding:0 24px;display:flex;align-items:center;gap:24px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none}
.brand svg{width:22px;height:20px;color:var(--ink-1)}
.brand b{font:600 14px/1 var(--sans)}
.doc-id{font:400 11px/1 var(--mono);text-transform:uppercase;letter-spacing:.2em;color:var(--ink-4)}
.nav-links{margin-left:auto;display:flex;gap:22px;font-size:14px}
.nav-links a{text-decoration:none;color:var(--ink-2)}
main{max-width:64ch;margin:0 auto;padding:72px 24px 96px}
h1{font:600 32px/1.15 var(--sans);letter-spacing:-.022em;margin:8px 0 6px}
h2{font:600 18px/1.4 var(--sans);letter-spacing:-.012em;margin:40px 0 10px}
p,li{color:var(--ink-2);margin-bottom:12px}
ul,ol{padding-left:22px;margin-bottom:12px}
.eyebrow{font:400 12px/1 var(--mono);text-transform:uppercase;letter-spacing:.22em;color:var(--ink-3)}
.meta{font:400 12px/1.6 var(--mono);color:var(--ink-4);margin-bottom:40px}
table{width:100%;border-collapse:collapse;margin:16px 0 24px}
th{font:400 11px/1 var(--mono);text-transform:uppercase;letter-spacing:.16em;color:var(--ink-3);text-align:left;padding:0 12px 10px;border-bottom:1px solid var(--border-hi)}
td{padding:10px 12px;border-bottom:1px solid var(--rule);font-size:14px;color:var(--ink-2);vertical-align:top}
code{font:400 13px/1.6 var(--mono);background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:2px 7px}
pre{font:400 13px/1.7 var(--mono);background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:14px 16px;overflow-x:auto;margin:12px 0;color:var(--ink-1)}
.divider{display:flex;align-items:center;gap:14px;margin:48px 0;color:rgba(236,230,216,.32)}
.divider hr{flex:1;border:0;border-top:1px solid var(--rule)}
.divider svg{width:14px;height:13px;color:var(--ink-4)}
footer{border-top:1px solid var(--rule);padding:40px 24px}
.foot-in{max-width:1344px;margin:0 auto;display:flex;flex-wrap:wrap;gap:12px 28px;font-size:13px;color:var(--ink-3)}
.foot-in a{text-decoration:none;color:var(--ink-3)}
.foot-in a:hover{color:var(--ink-1)}
"""

STAR = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><symbol id="mk-clean" viewBox="0 0 110 100"><path fill="currentColor" d="M50 3 C55 32.5 66 44 86 47 L78.5 50 L86 53 C66 56 55 67.5 50 97 C45 67.5 32.5 55 3 50 C32.5 45 45 32.5 50 3 Z"/><path fill="currentColor" d="M91 50 L99 45.6 L107 50 L99 54.4 Z"/></symbol><symbol id="mk-glyph" viewBox="0 0 100 100"><path fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" d="M50.6 5.2 C54.8 31.7 67.2 44.6 94.8 49.6 C67.6 55.1 55.3 67 50.2 94.6 C45.4 67.4 32.6 55.2 5.6 50.4 C32.9 44.9 45.2 32.2 50.6 5.2 Z"/></symbol></defs></svg>'

DIVIDER = '<div class="divider" aria-hidden="true"><hr><svg><use href="#mk-glyph"/></svg><hr></div>'

def breadcrumb_ld(name, path):
    return ('<script type="application/ld+json">{"@context":"https://schema.org","@graph":['
            '{"@type":"WebPage","@id":"https://socheli.com%s#page","url":"https://socheli.com%s","name":"%s — Socheli","isPartOf":{"@id":"https://socheli.com/#website"}},'
            '{"@type":"BreadcrumbList","itemListElement":['
            '{"@type":"ListItem","position":1,"name":"Home","item":"https://socheli.com/"},'
            '{"@type":"ListItem","position":2,"name":"%s","item":"https://socheli.com%s"}]}'
            ']}</script>') % (path, path, name, name, path)

def page(doc_id, name, path, title, desc, body):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="https://socheli.com{path}">
<meta name="robots" content="max-image-preview:large, max-snippet:-1">
<meta name="theme-color" content="#0a0a0a">
<meta name="color-scheme" content="dark">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="https://socheli.com{path}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Socheli">
<meta property="og:image" content="https://socheli.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Socheli — one idea in, published video out.">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>{SHELL_CSS}</style>
{breadcrumb_ld(name, path)}
</head>
<body>
{STAR}
<header class="nav"><div class="nav-in">
  <a class="brand" href="/"><svg aria-hidden="true"><use href="#mk-clean"/></svg><b>SOCHELI</b></a>
  <span class="doc-id">{doc_id}</span>
  <nav class="nav-links" aria-label="Primary"><a href="/">Manual</a><a href="https://github.com/Socheli">GitHub</a></nav>
</div></header>
<main>
{body}
{DIVIDER}
<p class="meta">Questions about this document: <a href="mailto:contact@socheli.com">contact@socheli.com</a></p>
</main>
<footer><div class="foot-in">
  <a href="/">Home</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/data-deletion">Data Deletion</a><a href="https://github.com/Socheli">GitHub</a><span>© Socheli</span>
</div></footer>
</body>
</html>"""

PRIVACY = """
<p class="eyebrow">DOC SOC-002 · REV A</p>
<h1>Privacy Policy</h1>
<p class="meta">Effective 2026-06-11 · applies to socheli.com and the Socheli software</p>

<h2>1. Scope</h2>
<p>This policy covers two things: this website (socheli.com) and the Socheli software, the open-source social media manager you run on your own devices. They have very different privacy profiles, described separately below.</p>

<h2>2. Data this website collects</h2>
<p>None. This site sets no cookies, runs no analytics, and loads no trackers. You can verify this in your browser's network tab. The web server keeps standard, short-lived access logs (IP address and requested URL) for security and capacity purposes only; these are not used for profiling and are not shared.</p>

<h2>3. Data the software handles</h2>
<p>When you run Socheli on your own hardware, it stores everything it works with as flat JSON files and media on <em>your</em> devices:</p>
<ul>
<li><strong>OAuth tokens</strong> you grant for your own social accounts (for example, an Instagram access token), stored in local data files on your machine.</li>
<li><strong>Generated media</strong>: scripts, storyboards, and rendered videos, written to your disk.</li>
<li><strong>Run and mission records</strong>: pipeline logs, schedules, and engagement metrics, kept as flat JSON on your device.</li>
</ul>
<p>If you use a Socheli-hosted workspace (the optional cloud dashboard), the data you connect (account connections, schedules, and generated content metadata) is stored for your workspace and is deletable on request (see <a href="/data-deletion">Data Deletion</a>).</p>

<h2>4. Data we never hold</h2>
<p>Self-hosting is the default, and it means there is no Socheli cloud storing your content. We never hold your tokens, your media, your account credentials, or your audience data. The architecture is the policy.</p>

<h2>5. Third-party platforms</h2>
<p>When Socheli publishes to or reads from a platform (Meta/Instagram, Google/YouTube, TikTok), it does so through that platform's standard OAuth and official APIs, under your authorization, subject to that platform's own privacy policy. Socheli requests only the permissions needed for the features you enable, and you can revoke them at any time in the platform's settings.</p>
<p>Use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Use of Meta Platform data adheres to the <a href="https://developers.facebook.com/terms/">Meta Platform Terms</a>.</p>

<h2>6. Changes</h2>
<p>If this policy changes, the new version is published at this URL with an updated effective date. The document history is in the public repository.</p>

<h2>7. Contact</h2>
<p>For any privacy question or request: <a href="mailto:contact@socheli.com">contact@socheli.com</a>.</p>
"""

TERMS = """
<p class="eyebrow">DOC SOC-003 · REV A</p>
<h1>Terms of Service</h1>
<p class="meta">Effective 2026-06-11 · applies to socheli.com and the Socheli software</p>

<h2>1. The software</h2>
<p>Socheli's published packages (@socheli/cli, @socheli/sdk, @socheli/mcp, @socheli/api) are open source under the MIT license. The engine core opens with the public launch under an open-core model: free to self-host; optional commercial extensions and hosting are licensed separately. The license text governs; this page summarizes.</p>

<h2>2. Your responsibilities</h2>
<p>You run Socheli on your own devices, with your own accounts and your own API keys. You are responsible for:</p>
<ul>
<li>the content you generate and publish, and its compliance with applicable law;</li>
<li>compliance with the terms of service of every platform you connect (Meta, Google, TikTok, and others);</li>
<li>the security of your own machines, tokens, and keys.</li>
</ul>

<h2>3. The gates</h2>
<p>Socheli is built around human approval gates: publishing requires your explicit approval unless you deliberately enable an autonomous mission, and genome (brand memory) mutations require your approval. You operate the fleet; the software prepares work up to the gate.</p>

<h2>4. Acceptable use</h2>
<p>Don't use Socheli to spam, to deceive platforms or people, to violate others' rights, or to break the law. Automated posting may violate some platforms' terms; review them before enabling autonomous publishing on a given platform.</p>

<h2>5. Warranty disclaimer</h2>
<p>The software is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors be liable for any claim, damages or other liability arising from the use of the software. (This is the MIT license's own language; it governs.)</p>

<h2>6. Changes</h2>
<p>If these terms change, the new version is published at this URL with an updated effective date.</p>

<h2>7. Contact</h2>
<p><a href="mailto:contact@socheli.com">contact@socheli.com</a></p>
"""

DELETION = """
<p class="eyebrow">DOC SOC-004 · REV A</p>
<h1>Data Deletion</h1>
<p class="meta">Effective 2026-06-11 · how to delete all Socheli data, completely</p>

<h2>1. Data inventory</h2>
<table>
<tr><th>Data</th><th>Where it lives</th></tr>
<tr><td>OAuth tokens (Instagram, YouTube, TikTok)</td><td>flat JSON on your own device (self-host) or in your workspace (hosted)</td></tr>
<tr><td>Generated media (scripts, storyboards, videos)</td><td>your own disk</td></tr>
<tr><td>Run, mission, and schedule records</td><td>flat JSON on your own device or in your workspace</td></tr>
<tr><td>This website</td><td>nothing: no accounts, no analytics, no cookies</td></tr>
</table>

<h2>2. Deletion steps</h2>
<ol>
<li><strong>Revoke the app's platform access.</strong> Instagram: Settings &gt; Security &gt; Apps and websites &gt; remove Socheli. Facebook: Settings &gt; Apps and Websites &gt; remove. Google: <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> &gt; remove access. This immediately invalidates the stored tokens.</li>
<li><strong>Delete the local data.</strong> Self-hosted Socheli keeps everything under one folder. Deleting it removes all tokens, runs, schedules, and records:
<pre>rm -rf &lt;your-socheli-directory&gt;/data</pre>
Deletion is immediate and entirely under your control. There is no copy elsewhere.</li>
<li><strong>Hosted workspaces.</strong> If you use a Socheli-hosted workspace, email <a href="mailto:contact@socheli.com">contact@socheli.com</a> from the account's contact address with the subject "Data deletion request". We complete deletion of all workspace data, including connected-account tokens, within 30 days and confirm by reply.</li>
</ol>

<h2>3. Meta data deletion</h2>
<p>This page serves as Socheli's data deletion instructions URL for Meta platform integrations. Instagram data accessed by Socheli (account id, username, media metadata, comments, and messages, only for features you enable) is stored as described in section 1 and is removed by the steps above. Revoking the app in your Instagram settings stops all further access immediately.</p>

<h2>4. Data we never hold</h2>
<p>For self-hosted use there is no Socheli server holding your content: tokens, media, and records exist only on your own devices. Step 2 above is the complete deletion.</p>

<h2>5. Contact</h2>
<p><a href="mailto:contact@socheli.com">contact@socheli.com</a>. Deletion requests are answered within 30 days.</p>
"""

NOTFOUND = """
<p class="eyebrow" style="margin-top:48px">ERROR 404</p>
<h1>Page not in this document.</h1>
<p style="margin-top:8px">The section you asked for doesn't exist in SOC-001 or its annexes.</p>
<p><a href="/">Return to the manual →</a></p>
<div style="margin:64px 0;opacity:.35"><svg width="120" height="110" viewBox="0 0 112 102" fill="none" stroke="#ECE6D8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M50.4 4.2 C55 32.1 66.3 44.4 85.7 47.2 L78.9 50.1 L85.9 52.9 C66.1 56.2 55.2 67.4 50.1 95.7 C45.2 67.6 32.5 55.3 4.4 50.2 C32.7 44.8 45.1 32.4 50.4 4.2 Z"/><path d="M104.4 28.2 L109.1 25.7 L113.8 28 L109.3 30.4 Z" transform="translate(-8,14)"/></svg></div>
"""

os.makedirs("privacy", exist_ok=True)
os.makedirs("terms", exist_ok=True)
os.makedirs("data-deletion", exist_ok=True)

open("privacy/index.html", "w").write(page(
    "DOC SOC-002 · PRIVACY", "Privacy Policy", "/privacy",
    "Privacy Policy — Socheli",
    "How Socheli handles data: OAuth tokens and media live as flat JSON on your own devices. What we collect (nothing on this site), what we never hold, and how to reach us.",
    PRIVACY))
open("terms/index.html", "w").write(page(
    "DOC SOC-003 · TERMS", "Terms of Service", "/terms",
    "Terms of Service — Socheli",
    "Terms for using Socheli, the open-source autonomous content engine. License (MIT packages), acceptable use, and your responsibilities when publishing.",
    TERMS))
open("data-deletion/index.html", "w").write(page(
    "DOC SOC-004 · DATA DELETION", "Data Deletion", "/data-deletion",
    "Data Deletion — Socheli",
    "How to delete all Socheli data: numbered steps, the full data inventory (OAuth tokens, media, flat JSON on your devices), deletion timeline, and contact.",
    DELETION))
open("404.html", "w").write(page(
    "DOC SOC-001 · 404", "Not Found", "/404",
    "Page not found — Socheli",
    "This page is not in the document.",
    NOTFOUND))
print("wrote privacy/, terms/, data-deletion/, 404.html")
