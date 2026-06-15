import { sleep } from './adb.mjs';

/**
 * Posting flows that drive the real social apps to publish a finished Socheli
 * video. The shape mirrors the MoltJobs outreach senders, but the verb is
 * "post a Reel/Short/clip" instead of "send a DM": push the rendered file onto
 * the phone, hand it to the app via an ACTION_SEND share intent (which preloads
 * the video), then walk the create UI — caption field, then the post button.
 *
 * UI element ids drift across app versions, so every step uses ordered
 * candidate specs (resource-id → text → content-desc) and polls with waitFor().
 * Returns { ok, reason, url? }. Honest about what it can't do rather than
 * forcing a tap into the void.
 */

export const PKGS = {
  instagram: 'com.instagram.android',
  tiktok: 'com.zhiliaoapp.musically',
  youtube: 'com.google.android.youtube',
};

// Well-known share handlers — landing directly here skips the system chooser.
const SHARE_ACTIVITIES = {
  instagram: 'com.instagram.android/com.instagram.share.handleractivity.ShareHandlerActivity',
  // TikTok + YouTube share handlers move between builds; fall back to -p <pkg>
  // which lets the app resolve its own SEND receiver.
};

/** Push the file to the gallery and resolve a content:// URI for sharing. */
async function stage(adb, videoPath, id) {
  const remote = await adb.pushMedia(videoPath, `${id || 'socheli'}.mp4`);
  const uri = await adb.contentUriFor(remote);
  return { remote, uri };
}

/** Open the target app's composer with the video preloaded. */
async function handOff(adb, platform, uri) {
  const ok = await adb.shareVideoTo({
    contentUri: uri,
    pkg: PKGS[platform],
    targetActivity: SHARE_ACTIVITIES[platform],
  });
  await sleep(5000); // app cold-start + video import
  return ok;
}

/** Dismiss IG's occasional "Video posts are now shared as reels" interstitial. */
async function dismissReelsNotice(adb) {
  await adb.tapWhen([{ text: 'OK' }, { text: 'Continue' }], { timeout: 3500 });
}

/**
 * Advance the reel editor to the share/details screen. Newer IG has a single
 * "Next" (editor → details, where the cover lives inline); older builds had two
 * (trim, then cover). Tap Next until the share screen's markers appear.
 */
async function advanceToShare(adb) {
  const onShare = () =>
    adb.findAny([{ text: 'Share' }, { text: 'Save Draft' }, { idEndsWith: 'share_footer_button' }]);
  for (let i = 0; i < 4; i++) {
    if (await onShare()) return true;
    const next = await adb.waitFor(
      [
        { idEndsWith: 'clips_right_action_button' }, // reel editor "Next" (desc, not text)
        { idEndsWith: 'next_button_textview' },
        { idEndsWith: 'creation_next_button' },
        { desc: 'Next' },
        { text: 'Next' },
      ],
      { timeout: 7000 },
    );
    if (next) {
      await adb.tapNode(next);
      await sleep(3500);
      continue;
    }
    // No Next found — IG frequently covers it with a bottom-sheet promo
    // ("Level up your videos with Edits"/Get app) that isn't in the a11y tree.
    // Swipe the sheet down to dismiss it, then retry.
    const { w, h } = await adb.size();
    await adb.shell(`input swipe ${Math.round(w * 0.5)} ${Math.round(h * 0.8)} ${Math.round(w * 0.5)} ${Math.round(h * 0.98)} 250`);
    await sleep(1500);
  }
  return !!(await onShare());
}

/**
 * Apply the designed cover via Edit cover → Add from camera roll → newest photo
 * → Finished. The cover image must already be pushed to the gallery (newest, so
 * it's the top-left cell). "Edit cover" is painted on a SurfaceView and is NOT
 * in the a11y tree, so it's tapped by screen fraction (bottom-centre of the
 * cover thumbnail); every other step is matched by node. Returns true on success
 * — best-effort, the caller continues with IG's default frame on failure.
 */
