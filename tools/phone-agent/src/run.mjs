#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Adb, sleep } from './adb.mjs';
import { POSTERS, PKGS, postStaticImage, postCarousel } from './post.mjs';
import {
  readyToPost,
  loadItem,
  videoPathFor,
  staticImagePathFor,
  carouselSlidesFor,
  captionFor,
  titleFor,
  coverFor,
  markPosted,
  markDrafted,
  draftedItems,
} from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── tiny .env loader (no deps) ────────────────────────────────────────────────
async function loadEnv() {
  const p = join(__dirname, '..', '.env');
  if (!existsSync(p)) return;
  const txt = await readFile(p, 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (name) => process.argv.includes(`--${name}`);
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

/**
 * Reel-safety guard: refuse to post a landscape or over-length clip to a vertical
 * short-form platform. This is the hard backstop that would have stopped a 16:9
 * 4.5-minute long-form video from going out as a Reel. ffprobe-based; if ffprobe
 * is missing it fails OPEN (returns ok) so the guard never blocks a normal run.
 */
function reelGuard(videoPath, platform) {
  const reelPlatforms = new Set(['instagram', 'tiktok']);
  if (!reelPlatforms.has(platform)) return { ok: true };
  const maxSec = Number(process.env.REEL_MAX_SEC || 100);
  try {
    const out = execFileSync(
      process.env.FFPROBE_BIN || 'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'default=nw=1', videoPath],
      { encoding: 'utf8' },
    );
    const w = Number(/width=(\d+)/.exec(out)?.[1]);
    const h = Number(/height=(\d+)/.exec(out)?.[1]);
    const dur = Number(/duration=([\d.]+)/.exec(out)?.[1]);
    if (w && h && w > h) return { ok: false, reason: `video is landscape ${w}x${h} — not a vertical Reel (looks like long-form/16:9)` };
    if (dur && dur > maxSec) return { ok: false, reason: `video is ${Math.round(dur)}s — too long for a Reel (max ${maxSec}s). This looks like long-form.` };
    return { ok: true };
  } catch {
    return { ok: true }; // ffprobe unavailable → don't block
  }
}

async function pickDevice() {
  const devices = (await Adb.listDevices()).filter((d) => d.state === 'device');
  if (devices.length === 0)
    throw new Error('No authorized ADB device. Plug in + accept the USB-debugging prompt.');
  const want = arg('serial', process.env.PHONE_SERIAL);
  const dev = want ? devices.find((d) => d.serial === want) : devices[0];
  if (!dev)
    throw new Error(`Device ${want} not found. Connected: ${devices.map((d) => d.serial).join(', ')}`);
  return new Adb(dev.serial);
}

async function preflight(adb) {
  await adb.wake();
  await sleep(600);
  if (await adb.isLocked()) {
    const pin = process.env.DEVICE_PIN;
    if (!pin) throw new Error('Phone is locked. Set DEVICE_PIN in .env to auto-unlock, or unlock it manually.');
    console.log('phone locked — auto-unlocking…');
    if (!(await adb.unlock(pin)))
      throw new Error('Auto-unlock failed (wrong PIN, or the unlock flow changed). Unlock manually and re-run.');
    console.log('unlocked ✓');
  }
}

// Re-lock the screen after an unattended run (we auto-unlocked it).
async function relock(adb) {
  if (process.env.DEVICE_PIN && !has('no-lock')) {
    await adb.lockScreen();
    console.log('screen locked.');
  }
}

async function doctor() {
  console.log('— socheli phone-agent doctor —');
  const devices = await Adb.listDevices();
  console.log('devices:', devices.map((d) => `${d.serial}(${d.state})`).join(', ') || '(none)');
  const adb = await pickDevice();
  console.log('using:', adb.serial);
  console.log(
    'model:', (await adb.prop('ro.product.model')).trim(),
    '| android', (await adb.prop('ro.build.version.release')).trim(),
  );
  console.log('awake:', await adb.isAwake(), '| locked:', await adb.isLocked());
  for (const [name, pkg] of Object.entries(PKGS))
    console.log(`${name} installed:`, await adb.hasPackage(pkg));
  const ready = readyToPost();
  console.log(`store: ${ready.length} packaged item(s) with un-posted platforms`);
  for (const { item, targets } of ready.slice(0, 5))
    console.log(`  • ${item.id} [${item.channel}] → ${targets.join(', ')}`);
}

// One-off: post an arbitrary local video to one platform (manual smoke test).
async function testPost() {
  const video = arg('video');
  const platform = arg('platform', 'instagram');
  const caption = arg('caption') || 'Socheli phone-agent test';
  if (!video || video === true) throw new Error('Usage: test --video <path.mp4> [--platform instagram] [--caption "..."]');
  if (!existsSync(String(video))) throw new Error(`video not found: ${video}`);
  const poster = POSTERS[platform];
  if (!poster) throw new Error(`unsupported platform "${platform}" (${Object.keys(POSTERS).join(', ')})`);
  const adb = await pickDevice();
  await preflight(adb);
  if (!has('send')) {
    console.log(`[DRY RUN] would post ${video} → ${platform}. Add --send to actually post.`);
    return;
  }
  console.log(`Posting ${video} → ${platform}…`);
  const res = await poster(adb, { videoPath: String(video), caption: String(caption), id: 'test' });
  console.log(res.ok ? '✅ ' + res.reason : '❌ ' + res.reason);
}

/**
 * Post ONE store item to ONE platform. This is the call the Socheli engine
 * shells out to (publisher.ts → phone.ts). Emits a machine-readable result line
 * `PHONE_RESULT {json}` on stdout so the caller can parse status without
 * scraping logs. Marks the item published on success.
 */
async function postOne() {
  const id = arg('id');
  const platform = arg('platform');
  if (!id || id === true || !platform || platform === true)
    throw new Error('Usage: post --id <itemId> --platform <instagram|tiktok|youtube> [--caption-file <f>] [--send]');

  const item = loadItem(String(id));
  if (item.kind === 'longform' && platform !== 'youtube') {
    return emit({ ok: false, platform, reason: 'item is long-form (16:9 multi-chapter) — not postable as a Reel/TikTok' });
  }

  // Draft mode (save to the app's drafts instead of publishing). Only Instagram
  // is wired today; reject elsewhere rather than silently publishing.
  const draft = has('draft');
  if (draft && platform !== 'instagram')
    return emit({ ok: false, platform, reason: 'draft mode is only supported for Instagram' });

  // Caption: explicit file (engine passes the resolved per-platform caption) or
  // resolve it ourselves from the item's packaging.
  let caption = captionFor(item, platform);
  const capFile = arg('caption-file');
  if (capFile && capFile !== true && existsSync(String(capFile)))
    caption = await readFile(String(capFile), 'utf8');

  // ── Dispatch by content kind ──────────────────────────────────────────────

  // Static image post (kind="static_image"): bypass the video poster entirely.
  if (item.kind === 'static_image') {
    if (platform !== 'instagram')
      return emit({ ok: false, platform, reason: 'static_image posts are only supported on Instagram' });
    const imagePath = staticImagePathFor(item);
    if (!imagePath)
      return emit({ ok: false, platform, reason: 'no rendered image for this static_image item' });
    const adb = await pickDevice();
    await preflight(adb);
    if (!has('send')) {
      console.log(`[DRY RUN] would ${draft ? 'DRAFT' : 'post'} ${item.id} (static_image) → ${platform}: "${caption.slice(0, 60)}…"`);
      return emit({ ok: false, platform, reason: 'dry-run (no --send)' });
    }
    const res = await postStaticImage(adb, { imagePath, caption, id: item.id, draft });
    if (res.ok && !has('no-mark')) {
      if (draft) markDrafted(item, platform, { device: adb.serial });
      else markPosted(item, platform, { url: res.url });
    }
    await relock(adb);
    return emit({ ok: res.ok, platform, reason: res.reason, url: res.url, draft });
  }

  // Carousel post (kind="carousel"): multi-image IG carousel.
  if (item.kind === 'carousel') {
    if (platform !== 'instagram')
      return emit({ ok: false, platform, reason: 'carousel posts are only supported on Instagram' });
    const slides = carouselSlidesFor(item);
    if (!slides)
      return emit({ ok: false, platform, reason: 'no rendered slides for this carousel item' });
    const adb = await pickDevice();
    await preflight(adb);
    if (!has('send')) {
      console.log(`[DRY RUN] would ${draft ? 'DRAFT' : 'post'} ${item.id} (carousel, ${slides.length} slides) → ${platform}: "${caption.slice(0, 60)}…"`);
      return emit({ ok: false, platform, reason: 'dry-run (no --send)' });
    }
    const res = await postCarousel(adb, { imagePaths: slides, caption, id: item.id, draft });
    if (res.ok && !has('no-mark')) {
      if (draft) markDrafted(item, platform, { device: adb.serial });
      else markPosted(item, platform, { url: res.url });
    }
    await relock(adb);
    return emit({ ok: res.ok, platform, reason: res.reason, url: res.url, draft });
  }

  // ── Default: video (short / longform) ────────────────────────────────────
  const poster = POSTERS[platform];
  if (!poster) throw new Error(`unsupported platform "${platform}" for video post`);
  const videoPath = videoPathFor(item, platform);
  if (!videoPath || !existsSync(videoPath)) {
    return emit({ ok: false, platform, reason: 'no rendered video for this item' });
  }
  const guard = reelGuard(videoPath, platform);
  if (!guard.ok) return emit({ ok: false, platform, reason: guard.reason });
  const coverPath = coverFor(item); // designed thumbnail → applied as the cover

  const adb = await pickDevice();
  await preflight(adb);

  if (!has('send')) {
    console.log(`[DRY RUN] would ${draft ? 'DRAFT' : 'post'} ${item.id} → ${platform}: "${caption.slice(0, 60)}…"${coverPath ? ' [+cover]' : ''}`);
    return emit({ ok: false, platform, reason: 'dry-run (no --send)' });
  }

  const res = await poster(adb, {
    videoPath,
    caption,
    title: titleFor(item, platform),
    id: item.id,
    coverPath,
    draft,
  });
  // Record the outcome on the publish ledger (unless the engine owns it via
  // --no-mark): a live post → "published", a saved draft → "draft" (so the
  // dashboard Library can show it and reconcile against the device).
  if (res.ok && !has('no-mark')) {
    if (draft) markDrafted(item, platform, { device: adb.serial });
    else markPosted(item, platform, { url: res.url });
  }
  await relock(adb);
  return emit({ ok: res.ok, platform, reason: res.reason, url: res.url, draft });
}

/**
 * Capture the Instagram "Reels drafts" screen for visual verification.
 *
 * Why a screenshot and not a number: IG's create/drafts UI is SurfaceView/Compose,
 * so the draft rows, thumbnails and any "Manage (N)" count are NOT in the
 * accessibility tree — uiautomator returns inconsistent garbage (e.g. 5 nodes for
 * 4 drafts). Drafts also live in private app storage, unreadable over ADB without
 * root. So the DB (recorded at Save-Draft) is the source of truth; this just opens
 * the drafts screen and saves a screenshot so a human/agent can eyeball it.
 * Navigation is node-based where IG exposes nodes (Create sheet, Post, Drafts tab).
 * Returns the saved screenshot path, or null if it couldn't get there.
 */
async function captureDeviceDrafts(adb, outPath) {
  if (!(await adb.foregroundApp()).includes(PKGS.instagram)) {
    await adb.launch(PKGS.instagram);
    await sleep(3500);
  }
  // Open the create entry (node if exposed, else the top-left "+").
  const create = await adb.waitFor([{ desc: 'New post' }, { desc: 'Create' }, { idEndsWith: 'creation_tab' }], { timeout: 3000 });
  if (create) await adb.tapNode(create);
  else await adb.tapFrac(0.05, 0.05);
  await sleep(2500);
  await adb.tapWhen([{ text: 'OK' }], { timeout: 2000 }); // dismiss the "uninstall loses drafts" notice
  await adb.tapWhen([{ text: 'Post' }, { desc: 'Post' }], { timeout: 3000 }); // Create sheet → New post gallery
  await sleep(2500);
  const tab = await adb.waitFor([{ text: 'Drafts' }, { desc: 'Drafts' }], { timeout: 5000 });
  if (!tab) return null;
  await adb.tapNode(tab);
  await sleep(2500);
  await adb.screencapTo(outPath);
  await adb.key('KEYCODE_BACK');
  await sleep(700);
  await adb.key('KEYCODE_BACK');
  return outPath;
}

/**
 * Reconcile the draft list the DB believes exists with the connected device(s).
 * The DB is the source of truth (recorded when we Save-Draft); `--read-device`
 * additionally reads each phone's IG draft count to flag drift. Handles one or
 * many devices.
 */
async function drafts() {
  const platform = arg('platform', 'instagram');
  const all = draftedItems(platform);
  console.log(`DB: ${all.length} item(s) marked as ${platform} draft`);
  for (const it of all) {
    const e = (it.publish ?? []).find((x) => x.platform === platform && x.status === 'draft');
    console.log(`  • ${it.id} [${it.channel}] device=${e?.device ?? '?'} ${(it.pkg?.title ?? it.idea?.topic ?? '').slice(0, 48)}`);
  }
  const devices = (await Adb.listDevices()).filter((d) => d.state === 'device');
  console.log(`\nDevices: ${devices.length || '(none connected)'}`);
  for (const d of devices) {
    const dbForDevice = draftedItems(platform, d.serial).length;
    let shot = null;
    if (has('read-device')) {
      const adb = new Adb(d.serial);
      await preflight(adb);
      try { shot = await captureDeviceDrafts(adb, `/tmp/ig-drafts-${d.serial}.png`); } catch { /* best-effort */ }
      await relock(adb);
    }
    const note = !has('read-device')
      ? '(add --read-device to open the phone\'s drafts screen)'
      : shot
        ? `→ drafts screen captured: ${shot} (verify the count visually; IG drafts aren't machine-countable)`
        : '(could not open the drafts screen)';
    console.log(`  ${d.serial}: db=${dbForDevice}  ${note}`);
  }
}

function emit(result) {
  console.log(result.ok ? `✅ ${result.platform}: ${result.reason}` : `❌ ${result.platform}: ${result.reason}`);
  // single machine-readable line for the engine to parse
  console.log('PHONE_RESULT ' + JSON.stringify(result));
  if (!result.ok) process.exitCode = 2;
  return result;
}

/**
 * Autonomous lane: walk every packaged item with un-posted platforms and post
 * them, human-paced, one platform at a time. DRY RUN unless --send.
 */
async function publish() {
  const live = has('send');
  const only = arg('platform'); // optional: restrict to one platform
  const limit = Number(arg('limit', 10));
  const minDelay = Number(arg('min-delay', 40)) * 1000;
  const maxDelay = Number(arg('max-delay', 120)) * 1000;
  const platforms = only && only !== true ? [String(only)] : ['instagram', 'tiktok', 'youtube'];

  const adb = await pickDevice();
  await preflight(adb);

  const ready = readyToPost(platforms).slice(0, limit);
  // flatten to (item, platform) jobs
  const jobs = [];
  for (const { item, targets } of ready)
    for (const p of targets) if (platforms.includes(p)) jobs.push({ item, platform: p });

  console.log(`${jobs.length} post job(s)${live ? '' : '  [DRY RUN — add --send to actually post]'}`);
  if (!jobs.length) {
    console.log('Nothing to post. Package some runs first (status must be "packaged").');
    await relock(adb);
    return;
  }

  let posted = 0;
  for (const [i, job] of jobs.entries()) {
    const { item, platform } = job;
    const caption = captionFor(item, platform);
    console.log(`\n[${i + 1}/${jobs.length}] ${item.id} [${item.channel}] → ${platform} (${item.kind ?? 'short'}): ${caption.slice(0, 60).replace(/\s+/g, ' ')}…`);
    if (!live) { console.log('  (dry run) would post'); continue; }

    let res;
    if (item.kind === 'static_image') {
      if (platform !== 'instagram') {
        console.log('  ⏭  skip: static_image only supported on Instagram');
        continue;
      }
      const imagePath = staticImagePathFor(item);
      if (!imagePath) { console.log('  ⏭  skip: no rendered image'); continue; }
      res = await postStaticImage(adb, { imagePath, caption, id: item.id });
    } else if (item.kind === 'carousel') {
      if (platform !== 'instagram') {
        console.log('  ⏭  skip: carousel only supported on Instagram');
        continue;
      }
      const slides = carouselSlidesFor(item);
      if (!slides) { console.log('  ⏭  skip: no rendered slides'); continue; }
      res = await postCarousel(adb, { imagePaths: slides, caption, id: item.id });
    } else {
      // Default: video post.
      const videoPath = videoPathFor(item, platform);
      const guard = reelGuard(videoPath, platform);
      if (!guard.ok) { console.log('  ⏭  skip:', guard.reason); continue; }
      res = await POSTERS[platform](adb, { videoPath, caption, title: titleFor(item, platform), id: item.id, coverPath: coverFor(item) });
    }

    if (res.ok) {
      markPosted(item, platform, { url: res.url });
      posted++;
      console.log('  posted + marked');
    } else {
      console.log('  ', res.reason, '(left for retry)');
    }
    if (i < jobs.length - 1) {
      const d = rand(minDelay, maxDelay);
      console.log(`  …waiting ${Math.round(d / 1000)}s (human pace)`);
      await sleep(d);
    }
  }
  console.log(`\nDone. ${posted}/${jobs.length} posted.`);
  await relock(adb);
}

const cmd = process.argv[2];
await loadEnv();
try {
  if (cmd === 'doctor') await doctor();
  else if (cmd === 'test') await testPost();
  else if (cmd === 'post') await postOne();
  else if (cmd === 'publish') await publish();
  else if (cmd === 'drafts') await drafts();
  else {
    console.log('Usage: socheli-phone <doctor | post | publish | test>');
    console.log('  doctor                                       check device + store');
    console.log('  post --id <id> --platform <p> --send         post one item to one platform (engine entrypoint)');
    console.log('  post --id <id> --platform instagram --draft --send   save to IG drafts (designed cover applied)');
    console.log('  drafts [--read-device]                       reconcile DB draft list with the device(s)');
    console.log('  publish [--platform p] [--send]              post all packaged items (autonomous, human-paced)');
    console.log('  test --video <f> [--platform p] --send       post an arbitrary clip (smoke test)');
    console.log('  flags: --draft (IG drafts) · --no-mark (don\'t touch ledger) · --serial <s>');
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
