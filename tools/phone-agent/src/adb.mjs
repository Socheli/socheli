import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

const execFileAsync = promisify(execFile);

// Allow an explicit adb path (e.g. for launchd, where PATH is minimal and the
// SDK may live on an external volume). Falls back to PATH lookup.
const ADB_BIN = process.env.ADB_BIN || 'adb';

/**
 * Thin, device-scoped wrapper around ADB. Everything that touches the phone goes
 * through here so the higher layers stay readable. No shell strings are built
 * from untrusted input except the deep links, which are URL-encoded and
 * single-quoted for the device shell (see openUrl / shareVideoTo).
 */
export class Adb {
  constructor(serial) {
    this.serial = serial;
  }

  async raw(args, opts = {}) {
    const full = this.serial ? ['-s', this.serial, ...args] : args;
    const { stdout } = await execFileAsync(ADB_BIN, full, {
      maxBuffer: 1024 * 1024 * 16,
      ...opts,
    });
    return stdout;
  }

  /** A shell command run as a single string on the device (for quoting control). */
  async shell(cmdString) {
    return this.raw(['shell', cmdString]);
  }

  static async listDevices() {
    const { stdout } = await execFileAsync(ADB_BIN, ['devices']);
    return stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('*'))
      .map((l) => {
        const [serial, state] = l.split(/\s+/);
        return { serial, state };
      });
  }

  async prop(name) {
    return (await this.shell(`getprop ${name}`)).trim();
  }

  async isAwake() {
    const out = await this.shell('dumpsys power | grep "mWakefulness="');
    return /mWakefulness=Awake/.test(out);
  }

  /** True when the secure keyguard is up (we can wake the screen but not unlock). */
  async isLocked() {
    const out = await this.shell(
      'dumpsys window 2>/dev/null | grep -iE "mDreamingLockscreen|keyguardShowing" || true',
    );
    if (/mDreamingLockscreen=true/.test(out)) return true;
    const kg = await this.shell(
      'dumpsys trust 2>/dev/null | grep -iE "deviceLocked|trusted" || true',
    );
    return /deviceLocked=1|deviceLocked=true/.test(kg);
  }

  async wake() {
    await this.shell('input keyevent KEYCODE_WAKEUP');
  }

  /** Turn the screen off (re-locks if a secure lock with immediate timeout). */
  async lockScreen() {
    await this.shell('input keyevent KEYCODE_SLEEP');
  }

  /**
   * Wake and dismiss the keyguard with a numeric PIN. Swipe up to reveal the PIN
   * pad, send the digits as keyevents (more reliable on the lockscreen than
   * `input text`), then Enter. PIN is never logged. Returns true if unlocked.
   */
  async unlock(pin) {
    await this.wake();
    await sleep(700);
    if (!(await this.isLocked())) return true;
    await this.shell('input swipe 540 1900 540 700 180'); // reveal PIN pad
    await sleep(900);
    const keys = String(pin)
      .split('')
      .map((d) => `KEYCODE_${d}`)
      .join(' ');
    await this.shell(`input keyevent ${keys}`);
    await sleep(600);
    await this.shell('input keyevent KEYCODE_ENTER');
    await sleep(1500);
    return !(await this.isLocked());
  }

  async foregroundApp() {
    const out = await this.shell(
      'dumpsys window 2>/dev/null | grep -i mCurrentFocus | head -1',
    );
    return out.trim();
  }

  async hasPackage(pkg) {
    const out = await this.shell(`pm list packages ${pkg}`);
    return out.includes(`package:${pkg}`);
  }

  async tap(x, y) {
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async key(code) {
    await this.shell(`input keyevent ${code}`);
  }

  /** Open a URL/deep link via VIEW intent. URL is single-quoted for the device shell. */
  async openUrl(url, pkg) {
    const safe = url.replace(/'/g, '%27');
    const p = pkg ? `-p ${pkg} ` : '';
    await this.shell(`am start ${p}-a android.intent.action.VIEW -d '${safe}'`);
  }

  // ── media: push a rendered video to the phone so an app can pick it ──────────

  /**
   * Push a local video onto the device gallery and make it visible to apps.
   * We drop it into DCIM/Camera (apps surface the newest item there first) and
   * trigger a single-file media scan so it shows up immediately. Returns the
   * on-device absolute path. `MEDIA_DIR` overrides the destination directory.
   */
  async pushMedia(localPath, name) {
    const dir = (process.env.MEDIA_DIR || '/sdcard/DCIM/Camera').replace(/\/+$/, '');
    const fname = (name || basename(localPath)).replace(/[^A-Za-z0-9._-]/g, '_');
    const remote = `${dir}/${fname}`;
    await this.shell(`mkdir -p '${dir}'`);
    await this.raw(['push', localPath, remote]);
    await this.scanMedia(remote);
    return remote;
  }

  /** Ask MediaStore to index a freshly-pushed file (so it appears in pickers). */
  async scanMedia(remotePath) {
    await this.shell(
      `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file://${remotePath}' >/dev/null 2>&1 || true`,
    );
    await sleep(1200);
  }

  /** Remove a pushed file after posting, and re-scan so the gallery forgets it. */
  async removeMedia(remotePath) {
    if (!remotePath) return;
    await this.shell(`rm -f '${remotePath}' >/dev/null 2>&1 || true`);
    await this.scanMedia(remotePath);
  }

  /**
   * Resolve the MediaStore content:// URI for a pushed file. Apps that accept a
   * shared video (ACTION_SEND) need a content URI, not a file path, on modern
   * Android. Returns e.g. content://media/external/video/media/1234, or null.
   */
  async contentUriFor(remotePath) {
    // Match by _display_name (the filename), NOT _data: MediaStore canonicalises
    // /sdcard → /storage/emulated/0, so a _data path match silently misses. The
    // filename is sanitised by pushMedia, so it's safe to interpolate.
    const name = remotePath.split("/").pop();
    const out = await this.shell(
      `content query --uri content://media/external/video/media ` +
        `--projection _id --where "_display_name='${name}'" --sort "_id DESC" 2>/dev/null || true`,
    );
    const m = out.match(/_id=(\d+)/);
    return m ? `content://media/external/video/media/${m[1]}` : null;
  }

  /**
   * Resolve the MediaStore content:// URI for a pushed IMAGE file. Queries the
   * images table (not video). Returns e.g. content://media/external/images/media/1234,
   * or null.
   */
  async imageContentUriFor(remotePath) {
    const name = remotePath.split("/").pop();
    const out = await this.shell(
      `content query --uri content://media/external/images/media ` +
        `--projection _id --where "_display_name='${name}'" --sort "_id DESC" 2>/dev/null || true`,
    );
    const m = out.match(/_id=(\d+)/);
    return m ? `content://media/external/images/media/${m[1]}` : null;
  }

  /**
   * Push a local image (PNG/JPG) to the device gallery and scan it into MediaStore.
   * Uses DCIM/Camera by default (same as pushMedia). Returns the on-device absolute
   * path. The name is preserved with its original extension so MediaStore classifies
   * it as an image, not a video.
   */
  async pushImage(localPath, name) {
    const dir = (process.env.MEDIA_DIR || '/sdcard/DCIM/Camera').replace(/\/+$/, '');
    const fname = (name || localPath.split('/').pop()).replace(/[^A-Za-z0-9._-]/g, '_');
    const remote = `${dir}/${fname}`;
    await this.shell(`mkdir -p '${dir}'`);
    await this.raw(['push', localPath, remote]);
    await this.scanMedia(remote);
    return remote;
  }

  /**
   * Share an image (or multiple images) to an app via ACTION_SEND (single) or
   * ACTION_SEND_MULTIPLE (array). Each URI must be an images/media content URI.
   * Returns true if the intent was dispatched.
   */
  async shareImageTo({ contentUri, contentUris, pkg, targetActivity, mimeType = 'image/jpeg' }) {
    if (!contentUri && !contentUris?.length) return false;
    const target = targetActivity
      ? `-n ${targetActivity}`
      : pkg
        ? `-p ${pkg}`
        : '';
    if (contentUris && contentUris.length > 1) {
      // ACTION_SEND_MULTIPLE — pass as --eia (string array extra)
      const uriList = contentUris.map((u) => `'${u}'`).join(' ');
      // am start doesn't support arbitrary string-array extras directly; use a
      // clipboard-URI trick: pass the URIs individually via --eu with indexed keys,
      // then the app reads EXTRA_STREAM (array). Most launchers support this.
      // The reliable cross-version approach is to write a small shell script that
      // calls am with --eia for the URI list.
      const urisArg = contentUris.map((u, i) => `--eu "android.intent.extra.STREAM_${i}" '${u}'`).join(' ');
      // Use EXTRA_ALLOW_MULTIPLE + EXTRA_STREAM array intent via content URI list
      // encoded as newline-separated in a tmp file, launched via a chooser-bypass.
      // The simplest reliable path on AOSP/MIUI: pass the first URI and rely on
      // the IG in-app multi-select flow (which is what postCarousel does).
      // This helper still dispatches with the primary URI for the share preview.
      await this.shell(
        `am start -a android.intent.action.SEND -t '${mimeType}' ` +
          `--eu android.intent.extra.STREAM '${contentUris[0]}' ` +
          `-f 0x00000001 ${target}`,
      );
    } else {
      const uri = contentUri || contentUris[0];
      await this.shell(
        `am start -a android.intent.action.SEND -t '${mimeType}' ` +
          `--eu android.intent.extra.STREAM '${uri}' ` +
          `-f 0x00000001 ${target}`,
      );
    }
    return true;
  }

  /**
   * Open an app's share/compose sheet with a video preloaded via ACTION_SEND.
   * Grants the target read permission on the content URI. `targetActivity` (a
   * fully-qualified component) lands directly in the app's share handler when
   * known; otherwise the system chooser shows and the UI layer picks the app.
   * Returns true if the intent was dispatched.
   */
  async shareVideoTo({ contentUri, pkg, targetActivity }) {
    if (!contentUri) return false;
    const target = targetActivity
      ? `-n ${targetActivity}`
      : pkg
        ? `-p ${pkg}`
        : '';
    await this.shell(
      `am start -a android.intent.action.SEND -t video/mp4 ` +
        `--eu android.intent.extra.STREAM '${contentUri}' ` +
        `-f 0x00000001 ${target}`, // FLAG_GRANT_READ_URI_PERMISSION
    );
    return true;
  }

  /** Launch an app cold by package (forced, avoids MIUI's app-chooser). */
  async launch(pkg) {
    await this.shell(
      `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true`,
    );
  }

  /** Dump the on-screen UI tree as XML. */
  async uiDump() {
    await this.shell('uiautomator dump /sdcard/window_dump.xml >/dev/null 2>&1');
    return this.raw(['exec-out', 'cat', '/sdcard/window_dump.xml'], {
      encoding: 'utf8',
    });
  }

  /** Parse the UI dump into a flat list of nodes with attributes + center. */
  static parseNodes(xml) {
    const out = [];
    for (const tag of xml.match(/<node\b[^>]*>/g) ?? []) {
      const a = (name) => {
        const m = tag.match(new RegExp(`${name}="([^"]*)"`));
        return m ? m[1] : '';
      };
      const b = a('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      out.push({
        resourceId: a('resource-id'),
        text: a('text'),
        desc: a('content-desc'),
        cls: a('class'),
        clickable: a('clickable') === 'true',
        bounds: b ? [+b[1], +b[2], +b[3], +b[4]] : null,
        cx: b ? (+b[1] + +b[3]) / 2 : 0,
        cy: b ? (+b[2] + +b[4]) / 2 : 0,
      });
    }
    return out;
  }

  /**
   * Find the first node matching a spec, or null.
   * spec: { idEndsWith?, text?, desc?, contains?, cls?, clickable? }
   */
  async find(spec) {
    const nodes = Adb.parseNodes(await this.uiDump());
    return Adb.match(nodes, spec);
  }

  static match(nodes, spec) {
    const lc = (s) => (s || '').toLowerCase();
    return (
      nodes.find((n) => {
        if (!n.bounds) return false;
        // Skip zero-dimension nodes (label children inside a composite button)
        if (n.bounds[0] === 0 && n.bounds[1] === 0 && n.bounds[2] === 0 && n.bounds[3] === 0) return false;
        if (spec.idEndsWith && !n.resourceId.endsWith(spec.idEndsWith)) return false;
        if (spec.text && n.text !== spec.text) return false;
        if (spec.desc && n.desc !== spec.desc) return false;
        if (spec.cls && !n.cls.endsWith(spec.cls)) return false;
        if (spec.clickable && !n.clickable) return false;
        if (spec.contains) {
          const hay = lc(`${n.resourceId} ${n.text} ${n.desc}`);
          if (!hay.includes(lc(spec.contains))) return false;
        }
        return true;
      }) ?? null
    );
  }

  /** Find the first node matching ANY of the given specs (in order). */
  async findAny(specs) {
    const nodes = Adb.parseNodes(await this.uiDump());
    for (const spec of specs) {
      const n = Adb.match(nodes, spec);
      if (n) return n;
    }
    return null;
  }

  /**
   * Poll for a node until it appears or we time out. Re-dumps each round, so it
   * rides out transcode spinners and slow screen transitions. Returns the node
   * or null.
   */
  async waitFor(specs, { timeout = 12000, interval = 800 } = {}) {
    const list = Array.isArray(specs) ? specs : [specs];
    const deadline = Date.now() + timeout;
    do {
      const n = await this.findAny(list);
      if (n) return n;
      await sleep(interval);
    } while (Date.now() < deadline);
    return null;
  }

  /** Tap a found node (or null → false). */
  async tapNode(node) {
    if (!node) return false;
    await this.tap(node.cx, node.cy);
    return true;
  }

  /** Find by spec(s) and tap; returns true on a hit. */
  async tapWhen(specs, waitOpts) {
    const n = await this.waitFor(specs, waitOpts);
    return this.tapNode(n);
  }

  /** Type into the focused field. Spaces → %s. The text is wrapped in double
   *  quotes in the device command, so only the chars that stay special INSIDE
   *  double quotes need escaping (" \ $ `). Crucially this leaves apostrophes
   *  and '#' untouched, so "you're" types as "you're" (not "you\'re") and
   *  "#tag" survives (a bare '#' would otherwise start a device-shell comment).
   *  ASCII-reliable; for emoji/unicode install ADBKeyboard. */
  async type(text) {
    const escaped = String(text)
      .replace(/\n/g, ' ')
      .replace(/(["\\$`])/g, '\\$1')
      .replace(/ /g, '%s');
    await this.shell(`input text "${escaped}"`);
  }

  /** Screen size in px, e.g. {w:1080,h:2400}. Used for fraction-based taps on
   *  custom views (SurfaceView/Compose) that don't appear in the a11y tree. */
  async size() {
    const out = await this.shell('wm size');
    const m = out.match(/Override size:\s*(\d+)x(\d+)/) || out.match(/Physical size:\s*(\d+)x(\d+)/);
    return m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 2400 };
  }

  /** Tap at a fraction of the screen (0..1), for custom views with no node. */
  async tapFrac(fx, fy) {
    const { w, h } = await this.size();
    await this.tap(w * fx, h * fy);
  }

  /** Back-compat: center of a node by exact resource-id. */
  async findNodeCenter(resourceId) {
    const n = await this.find({ contains: resourceId });
    return n ? { x: n.cx, y: n.cy } : null;
  }

  async screencapTo(localPath) {
    const out = await this.raw(['exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(localPath, out);
    return localPath;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