async function setCoverFromRoll(adb) {
  await adb.tapFrac(0.5, 0.4); // "Edit cover" label on the thumbnail
  await sleep(2500);
  const add = await adb.waitFor(
    [{ text: 'Add from camera roll' }, { desc: 'Add from camera roll' }, { contains: 'camera roll' }],
    { timeout: 6000 },
  );
  if (!add) return false;
  await adb.tapNode(add);
  await sleep(2500);
  // first gallery cell = most-recently-added = the cover we just pushed
  const cell = await adb.waitFor([{ idEndsWith: 'gallery_image' }, { idEndsWith: 'gallery_grid_item' }], {
    timeout: 6000,
  });
  if (!cell) return false;
  await adb.tapNode(cell);
  await sleep(2500);
  const fin = await adb.waitFor([{ text: 'Finished' }, { desc: 'Finished' }, { text: 'Done' }], {
    timeout: 6000,
  });
  if (fin) {
    await adb.tapNode(fin);
    await sleep(2000);
  }
  return true;
}

/** Tap the caption field (node when exposed, else fraction) and type the text. */
async function typeCaption(adb, caption) {
  if (!caption) return;
  const cap = await adb.waitFor(
    [
      { idEndsWith: 'caption_input_text_view' },
      { idEndsWith: 'caption_text_view' },
      { contains: 'caption' },
    ],
    { timeout: 6000 },
  );
  if (cap) await adb.tapNode(cap);
  else await adb.tapFrac(0.5, 0.475); // caption is a custom view in newer IG
  await sleep(900);
  await adb.type(caption);
  await sleep(600);
  await adb.key('KEYCODE_BACK'); // dismiss hashtag suggestions
  await sleep(500);
  await adb.key('KEYCODE_BACK'); // dismiss keyboard
  await sleep(700);
}

/* ── Instagram Reels ───────────────────────────────────────────────────────
   Share sheet → (pick "Reel" if asked) → Next → [cover from camera roll] →
   caption → Share / Save Draft. `coverPath` applies the designed thumbnail;
   `draft:true` saves to drafts instead of publishing. */
export async function postInstagram(adb, { videoPath, caption, id, coverPath, draft }) {
  const { remote, uri } = await stage(adb, videoPath, id);
  if (!uri) return { ok: false, reason: 'could not register video with MediaStore' };
  // Push the cover LAST so it's the newest gallery item → top-left in the picker.
  let coverRemote;
  if (coverPath) {
    try {
      coverRemote = await adb.pushMedia(coverPath, `${id || 'socheli'}_cover.jpg`);
    } catch {
      /* non-fatal: fall back to IG's default frame */
    }
  }
  try {
    if (!(await handOff(adb, 'instagram', uri)))
      return { ok: false, reason: 'share intent not dispatched' };
    if (!(await adb.foregroundApp()).includes(PKGS.instagram))
      return { ok: false, reason: 'Instagram did not open from share intent' };

    await dismissReelsNotice(adb);
    // Instagram sometimes asks "Reel / Post / Story" before the editor.
    await adb.tapWhen([{ text: 'Reel' }, { text: 'Reels' }, { desc: 'Reel' }], { timeout: 4000 });

    if (!(await advanceToShare(adb)))
      return { ok: false, reason: 'could not reach the reel share screen' };

    let coverApplied = false;
    if (coverRemote) {
      coverApplied = await setCoverFromRoll(adb);
      if (!coverApplied) console.error('  cover: could not set custom cover — using IG default frame');
    }

    await typeCaption(adb, caption);

    if (draft) {
      const sd = await adb.waitFor(
        [{ text: 'Save Draft' }, { desc: 'Save Draft' }, { contains: 'save draft' }],
        { timeout: 9000 },
      );
      if (!(await adb.tapNode(sd))) return { ok: false, reason: 'Save Draft button not found' };
      await sleep(3000);
      return { ok: true, reason: `saved to Instagram drafts${coverApplied ? ' (with cover)' : ''}` };
    }

    const share = await adb.waitFor(
      [
        { idEndsWith: 'share_footer_button' },
        { idEndsWith: 'share_button' },
        { text: 'Share' },
        { desc: 'Share' },
      ],
      { timeout: 9000 },
    );
    if (!(await adb.tapNode(share)))
      return { ok: false, reason: 'Instagram Share button not found' };
    await sleep(4000);
    return { ok: true, reason: `posted to Instagram Reels${coverApplied ? ' (with cover)' : ''}` };
  } finally {
    await adb.removeMedia(remote);
    if (coverRemote) await adb.removeMedia(coverRemote);
  }
}

