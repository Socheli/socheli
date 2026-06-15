package com.socheli.poster;

import java.util.List;
import java.util.concurrent.CountDownLatch;

/** Hand-off between PosterService (which downloads + launches the app) and
 *  PostAccessibilityService (which drives the UI). The service arms `current`,
 *  the accessibility service advances `index` through `steps`, then calls
 *  finish(), which releases the latch the service is blocked on. */
public final class ActivePost {
    public static volatile ActivePost current;

    public final String platform;
    public final String caption;
    public final String targetPackage;
    public final List<Step> steps;

    public volatile int index = 0;
    public volatile long stepStartedAt = System.currentTimeMillis();
    public volatile long lastProgressAt = System.currentTimeMillis();
    public volatile String status;   // "posted" | "failed"
    public volatile String message = "";
    public final CountDownLatch latch = new CountDownLatch(1);

    public ActivePost(String platform, String caption, String pkg, List<Step> steps) {
        this.platform = platform; this.caption = caption; this.targetPackage = pkg; this.steps = steps;
    }

    public void advance() {
        index++;
        stepStartedAt = System.currentTimeMillis();
        lastProgressAt = stepStartedAt;
    }

    public void finish(String status, String message) {
        this.status = status;
        this.message = message == null ? "" : message;
        current = null;
        latch.countDown();
    }
}
