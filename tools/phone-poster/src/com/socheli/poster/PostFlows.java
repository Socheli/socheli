package com.socheli.poster;

import java.util.ArrayList;
import java.util.List;

/** Per-platform package + create-flow step lists. Best-effort, English UI; these
 *  are the first thing to tune when an app update moves a button. The video is
 *  already handed to the app via an ACTION_SEND share intent before the flow runs,
 *  so these steps only cover "land in the composer → caption → post". */
public final class PostFlows {

    public static String packageFor(String platform) {
        switch (platform) {
            case "instagram": return "com.instagram.android";
            case "tiktok":    return "com.zhiliaoapp.musically"; // intl build; CN/alt = com.ss.android.ugc.trill
            case "youtube":   return "com.google.android.youtube";
            default:          return null;
        }
    }

    public static List<Step> flowFor(String platform) {
        List<Step> s = new ArrayList<>();
        switch (platform) {
            case "instagram":
                s.add(Step.wait(2800));
                s.add(Step.clickTextContains("Reel"));   // pick Reel if the share target offers a choice
                s.add(Step.wait(1500));
                s.add(Step.clickTextContains("Next"));
                s.add(Step.wait(1500));
                s.add(Step.clickTextContains("Next"));
                s.add(Step.wait(1500));
                s.add(Step.setCaption());
                s.add(Step.wait(900));
                s.add(Step.clickTextContains("Share"));
                break;
            case "tiktok":
                s.add(Step.wait(2800));
                s.add(Step.clickTextContains("Next"));
                s.add(Step.wait(1500));
                s.add(Step.setCaption());
                s.add(Step.wait(900));
                s.add(Step.clickTextContains("Post"));
                break;
            case "youtube":
                s.add(Step.wait(2800));
                s.add(Step.clickTextContains("Short"));
                s.add(Step.wait(1500));
                s.add(Step.clickTextContains("Next"));
                s.add(Step.wait(1500));
                s.add(Step.setCaption());
                s.add(Step.wait(900));
                s.add(Step.clickTextContains("Upload"));
                break;
        }
        return s;
    }
}
