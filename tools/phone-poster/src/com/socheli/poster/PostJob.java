package com.socheli.poster;

import org.json.JSONObject;

/** One unit of work pulled from the server: post this video to this platform. */
public final class PostJob {
    public final String id;          // Socheli run id (for result reporting)
    public final String platform;    // instagram | tiktok | youtube
    public final String caption;     // full caption text (incl. hashtags as resolved upstream)
    public final String title;       // optional (YouTube)
    public final String firstComment; // optional
    public final String mediaUrl;    // public https url to the rendered mp4

    public PostJob(String id, String platform, String caption, String title, String firstComment, String mediaUrl) {
        this.id = id; this.platform = platform; this.caption = caption;
        this.title = title; this.firstComment = firstComment; this.mediaUrl = mediaUrl;
    }

    public static PostJob from(JSONObject o) {
        return new PostJob(
            o.optString("id"),
            o.optString("platform"),
            o.optString("caption"),
            o.optString("title", ""),
            o.optString("firstComment", ""),
            o.optString("mediaUrl"));
    }

    public boolean valid() {
        return id != null && !id.isEmpty()
            && platform != null && !platform.isEmpty()
            && mediaUrl != null && mediaUrl.startsWith("http");
    }
}
