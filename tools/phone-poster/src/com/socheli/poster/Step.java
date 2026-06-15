package com.socheli.poster;

/** One UI action in a post flow. Selectors are matched against the live node tree
 *  by the AccessibilityService. Kept declarative so flows are easy to tune as the
 *  apps' UIs drift (the brittle part of any on-device automation). */
public final class Step {
    public static final int WAIT = 0;
    public static final int CLICK_TEXT = 1;          // exact, case-insensitive
    public static final int CLICK_TEXT_CONTAINS = 2; // substring, case-insensitive
    public static final int CLICK_ID = 3;            // full view resource id
    public static final int CLICK_DESC = 4;          // content-description contains
    public static final int SET_CAPTION = 5;         // type the caption into an editable field

    public final int action;
    public final String arg;
    public final int ms;

    private Step(int action, String arg, int ms) { this.action = action; this.arg = arg; this.ms = ms; }

    public static Step wait(int ms) { return new Step(WAIT, null, ms); }
    public static Step clickText(String t) { return new Step(CLICK_TEXT, t, 0); }
    public static Step clickTextContains(String t) { return new Step(CLICK_TEXT_CONTAINS, t, 0); }
    public static Step clickId(String id) { return new Step(CLICK_ID, id, 0); }
    public static Step clickDesc(String d) { return new Step(CLICK_DESC, d, 0); }
    public static Step setCaption() { return new Step(SET_CAPTION, null, 0); }

    public String label() {
        switch (action) {
            case WAIT: return "wait " + ms + "ms";
            case CLICK_TEXT: return "click text=" + arg;
            case CLICK_TEXT_CONTAINS: return "click text~" + arg;
            case CLICK_ID: return "click id=" + arg;
            case CLICK_DESC: return "click desc~" + arg;
            case SET_CAPTION: return "set caption";
            default: return "?";
        }
    }
}
