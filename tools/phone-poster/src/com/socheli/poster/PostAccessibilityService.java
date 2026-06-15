package com.socheli.poster;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;

/** The on-device automation engine. While PosterService has armed an ActivePost,
 *  this walks the target app's create flow: it polls the live node tree every
 *  ~700ms, advances one Step at a time, and finishes (posted/failed) which
 *  releases the service. All matching is best-effort — the flows in PostFlows are
 *  where you tune selectors when an app update moves things. */
public final class PostAccessibilityService extends AccessibilityService {
    private static final long STALL_MS = 45_000;     // no progress this long → give up
    private static final long TICK_MS = 700;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean scheduled = false;

    private final Runnable ticker = new Runnable() {
        @Override public void run() {
            scheduled = false;
            tick();
            if (ActivePost.current != null) scheduleTick();
        }
    };

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (ActivePost.current != null) scheduleTick();
    }

    @Override public void onInterrupt() {}

    private void scheduleTick() {
        if (scheduled) return;
        scheduled = true;
        handler.postDelayed(ticker, TICK_MS);
    }

    private void tick() {
        ActivePost ap = ActivePost.current;
        if (ap == null) return;

        if (System.currentTimeMillis() - ap.lastProgressAt > STALL_MS) {
            String at = ap.index < ap.steps.size() ? ap.steps.get(ap.index).label() : "end";
            ap.finish("failed", "ui stalled at step " + ap.index + " (" + at + ")");
            return;
        }
        if (ap.index >= ap.steps.size()) { ap.finish("posted", "ran " + ap.steps.size() + " steps"); return; }

        Step st = ap.steps.get(ap.index);
        if (st.action == Step.WAIT) {
            if (System.currentTimeMillis() - ap.stepStartedAt >= st.ms) ap.advance();
            return;
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;

        boolean ok = false;
        switch (st.action) {
            case Step.CLICK_TEXT:          ok = clickNode(findByText(root, st.arg, false)); break;
            case Step.CLICK_TEXT_CONTAINS: ok = clickNode(findByText(root, st.arg, true));  break;
            case Step.CLICK_ID:            ok = clickNode(findById(root, st.arg));           break;
            case Step.CLICK_DESC:          ok = clickNode(findByDesc(root, st.arg));         break;
            case Step.SET_CAPTION:         ok = setCaption(root, ap.caption);                break;
        }
        if (ok) ap.advance();
    }

    // ── node search ──────────────────────────────────────────────────────────
    private AccessibilityNodeInfo findById(AccessibilityNodeInfo root, String id) {
        List<AccessibilityNodeInfo> r = root.findAccessibilityNodeInfosByViewId(id);
        return r != null && !r.isEmpty() ? r.get(0) : null;
    }

    private AccessibilityNodeInfo findByText(AccessibilityNodeInfo root, String text, boolean contains) {
        // findAccessibilityNodeInfosByText is substring + case-insensitive over text & desc
        List<AccessibilityNodeInfo> r = root.findAccessibilityNodeInfosByText(text);
        if (r != null) for (AccessibilityNodeInfo n : r) {
            if (n == null) continue;
            CharSequence t = n.getText();
            if (contains) return n;
            if (t != null && t.toString().equalsIgnoreCase(text)) return n;
        }
        // recursive fallback (some nodes aren't indexed by the above)
        return recurse(root, n -> {
            CharSequence t = n.getText(); CharSequence d = n.getContentDescription();
            String s = (t != null ? t : (d != null ? d : "")).toString();
            return contains ? s.toLowerCase().contains(text.toLowerCase()) : s.equalsIgnoreCase(text);
        });
    }

    private AccessibilityNodeInfo findByDesc(AccessibilityNodeInfo root, String desc) {
        return recurse(root, n -> {
            CharSequence d = n.getContentDescription();
            return d != null && d.toString().toLowerCase().contains(desc.toLowerCase());
        });
    }

    private AccessibilityNodeInfo findEditable(AccessibilityNodeInfo root) {
        return recurse(root, n -> {
            if (n.isEditable()) return true;
            CharSequence cn = n.getClassName();
            return cn != null && cn.toString().contains("EditText");
        });
    }

    private interface Match { boolean ok(AccessibilityNodeInfo n); }
    private AccessibilityNodeInfo recurse(AccessibilityNodeInfo n, Match m) {
        if (n == null) return null;
        if (m.ok(n)) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo found = recurse(n.getChild(i), m);
            if (found != null) return found;
        }
        return null;
    }

    // ── actions ────────────────────────────────────────────────────────────--
    private boolean clickNode(AccessibilityNodeInfo n) {
        if (n == null) return false;
        AccessibilityNodeInfo c = n;
        int depth = 0;
        while (c != null && !c.isClickable() && depth < 7) { c = c.getParent(); depth++; }
        if (c == null) c = n;
        return c.performAction(AccessibilityNodeInfo.ACTION_CLICK);
    }

    private boolean setCaption(AccessibilityNodeInfo root, String text) {
        AccessibilityNodeInfo edit = findEditable(root);
        if (edit == null || TextUtils.isEmpty(text)) return edit != null; // nothing to type still counts as "found"
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    // ── is this service enabled in system settings? ──────────────────────────
    public static boolean isEnabled(Context c) {
        String flat = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (flat == null) return false;
        String want = c.getPackageName() + "/" + PostAccessibilityService.class.getName();
        String wantShort = c.getPackageName() + "/.PostAccessibilityService";
        return flat.contains(want) || flat.contains(wantShort);
    }
}