/* ── TikTok ────────────────────────────────────────────────────────────────
   Share sheet → upload/edit → Next → caption → Post. */
export async function postTikTok(adb, { videoPath, caption, id }) {
  const { remote, uri } = await stage(adb, videoPath, id);
  if (!uri) return { ok: false, reason: 'could not register video with MediaStore' };
  try {
    if (!(await handOff(adb, 'tiktok', uri)))
      return { ok: false, reason: 'share intent not dispatched' };
    if (!(await adb.foregroundApp()).includes(PKGS.tiktok))
      return { ok: false, reason: 'TikTok did not open from share intent' };

    // TikTok opens the editor; advance to the post screen.
    await adb.tapWhen([{ text: 'Next' }, { desc: 'Next' }], { timeout: 9000 });
    await sleep(3500);
    // Some builds have a second Next (effects → post).
    await adb.tapWhen([{ text: 'Next' }, { desc: 'Next' }], { timeout: 4000 });
    await sleep(2500);

    const cap = await adb.waitFor(
      [
        { idEndsWith: 'caption_edit_text' },
        { contains: 'caption' },
        { cls: 'EditText' },
      ],
      { timeout: 9000 },
    );
    if (cap) {
      await adb.tapNode(cap);
      await sleep(800);
      await adb.type(caption);
      await sleep(600);
      await adb.key('KEYCODE_BACK');
      await sleep(800);
    }

    const post = await adb.waitFor(
      [{ text: 'Post' }, { desc: 'Post' }, { contains: 'publish' }],
      { timeout: 9000 },
    );
    if (!(await adb.tapNode(post)))
      return { ok: false, reason: 'TikTok Post button not found' };
    await sleep(5000);
    return { ok: true, reason: 'posted to TikTok' };
  } finally {
    await adb.removeMedia(remote);
  }
}

/* ── YouTube Shorts ──────────────────────────────────────────────────────────
   Share sheet → "Edit into a Short" / upload → title (from caption) → Upload. */
export async function postYouTube(adb, { videoPath, caption, title, id }) {
  const { remote, uri } = await stage(adb, videoPath, id);
  if (!uri) return { ok: false, reason: 'could not register video with MediaStore' };
  try {
    if (!(await handOff(adb, 'youtube', uri)))
      return { ok: false, reason: 'share intent not dispatched' };
    if (!(await adb.foregroundApp()).includes(PKGS.youtube))
      return { ok: false, reason: 'YouTube did not open from share intent' };

    // YouTube may offer "Edit into a Short" vs "Upload video" — take the upload
    // path so the 9:16 master posts as-is.
    await adb.tapWhen(
      [{ text: 'Upload video' }, { text: 'Next' }, { desc: 'Next' }],
      { timeout: 9000 },
    );
    await sleep(3500);

    // Title field.
    const titleField = await adb.waitFor(
      [
        { idEndsWith: 'title_edit' },
        { contains: 'title' },
        { cls: 'EditText' },
      ],
      { timeout: 9000 },
    );
    if (titleField) {
      await adb.tapNode(titleField);
      await sleep(600);
      await adb.type((title || caption || 'Short').slice(0, 95));
      await sleep(500);
      await adb.key('KEYCODE_BACK');
      await sleep(700);
    }

    const upload = await adb.waitFor(
      [{ text: 'Upload' }, { text: 'Next' }, { text: 'Done' }, { desc: 'Upload' }],
      { timeout: 9000 },
    );
    if (!(await adb.tapNode(upload)))
      return { ok: false, reason: 'YouTube Upload button not found' };
    await sleep(5000);
    return { ok: true, reason: 'uploaded to YouTube' };
  } finally {
    await adb.removeMedia(remote);
  }
}

/* ── Instagram Static Image Post ───────────────────────────────────────────────
   Push one image to the device, open IG → + → POST tab (not Reel), select the
   image from the gallery, advance through the filter screen, add caption, then
   Share (or Save Draft). `coverPath` is ignored for images — IG doesn't offer
   a custom cover/thumbnail on photo posts.

   IG create-flow tabs (2024+): the bottom-sheet after tapping + shows
   "Post | Story | Reel | Live" as text nodes. We tap "Post" to land in the photo
   gallery picker (which is SurfaceView on Xiaomi, so we fall back to tapping the
   top-left gallery cell by screen fraction when nodes are absent). */
export async function postStaticImage(adb, { imagePath, caption, id, draft = false }) {
  let remote;
  try {
    // 1. Push image to device gallery.
    const fname = `${id || 'socheli'}_img.jpg`;
    remote = await adb.pushImage(imagePath, fname);
    const uri = await adb.imageContentUriFor(remote);
    if (!uri) return { ok: false, reason: 'could not register image with MediaStore' };

    // 2. Share the image into IG so it pre-selects in the composer.
    const ok = await adb.shareImageTo({
      contentUri: uri,
      pkg: PKGS.instagram,
      targetActivity: SHARE_ACTIVITIES.instagram,
      mimeType: 'image/jpeg',
    });
    if (!ok) return { ok: false, reason: 'share intent not dispatched' };
    await sleep(5000);

    if (!(await adb.foregroundApp()).includes(PKGS.instagram))
      return { ok: false, reason: 'Instagram did not open from share intent' };

    // 3. IG may ask which composer type. Tap "Post" (not Reel/Story).
    await adb.tapWhen(
      [{ text: 'Post' }, { desc: 'Post' }, { contains: 'new post' }],
      { timeout: 5000 },
    );
    await sleep(2000);

    // 4. IG gallery picker: the image we pushed is the newest item → top-left
    // cell. It may be pre-selected already (because we shared via intent). If we
    // see a "Next" already available, we're past the picker. Otherwise tap the
    // first gallery cell. On Xiaomi the gallery is a SurfaceView — fall back to
    // screen fraction (top-left of the grid region ≈ 0.17, 0.42).
    const onNextOrFilter = () =>
      adb.findAny([
        { text: 'Next' },
        { desc: 'Next' },
        { idEndsWith: 'next_button_textview' },
        { idEndsWith: 'creation_next_button' },
        { text: 'Filter' },
        { idEndsWith: 'filter_tab' },
      ]);
    if (!(await onNextOrFilter())) {
      // Not yet on the share screen — try to tap the gallery cell node first.
      const cell = await adb.waitFor(
        [{ idEndsWith: 'gallery_image' }, { idEndsWith: 'gallery_grid_item' }, { idEndsWith: 'image_thumbnail' }],
        { timeout: 4000 },
      );
      if (cell) await adb.tapNode(cell);
      else await adb.tapFrac(0.17, 0.42); // SurfaceView fallback: first grid cell
      await sleep(2000);
    }

    // 5. Advance through IG's photo editor (Filter → Next, or straight to Next).
    // IG photo editor has up to two Next taps: gallery → filter, filter → details.
    for (let i = 0; i < 3; i++) {
      const onShare = () =>
        adb.findAny([
          { text: 'Share' },
          { text: 'Save Draft' },
          { idEndsWith: 'share_footer_button' },
        ]);
      if (await onShare()) break;
      const next = await adb.waitFor(
        [
          { idEndsWith: 'next_button_textview' },
          { idEndsWith: 'creation_next_button' },
          { desc: 'Next' },
          { text: 'Next' },
        ],
        { timeout: 7000 },
      );
      if (!next) {
        // Possible bottom-sheet promo — dismiss with a downward swipe.
        const { w, h } = await adb.size();
        await adb.shell(`input swipe ${Math.round(w * 0.5)} ${Math.round(h * 0.8)} ${Math.round(w * 0.5)} ${Math.round(h * 0.98)} 250`);
        await sleep(1500);
        continue;
      }
      await adb.tapNode(next);
      await sleep(3000);
    }

    // 6. Caption + post/draft.
    await typeCaption(adb, caption);

    if (draft) {
      const sd = await adb.waitFor(
        [{ text: 'Save Draft' }, { desc: 'Save Draft' }, { contains: 'save draft' }],
        { timeout: 9000 },
      );
      if (!(await adb.tapNode(sd))) return { ok: false, reason: 'Save Draft button not found' };
      await sleep(3000);
      return { ok: true, reason: 'saved to Instagram drafts (static image)' };
    }

    const share = await adb.waitFor(
      [
        { idEndsWith: 'share_footer_button' },
        { idEndsWith: 'share_button' },
        { text: 'Share' },
        { desc: 'Share' },
      ],
      { timeout: 9000 },
    );
    if (!(await adb.tapNode(share)))
      return { ok: false, reason: 'Instagram Share button not found' };
    await sleep(4000);
    return { ok: true, reason: 'posted to Instagram (static image)' };
  } finally {
    if (remote) await adb.removeMedia(remote);
  }
}

/* ── Instagram Carousel Post ────────────────────────────────────────────────────
   Push all slides to device, open IG → + → POST tab, activate "Select Multiple"
   (the stacked-squares icon), tap each slide in order, then advance through the
   editor to caption → Share (or Save Draft).

   The "Select Multiple" icon is rendered on a SurfaceView on many Xiaomi builds
   so it won't appear in the a11y tree. We try the node first, then fall back to
   tapping by screen fraction (it lives at approximately 0.9, 0.37 in the gallery
   header row). After selecting all slides IG shows the slide count badge; we then
   tap Next to advance.

   All slide images are pushed BEFORE opening IG so they all land in DCIM/Camera
   before IG scans for new files. They must be selected in order (IG respects
   selection order for carousel slide ordering). */
export async function postCarousel(adb, { imagePaths, caption, id, draft = false }) {
  const remotes = [];
  try {
    if (!imagePaths?.length) return { ok: false, reason: 'no carousel slides provided' };

    // 1. Push all slides. Name them with a zero-padded index so gallery sort is
    // stable: socheli_carousel_<id>_00.jpg … _09.jpg. Push newest-last so IG
    // gallery shows them top-left first (most recent = first cell).
    for (let i = 0; i < imagePaths.length; i++) {
      const fname = `${id || 'socheli'}_carousel_${String(i).padStart(2, '0')}.jpg`;
      const remote = await adb.pushImage(imagePaths[i], fname);
      remotes.push(remote);
    }
    // Small settle time after all scans.
    await sleep(1500);

    // 2. Launch IG directly (not via share-intent; carousels aren't pre-loadable
    // via ACTION_SEND_MULTIPLE on all IG builds — the in-app multi-select flow is
    // the reliable path).
    await adb.launch(PKGS.instagram);
    await sleep(4000);

    if (!(await adb.foregroundApp()).includes(PKGS.instagram))
      return { ok: false, reason: 'Instagram did not come to foreground' };

    // 3. Open the create sheet (the + button in the bottom nav).
    const create = await adb.waitFor(
      [{ desc: 'New post' }, { desc: 'Create' }, { idEndsWith: 'creation_tab' }, { text: 'New post' }],
      { timeout: 5000 },
    );
    if (create) await adb.tapNode(create);
    else await adb.tapFrac(0.5, 0.97); // bottom-nav center + button
    await sleep(2500);

    // Dismiss "uninstall loses drafts" notice if it pops up.
    await adb.tapWhen([{ text: 'OK' }], { timeout: 2000 });

    // 4. Tap "Post" in the create-type sheet (Post | Story | Reel | Live).
    await adb.tapWhen(
      [{ text: 'Post' }, { desc: 'Post' }],
      { timeout: 5000 },
    );
    await sleep(2500);

    // 5. Activate "Select Multiple". The icon (stacked squares) is typically a
    // node with desc "Select Multiple" or an idEndsWith of "multi_select_button"
    // but on SurfaceView/Xiaomi builds it's invisible to the a11y tree. We probe
    // for the node first; if not found within 3 s we fall back to a fraction tap
    // in the gallery header area where the icon consistently lives.
    const multiNode = await adb.waitFor(
      [
        { desc: 'Select Multiple' },
        { text: 'SELECT MULTIPLE' },
        { idEndsWith: 'multi_select_button' },
        { idEndsWith: 'select_multiple' },
        { contains: 'select multiple' },
      ],
      { timeout: 3000 },
    );
    if (multiNode) {
      await adb.tapNode(multiNode);
    } else {
      // SurfaceView fallback: the multi-select icon is in the gallery picker header,
      // right side, roughly at (0.90, 0.37) of screen height.
      await adb.tapFrac(0.90, 0.37);
    }
    await sleep(1500);

    // 6. Select each slide in order. After activating multi-select, IG shows
    // numbered selection badges on each cell. Gallery cells are SurfaceView on
    // Xiaomi — we attempt node matching first, then fall back to grid-position
    // fraction taps. The grid is typically 3 columns; rows start at ~0.33 of
    // screen height, each row is ~0.13 screen-height tall, cells are ~0.33 wide.
    const { w, h } = await adb.size();
    const COLS = 3;
    const CELL_W = 1 / COLS;
    const GRID_TOP_FRAC = 0.37; // where the first row of cells starts
    const CELL_H_FRAC = 0.13;   // approx height fraction of one cell row

    for (let i = 0; i < imagePaths.length; i++) {
      // Try to find via a11y first — IG numbers the cells in description.
      // This rarely works on SurfaceView but is the safe path for AOSP.
      const cell = await adb.findAny([
        { idEndsWith: `gallery_image_${i}` },
        { desc: `Photo ${i + 1}` },
      ]);
      if (cell) {
        await adb.tapNode(cell);
      } else {
        // Grid-position fallback. Slides were pushed newest-last so their gallery
        // position (0-indexed, newest first) may be reversed. However since we
        // want them in push order and they are the most recently added files, they
        // occupy the first N cells of the gallery in reverse order of index
        // (i=0 is oldest of our batch → position N-1; i=last is newest → position 0).
        // Re-map: gallery position = (imagePaths.length - 1 - i).
        const galleryPos = imagePaths.length - 1 - i;
        const col = galleryPos % COLS;
        const row = Math.floor(galleryPos / COLS);
        const fx = (col + 0.5) * CELL_W;
        const fy = GRID_TOP_FRAC + (row + 0.5) * CELL_H_FRAC;
        await adb.tapFrac(fx, fy);
      }
      await sleep(700);
    }

    await sleep(1000);

    // 7. Tap Next to advance from gallery picker → photo editor.
    const next1 = await adb.waitFor(
      [
        { idEndsWith: 'next_button_textview' },
        { idEndsWith: 'creation_next_button' },
        { desc: 'Next' },
        { text: 'Next' },
      ],
      { timeout: 8000 },
    );
    if (!next1) return { ok: false, reason: 'could not find Next after selecting carousel slides' };
    await adb.tapNode(next1);
    await sleep(3500);

    // 8. Tap Next again to advance from crop/filter screen → share details.
    // (Some IG builds skip this screen for carousels; we probe and only tap if
    // the share screen hasn't appeared yet.)
    const onShare = () =>
      adb.findAny([
        { text: 'Share' },
        { text: 'Save Draft' },
        { idEndsWith: 'share_footer_button' },
      ]);
    if (!(await onShare())) {
      const next2 = await adb.waitFor(
        [
          { idEndsWith: 'next_button_textview' },
          { idEndsWith: 'creation_next_button' },
          { desc: 'Next' },
          { text: 'Next' },
        ],
        { timeout: 7000 },
      );
      if (next2) {
        await adb.tapNode(next2);
        await sleep(3500);
      }
    }

    // 9. Caption + post/draft.
    await typeCaption(adb, caption);

    if (draft) {
      const sd = await adb.waitFor(
        [{ text: 'Save Draft' }, { desc: 'Save Draft' }, { contains: 'save draft' }],
        { timeout: 9000 },
      );
      if (!(await adb.tapNode(sd))) return { ok: false, reason: 'Save Draft button not found' };
      await sleep(3000);
      return { ok: true, reason: `saved to Instagram drafts (carousel, ${imagePaths.length} slides)` };
    }

    const share = await adb.waitFor(
      [
        { idEndsWith: 'share_footer_button' },
        { idEndsWith: 'share_button' },
        { text: 'Share' },
        { desc: 'Share' },
      ],
      { timeout: 9000 },
    );
    if (!(await adb.tapNode(share)))
      return { ok: false, reason: 'Instagram Share button not found' };
    await sleep(4000);
    return { ok: true, reason: `posted to Instagram (carousel, ${imagePaths.length} slides)` };
  } finally {
    for (const remote of remotes) await adb.removeMedia(remote);
  }
}

export const POSTERS = {
  instagram: postInstagram,
  tiktok: postTikTok,
  youtube: postYouTube,
};
